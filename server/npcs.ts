// Server-side management of craftable companion bots (shared/npcs.ts).
// Handles bot spawning, recall, physics stepping, scrap collection, following the owner,
// and inventory synchronization.

import { heightAt } from '../shared/terrain.ts';
import { scrapPieces, SCRAP_CELL, scrapTaken, scrapKey } from '../shared/scrap.ts';
import { scrapItem } from '../shared/items.ts';
import { NPCS, type NpcSnap } from '../shared/npcs.ts';
import { keepOut, skirt, type Skirt } from './pack.ts';
import type { openDb } from './db.ts';
import type { ItemServer } from './items.ts';
import type { ScrapServer } from './scrap.ts';
import type { LootServer } from './loot.ts';

type Db = ReturnType<typeof openDb>;

const BOT_RADIUS = 0.45;
const BOT_SPEED = 4.8;
const BOT_FOLLOW_STOP = 2.5;
const BOT_FOLLOW_START = 3.8;
const GATHER_RANGE = 50;
const PICKUP_DIST = 1.6;

export type NpcState = {
  id: number;
  owner: string; // Player browserId
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  task: 'idle' | 'follow' | 'gather';
  targetScrap: { ix: number; iz: number; i: number; x: number; z: number } | null;
  skirt: Skirt;
  saveAt: number;
};

export class NpcServer {
  private db: Db;
  private items: ItemServer;
  private scrap: ScrapServer;
  private loot: LootServer;
  private npcs = new Map<number, NpcState>();

  constructor(db: Db, items: ItemServer, scrap: ScrapServer, loot: LootServer) {
    this.db = db;
    this.items = items;
    this.scrap = scrap;
    this.loot = loot;

    for (const r of db.loadNpcs()) {
      const npc: NpcState = {
        id: r.id,
        owner: r.owner,
        x: r.x,
        y: r.y,
        z: r.z,
        yaw: r.yaw,
        vx: 0,
        vz: 0,
        task: (r.task as 'idle' | 'follow' | 'gather') || 'follow',
        targetScrap: null,
        skirt: { side: 0, until: 0 },
        saveAt: 0,
      };
      this.npcs.set(r.id, npc);
      NPCS.set(r.id, this.snap(npc));
    }
  }

  private snap(n: NpcState): NpcSnap {
    const cargo = this.items.slots('', `bot${n.id}`).filter(Boolean).length;
    return {
      id: n.id,
      owner: n.owner,
      x: n.x,
      y: n.y,
      z: n.z,
      yaw: n.yaw,
      task: n.task,
      cargoCount: cargo,
    };
  }

  /** Spawn a newly placed companion bot. */
  spawn(owner: string, x: number, y: number, z: number, yaw: number): NpcState {
    const id = this.db.insertNpc(owner, x, y, z, yaw, 'follow');
    const npc: NpcState = {
      id,
      owner,
      x,
      y,
      z,
      yaw,
      vx: 0,
      vz: 0,
      task: 'follow',
      targetScrap: null,
      skirt: { side: 0, until: 0 },
      saveAt: Date.now() + 5000,
    };
    this.npcs.set(id, npc);
    NPCS.set(id, this.snap(npc));
    return npc;
  }

  /** Recall the bot: deposits its cargo to player bag or ground, deletes it, and gives the bot item back. */
  recall(id: number, player: { browserId: string; state: { x: number; y: number; z: number } }): { ok: boolean; reason?: 'not_found' | 'bag_full' } {
    const bot = this.npcs.get(id);
    if (!bot) return { ok: false, reason: 'not_found' };

    // Give the bot item back first
    if (!this.items.give(player.browserId, 'scavenger_bot', 1)) {
      return { ok: false, reason: 'bag_full' };
    }

    // Unload cargo: give to player bag, or drop on ground if bag is full
    const cargo = this.items.slots('', `bot${id}`);
    for (let i = 0; i < cargo.length; i++) {
      const it = cargo[i];
      if (!it) continue;
      if (!this.items.give(player.browserId, it.kind, it.n)) {
        this.loot.dropAt(bot.x, bot.z, it.kind);
      }
      cargo[i] = null;
    }

    this.db.deleteNpc(id);
    this.npcs.delete(id);
    NPCS.delete(id);
    return { ok: true };
  }

  /** Set current task for bot (e.g. from chat command). */
  setTask(id: number, task: 'idle' | 'follow' | 'gather') {
    const bot = this.npcs.get(id);
    if (bot) {
      bot.task = task;
      bot.targetScrap = null;
      bot.saveAt = 0; // force immediate save
    }
  }

  /** Tick all companion bots in the world. */
  tick(dt: number, now: number, players: { id: number; browserId: string; state: { x: number; y: number; z: number } }[]) {
    if (this.npcs.size === 0) return;

    for (const bot of this.npcs.values()) {
      const owner = players.find((p) => p.browserId === bot.owner);

      // Decision and steering
      if (bot.task === 'follow' && owner) {
        const dx = owner.state.x - bot.x;
        const dz = owner.state.z - bot.z;
        const d = Math.hypot(dx, dz);

        if (d > BOT_FOLLOW_START) {
          let h = Math.atan2(dx, dz);
          h = skirt(bot.x, bot.z, h, BOT_RADIUS, bot.skirt, now);
          const spd = Math.min(BOT_SPEED, (d - BOT_FOLLOW_STOP) * 2.0);
          bot.vx = Math.sin(h) * spd;
          bot.vz = Math.cos(h) * spd;
          bot.yaw = h;
        } else {
          bot.vx = 0;
          bot.vz = 0;
        }
      } else if (bot.task === 'gather') {
        // Look for or navigate to scrap
        if (!bot.targetScrap || scrapTaken.has(scrapKey(bot.targetScrap.ix, bot.targetScrap.iz, bot.targetScrap.i))) {
          bot.targetScrap = this.findNearestScrap(bot.x, bot.z, GATHER_RANGE);
        }

        if (bot.targetScrap) {
          const dx = bot.targetScrap.x - bot.x;
          const dz = bot.targetScrap.z - bot.z;
          const d = Math.hypot(dx, dz);

          if (d <= PICKUP_DIST) {
            // Pick up piece
            const target = bot.targetScrap;
            bot.targetScrap = null;
            bot.vx = 0;
            bot.vz = 0;

            const takenKind = this.scrap.takePiece(target.ix, target.iz, target.i, (k) => {
              const item = scrapItem(k);
              return this.items.giveToBox('', `bot${bot.id}`, item, 1);
            });

            // If bag full or couldn't pick up, switch to follow
            if (takenKind === null) {
              bot.task = 'follow';
            }
          } else {
            let h = Math.atan2(dx, dz);
            h = skirt(bot.x, bot.z, h, BOT_RADIUS, bot.skirt, now);
            bot.vx = Math.sin(h) * BOT_SPEED;
            bot.vz = Math.cos(h) * BOT_SPEED;
            bot.yaw = h;
          }
        } else {
          // No scrap found, fallback to follow
          bot.task = 'follow';
        }
      } else {
        bot.vx = 0;
        bot.vz = 0;
      }

      // Step physics
      bot.x += bot.vx * dt;
      bot.z += bot.vz * dt;
      [bot.x, bot.z] = keepOut(bot.x, bot.z, BOT_RADIUS);
      bot.y = heightAt(bot.x, bot.z);

      // Sync to shared map
      NPCS.set(bot.id, this.snap(bot));

      // Periodic DB persist
      if (now >= bot.saveAt) {
        bot.saveAt = now + 5000;
        this.db.saveNpc(bot.id, bot.x, bot.y, bot.z, bot.yaw, bot.task);
      }
    }
  }

  private findNearestScrap(bx: number, bz: number, maxDist: number) {
    const minCellX = Math.floor((bx - maxDist) / SCRAP_CELL);
    const maxCellX = Math.floor((bx + maxDist) / SCRAP_CELL);
    const minCellZ = Math.floor((bz - maxDist) / SCRAP_CELL);
    const maxCellZ = Math.floor((bz + maxDist) / SCRAP_CELL);

    let bestDist = maxDist;
    let bestPiece: { ix: number; iz: number; i: number; x: number; z: number } | null = null;

    for (let cx = minCellX; cx <= maxCellX; cx++) {
      for (let cz = minCellZ; cz <= maxCellZ; cz++) {
        const pieces = scrapPieces(cx, cz);
        for (const pc of pieces) {
          if (scrapTaken.has(pc.key)) continue;
          const d = Math.hypot(pc.x - bx, pc.z - bz);
          if (d < bestDist) {
            bestDist = d;
            bestPiece = { ix: pc.ix, iz: pc.iz, i: pc.i, x: pc.x, z: pc.z };
          }
        }
      }
    }
    return bestPiece;
  }

  snapshot(): NpcSnap[] {
    return [...this.npcs.values()].map((n) => this.snap(n));
  }

  joinMessage(): { t: 'npcs'; list: NpcSnap[] } {
    return { t: 'npcs', list: this.snapshot() };
  }
}
