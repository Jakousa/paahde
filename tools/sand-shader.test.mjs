import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { Vector2, Vector3 } from 'three/src/Three.Core.js';
import WGSLNodeBuilder from 'three/src/renderers/webgpu/nodes/WGSLNodeBuilder.js';
import * as tsl from 'three/src/nodes/tsl/TSLBase.js';

// Compile the actual material helpers without importing the browser's graphics/settings modules.
// The builder and TSL must both come from Three's source modules: mixing them with its bundled
// three/tsl entry point gives two different active shader stacks.
const material = readFileSync(new URL('../src/world/sandMaterial.ts', import.meta.url), 'utf8');
const start = material.indexOf('function rippleProfile(');
const end = material.indexOf('/** Fade for a periodic pattern', start);
assert.ok(start >= 0 && end > start, 'the material ripple helpers must be found');
const helpers = stripTypeScriptTypes(material.slice(start, end));

function compileRipples(makeOutput) {
  const sand = {
    detail: tsl.uniform(0),
    rippleHeight: tsl.uniform(0.006),
    rippleStrength: tsl.uniform(0.13),
    contrast: tsl.uniform(1.6),
    offset: tsl.uniform(0.2),
    farRippleShade: tsl.uniform(0.5),
  };
  const imports = { ...tsl, sand, PI: Math.PI };
  const functions = new Function(...Object.keys(imports),
    `${helpers}\nreturn { rippleSun, rippleMeanDiffuse };`)(...Object.values(imports));
  const surface = {
    rippleDir: tsl.uniform(new Vector2(0.8, 0.6)),
    n0: tsl.uniform(new Vector3(0, 1, 0)),
    nBase: tsl.uniform(new Vector3(0, 1, 0)),
    rippleAmp: tsl.uniform(1),
    ripplePhase: tsl.uniform(0.4),
    rippleRes: tsl.uniform(0.5),
    rippleField: tsl.uniform(1),
  };
  // Keep the incoming direction a shared expression, as in SandLightingModel.direct().
  const light = tsl.normalize(tsl.uniform(new Vector3(1, 0.2, 0)));
  const output = tsl.Fn(() => makeOutput(functions, surface, light))();
  const builder = new WGSLNodeBuilder(null, {
    backend: { isWebGPUBackend: true },
    debug: { diagnostics: { keywords: false } },
  });
  builder.setShaderStage('fragment');
  return builder.flowStagesNode(output, 'float');
}

/** Check definite assignment, rather than shader variable names or an expected source snapshot.
 * Three declares WGSL temporaries at function scope. A temporary assigned only in one branch is
 * zero on other paths; the shader compiles, but that zero can turn an entire ripple field dark.
 * At every branch merge only assignments made on BOTH paths are safe to read afterwards. */
function assertInitialized(flow) {
  const variables = new Set([...flow.vars.matchAll(/\bvar\s+(\w+)\s*:/g)].map(match => match[1]));
  const lines = flow.code.split('\n').map(line => line.trim()).filter(Boolean);
  let cursor = 0;
  function reads(expression, assigned) {
    for (const name of expression.match(/\b\w+\b/g) ?? []) {
      assert.ok(!variables.has(name) || assigned.has(name),
        `${name} is read before assignment on some shader paths at line ${cursor}: ${expression}`);
    }
  }
  function block(incoming) {
    let assigned = new Set(incoming);
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line === '}' || line === '} else {') return assigned;
      cursor++;
      if (line.startsWith('if (') && line.endsWith('{')) {
        reads(line, assigned);
        const thenAssigned = block(assigned);
        assert.ok(cursor < lines.length, 'if block must close');
        let elseAssigned = assigned;
        if (lines[cursor] === '} else {') {
          cursor++;
          elseAssigned = block(assigned);
        }
        assert.equal(lines[cursor++], '}', 'if/else block must close');
        assigned = new Set([...thenAssigned].filter(name => elseAssigned.has(name)));
      } else {
        const assignment = /^(\w+)\s*(=|\+=|-=|\*=|\/=)\s*(.+);$/.exec(line);
        assert.ok(assignment, `unsupported shader statement (extend the checker): ${line}`);
        const [, name, operator, value] = assignment;
        assert.ok(variables.has(name), `assignment must target a declared temporary: ${name}`);
        reads(value, assigned);
        if (operator !== '=') reads(name, assigned);
        assigned.add(name);
      }
    }
    return assigned;
  }
  const assigned = block(new Set());
  assert.equal(cursor, lines.length, 'all shader statements must be checked');
  reads(flow.result, assigned);
}

for (const name of ['rippleSun', 'rippleMeanDiffuse']) {
  test(`${name} initializes shader temporaries on every detail-tier path`, () => {
    assertInitialized(compileRipples((functions, surface, light) => functions[name](surface, light)));
  });
}

test('ripple sunlight and diffuse can share inputs and use them after tier branches', () => {
  assertInitialized(compileRipples(({ rippleSun, rippleMeanDiffuse }, surface, light) =>
    tsl.mix(rippleSun(surface, light), rippleMeanDiffuse(surface, light), surface.rippleRes)
      .mul(tsl.dot(light, surface.nBase))));
});

test('shader checker rejects a value initialized only in another branch', () => {
  assert.throws(() => assertInitialized({
    vars: 'var result : f32;\nvar shared : f32;',
    code: 'result = 0.0;\nif ( detail > 0 ) {\nshared = 1.0;\nresult = shared;\n} else {\nresult = shared;\n}',
    result: 'result',
  }), /shared is read before assignment/);
});
