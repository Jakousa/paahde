// Heat haze over the main menu's title (src/landing.ts): the title shimmers as if seen through hot air. The haze is
// fixed to the page, not to the title: a still WebGL canvas over the whole page draws the title (rendered once into a
// texture, with its glow) wherever the title element is now, bent by noise taken at each pixel's place on the page,
// so when the title moves (stage(), src/landing.ts) it moves through the heat. The texture is sampled smoothly, so the
// bent edges stay anti-aliased. The title element itself stays for the layout and its moves, unseen. Without WebGL, or
// with reduced motion, the plain title shows.

/** How far the heat bends the title (px, across and up), its grain (per px, across and up) and how fast the air
 *  rises (noise units per second: slow). */
const BEND = [7, 4];
const GRAIN = [0.011, 0.032];
const RISE = 0.22;
/** Room round the title's box in the texture, for its glow (px). */
const PAD = 52;
/** The title's glow, as its CSS text-shadow (src/landing.ts): offset y, blur, colour. */
const GLOW: [number, number, string][] = [
  [0, 40, 'rgba(255, 179, 71, .45)'],
  [0, 12, 'rgba(140, 50, 10, .5)'],
  [2, 3, 'rgba(60, 20, 5, .45)'],
];

const VERT = `attribute vec2 at; uniform vec2 view; varying vec2 px;
void main() { px = at; gl_Position = vec4(at.x / view.x * 2.0 - 1.0, 1.0 - at.y / view.y * 2.0, 0.0, 1.0); }`;
const FRAG = `precision highp float;
uniform sampler2D tex; uniform vec4 box; uniform float t, alpha; uniform vec2 bend, grain;
varying vec2 px;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
void main() {
  // Noise by the place on the page (not on the title), rising: a broad swell and a finer, quicker shimmer on it.
  vec2 q = px * grain + vec2(0.0, t * ${RISE.toFixed(3)});
  vec2 r = px * grain * 2.3 + vec2(t * 0.04, t * ${(RISE * 1.7).toFixed(3)});
  vec2 d = vec2(noise(q) + 0.5 * noise(r), noise(q + 17.3) + 0.5 * noise(r + 9.1)) - 0.75;
  vec2 uv = (px + d * bend - box.xy) / box.zw;
  vec4 c = texture2D(tex, uv);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) c = vec4(0.0);
  gl_FragColor = c * alpha;
}`;

/** Draw `title` (inside `page`) through the haze; it stops by itself when the page goes. */
export function haze(page: HTMLElement, title: HTMLElement) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'haze';
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false });
  if (!gl) return;
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
  gl.useProgram(prog);
  const u = (n: string) => gl.getUniformLocation(prog, n);
  const [uView, uBox, uT, uAlpha, uBend, uGrain] = ['view', 'box', 't', 'alpha', 'bend', 'grain'].map(u);
  gl.uniform2f(uBend, BEND[0], BEND[1]);
  gl.uniform2f(uGrain, GRAIN[0], GRAIN[1]);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  const at = gl.getAttribLocation(prog, 'at');
  gl.enableVertexAttribArray(at);
  gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);

  // The title, drawn once (again when its size changes) into the texture, at the screen's resolution.
  let drawn = '';
  const paint = () => {
    const w = title.offsetWidth;
    const h = title.offsetHeight;
    const dpr = devicePixelRatio || 1;
    const key = `${w}:${h}:${dpr}`;
    if (key === drawn || !w) return;
    drawn = key;
    const cs = getComputedStyle(title);
    const c = document.createElement('canvas');
    c.width = Math.ceil((w + 2 * PAD) * dpr);
    c.height = Math.ceil((h + 2 * PAD) * dpr);
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    g.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    (g as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = cs.letterSpacing;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = cs.color;
    // Centred as the page centres it (its left padding evens out the spacing after the last letter).
    const x = PAD + w / 2 + parseFloat(cs.letterSpacing || '0') / 2;
    const y = PAD + h / 2;
    for (const [oy, blur, color] of GLOW) {
      g.shadowColor = color;
      g.shadowBlur = blur * dpr;
      g.shadowOffsetY = oy * dpr;
      g.fillText(title.textContent ?? '', x, y);
    }
    g.shadowColor = 'transparent';
    g.fillText(title.textContent ?? '', x, y);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  };

  const t0 = performance.now();
  const frame = (now: number) => {
    if (!page.isConnected) return void gl.getExtension('WEBGL_lose_context')?.loseContext();
    requestAnimationFrame(frame);
    const dpr = devicePixelRatio || 1;
    const vw = canvas.clientWidth;
    const vh = canvas.clientHeight;
    if (canvas.width !== Math.round(vw * dpr) || canvas.height !== Math.round(vh * dpr)) {
      canvas.width = Math.round(vw * dpr);
      canvas.height = Math.round(vh * dpr);
    }
    paint();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // Where the title is now (mid-move too), in the canvas's space: the texture's box, and a quad a bend wider.
    const cr = canvas.getBoundingClientRect();
    const r = title.getBoundingClientRect();
    const bx = r.left - cr.left - PAD;
    const by = r.top - cr.top - PAD;
    const bw = r.width + 2 * PAD;
    const bh = r.height + 2 * PAD;
    const m = Math.max(BEND[0], BEND[1]);
    const [x0, y0, x1, y1] = [bx - m, by - m, bx + bw + m, by + bh + m];
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([x0, y0, x1, y0, x0, y1, x0, y1, x1, y0, x1, y1]), gl.DYNAMIC_DRAW);
    gl.uniform2f(uView, vw, vh);
    gl.uniform4f(uBox, bx, by, bw, bh);
    gl.uniform1f(uT, (now - t0) / 1000);
    gl.uniform1f(uAlpha, parseFloat(getComputedStyle(title).opacity));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  // Its font must be in before it's drawn; then the canvas takes over from the title.
  document.fonts.ready.then(() => {
    if (!page.isConnected) return;
    title.before(canvas);
    title.style.visibility = 'hidden';
    requestAnimationFrame(frame);
  });
}
