import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { CorpseServer } from '../server/corpses.ts';
import { CORPSE_MS, CORPSES } from '../shared/corpse.ts';
import { BossServer } from '../server/bosses.ts';
import { BOSS_KINDS, BOSSES } from '../shared/bosses.ts';
import { crowd } from '../server/bossCrowd.ts';

test('corpse recovery budget survives offline time and restart without exposing owner credentials', () => {
  const db = openDb(':memory:');
  const owner = 'private-browser-credential';
  const now = Date.now();
  const id = db.insertCorpse(owner, 123, 5000, 5000, now + CORPSE_MS);
  db.saveCorpseTime(id, CORPSE_MS, now + CORPSE_MS);
  const items = { dropBox() {} }, messages = [];
  try {
    const srv = new CorpseServer(db, items, (m) => messages.push(m));
    srv.expire(new Set(), now + 24 * 3600_000);
    assert.equal(db.loadCorpses()[0].remaining, CORPSE_MS);
    assert.equal(JSON.stringify(srv.joinMessage()).includes(owner), false);
    srv.expire(new Set([owner]), now + 24 * 3600_000 + 60_000);
    assert.equal(db.loadCorpses()[0].remaining, CORPSE_MS - 60_000);
    CORPSES.clear();
    const restarted = new CorpseServer(db, items, (m) => messages.push(m));
    assert.equal(db.loadCorpses()[0].remaining, CORPSE_MS - 60_000);
    restarted.expire(new Set([owner]), Date.now() + CORPSE_MS);
    assert.equal(db.loadCorpses().length, 0);
    assert.equal(CORPSES.has(id), false);
  } finally { db.close(); CORPSES.clear(); }
});

test('every called boss restores position and damage without teleporting to the next joining player', () => {
  const srv = new BossServer(), now = 1000;
  const player = { id: 1, x: -9000, y: 0, z: -9000, safe: false };
  const at = { x: 5234, z: 6789, yaw: 1.25 };
  for (const kind of BOSS_KINDS) {
    assert.equal(srv.call(kind, player, now, 2, at), true);
    const boss = srv.alive(kind);
    assert.equal(boss.x, at.x); assert.equal(boss.z, at.z); assert.equal(boss.yaw, at.yaw);
    assert.equal(boss.hp, BOSSES[kind].hp - 2);
    assert.ok(Number.isFinite(boss.y));
  }
});

test('spectators and safe players do not inflate crowds or suppress weather', () => {
  const srv = new BossServer(), now = 1000;
  const by = { id: 1, x: 8000, y: 1000, z: 8000, safe: false };
  srv.call('carrier', by, now, 0, { x: by.x, z: by.z, yaw: 0 });
  const b = srv.alive('carrier');
  const players = [by, { ...by, id: 2 }, { ...by, id: 3, safe: true }];
  assert.equal(crowd(b, players), 1);
  assert.equal(srv.engaged(now, players), false);
  b.foes.set(1, now + 30_000); b.foes.set(3, now + 30_000);
  assert.equal(crowd(b, players), 1);
  assert.equal(srv.engaged(now, players), true);
  b.foes.set(2, now + 30_000);
  assert.equal(crowd(b, players), 2);
  assert.equal(srv.engaged(now + 31_000, players), false);
});
