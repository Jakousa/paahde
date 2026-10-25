import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim } from './econsim/sim.ts';
import { summaryMd } from './econsim/stats.ts';
import { frameScrap, stepList } from '../shared/machineSteps.ts';
import { SCRAP_REWARD } from '../shared/tables.ts';

function finalReceiverFixture() {
  const sim = new Sim('sim0000', 0);
  sim.chest = [
    { id: 100, kind: 'workbench', n: 1 }, { id: 101, kind: 'dismantle_bench', n: 1 },
    { id: 102, kind: 'receiver_colossus', n: 1, parts: ['uranium_basic', 'servo_heart', 'relay_basic'] },
    { id: 103, kind: 'receiver_worm', n: 1, parts: ['uranium_basic', 'hive_core', 'queen_eye', null] },
  ];
  sim.bag.fill(null);
  sim.bag[0] = { id: 104, kind: 'laser_rifle', n: 1, parts: ['wiring', 'battery_quality', 'heatsink_quality', 'scrap'] };
  sim.beaten = new Set(['carrier', 'queen']);
  sim.go = () => {};
  sim.odds = () => ({ win: 1, death: 0, seconds: 900 });
  sim.fightRand = () => 0;
  return sim;
}

test('the third relic unlocks and calls the final receiver before another expedition', () => {
  const sim = finalReceiverFixture();
  sim.home();
  assert.equal(sim.beaten.size, 4);
  assert.equal(sim.out.trips, 0);
  const stage = sim.out.stages.receiver_worm;
  assert.ok(stage.foundS <= stage.readyS && stage.readyS <= stage.repairedS && stage.repairedS <= stage.calledS);
  assert.ok(stage.calledS - sim.out.milestones['boss:colossus'] < 180);
  const report = summaryMd({ sha: 'fixture', simHash: 'fixture', capS: 36000, runs: [{ ...sim.out, seed: 0, ms: 0 }] });
  assert.ok(report.includes('Progression stages'));
});

test('a failed boss is attempted only once during a home visit', () => {
  const sim = finalReceiverFixture();
  sim.odds = () => ({ win: 0.5, death: 0, seconds: 900 });
  sim.fightRand = () => 0.99;
  sim.home();
  assert.equal(sim.out.bossTries, 1);
  assert.equal(sim.beaten.size, 2);
});

test('bench salvage pays only its frame; field salvage includes real completion bonuses', () => {
  const sim = finalReceiverFixture();
  for (const kind of ['pod_console', 'jet_engine']) {
    const rules = stepList(kind, 1, 1);
    const groups = new Map();
    for (const step of rules.list) if (step.module) groups.set(`${step.module}:${step.inner}`, step.inner);
    const bonus = [...groups.values()].reduce((n, inner) => n + (inner ? SCRAP_REWARD.piece : SCRAP_REWARD.module), 0);
    assert.equal(sim.teardownScrap(kind, 1, 1, false), frameScrap(kind, 1, 1, 0));
    assert.equal(sim.teardownScrap(kind, 1, 1), frameScrap(kind, 1, 1, 0) + rules.list.length * SCRAP_REWARD.step + bonus);
  }
});
