// Server-side management of craftable companion bots (shared/npcs.ts).
// Handles bot spawning, recall, physics stepping, scrap collection, following the owner,
// autonomous base deposits, sentry guard patrols, threat detection, and survival alerts.

import { heightAt } from '../shared/terrain.ts';
import { scrapPieces, SCRAP_CELL, scrapTaken, scrapKey } from '../shared/scrap.ts';
import { scrapItem } from '../shared/items.ts';
import { NPCS, type NpcSnap } from '../shared/npcs.ts';
import { BASE } from '../shared/base.ts';
import { keepOut, skirt, type Skirt } from './pack.ts';
import { compileSituation } from './npcPerception.ts';
import { queryBotLlm, type LlmDecisionResponse } from './npcLlm.ts';
import type { openDb } from './db.ts';
import type { ItemServer } from './items.ts';
import type { ScrapServer } from './scrap.ts';
import type { LootServer } from './loot.ts';
import type { StormServer } from './storm.ts';
import type { GuardianServer } from './guardians.ts';
import { CRAWLER } from '../shared/guardians.ts';

type Db = ReturnType<typeof openDb>;

const BOT_RADIUS = 0.45;
const BOT_SPEED = 4.8;
const BOT_FOLLOW_STOP = 2.5;
const BOT_FOLLOW_START = 3.8;
const GATHER_RANGE = 50;
const PICKUP_DIST = 1.6;
const THINK_INTERVAL_MS = 3500;

export type NpcTask = 'idle' | 'follow' | 'gather' | 'deposit' | 'guard' | 'base' | 'flee';

export type NpcState = {
  id: number;
  owner: string; // Player browserId
  tier: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  task: NpcTask;
  targetScrap: { ix: number; iz: number; i: number; x: number; z: number } | null;
  targetLoot: { id: number; x: number; z: number } | null;
  guardPos: { x: number; z: number } | null;
  guardAngle: number;
  skirt: Skirt;
  saveAt: number;
  lastThinkAt: number;
  thinking: boolean;
  alert: boolean;
  light: boolean;
  emote: 'spin' | 'nod' | 'none';
  emoteUntil: number;
  lastThreatWarnAt: number;
  lastStormWarnAt: number;
  lastWaterWarnAt: number;
};

/** Convert 2D vector offset into a tactical compass heading (e.g. 'NW', 'SE'). */
function compassDir(dx: number, dz: number): string {
  const angle = Math.atan2(dx, -dz) * (180 / Math.PI);
  const norm = (angle + 360 + 22.5) % 360;
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.floor(norm / 45)] || 'N';
}

export class NpcServer {
  private db: Db;
  private items: ItemServer;
  private scrap: ScrapServer;
  private loot: LootServer;
  private storms: StormServer;
  private guardians: GuardianServer;
  private onRadio?: (text: string) => void;
  private npcs = new Map<number, NpcState>();
  private commands = new Map<number, string>();

  constructor(
    db: Db,
    items: ItemServer,
    scrap: ScrapServer,
    loot: LootServer,
    storms: StormServer,
    guardians: GuardianServer,
    onRadio?: (text: string) => void
  ) {
    this.db = db;
    this.items = items;
    this.scrap = scrap;
    this.loot = loot;
    this.storms = storms;
    this.guardians = guardians;
    this.onRadio = onRadio;

    for (const r of db.loadNpcs()) {
      const npc: NpcState = {
        id: r.id,
        owner: r.owner,
        tier: r.tier ?? 0,
        x: r.x,
        y: r.y,
        z: r.z,
        yaw: r.yaw,
        vx: 0,
        vz: 0,
        task: (r.task as NpcTask) || 'follow',
        targetScrap: null,
        targetLoot: null,
        guardPos: null,
        guardAngle: 0,
        skirt: { side: 0, until: 0 },
        saveAt: 0,
        lastThinkAt: 0,
        thinking: false,
        alert: false,
        light: false,
        emote: 'none',
        emoteUntil: 0,
        lastThreatWarnAt: 0,
        lastStormWarnAt: 0,
        lastWaterWarnAt: 0,
      };
      this.npcs.set(r.id, npc);
      NPCS.set(r.id, this.snap(npc));
    }
  }

  private radio(text: string) {
    if (this.onRadio) this.onRadio(text);
  }

  private snap(n: NpcState): NpcSnap {
    const cargo = this.items.slots('', `bot${n.id}`).filter(Boolean).length;
    return {
      id: n.id,
      owner: n.owner,
      tier: n.tier ?? 0,
      x: n.x,
      y: n.y,
      z: n.z,
      yaw: n.yaw,
      task: n.task,
      cargoCount: cargo,
      alert: n.alert,
      light: n.light,
      emote: n.emote,
    };
  }

  /** Spawn a newly placed companion bot. */
  spawn(owner: string, x: number, y: number, z: number, yaw: number, tier = 0): NpcState {
    const id = this.db.insertNpc(owner, x, y, z, yaw, 'follow', tier);
    const npc: NpcState = {
      id,
      owner,
      tier,
      x,
      y,
      z,
      yaw,
      vx: 0,
      vz: 0,
      task: 'follow',
      targetScrap: null,
      targetLoot: null,
      guardPos: null,
      guardAngle: 0,
      skirt: { side: 0, until: 0 },
      saveAt: Date.now() + 5000,
      lastThinkAt: 0,
      thinking: false,
      alert: false,
      light: false,
      emote: 'none',
      emoteUntil: 0,
      lastThreatWarnAt: 0,
      lastStormWarnAt: 0,
      lastWaterWarnAt: 0,
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
  setTask(id: number, task: NpcTask, owner?: string, guardPos?: { x: number; z: number }) {
    const bot = this.npcs.get(id);
    if (bot) {
      if (owner && (!bot.owner || bot.owner === '')) bot.owner = owner;
      bot.task = task;
      bot.targetScrap = null;
      bot.targetLoot = null;
      if (task === 'guard') {
        bot.guardPos = guardPos ?? { x: bot.x, z: bot.z };
        bot.guardAngle = 0;
      }
      bot.saveAt = 0; // force immediate save
    }
  }

  /** Toggle worklight on/off for bot. */
  toggleLight(id: number): boolean {
    const bot = this.npcs.get(id);
    if (!bot) return false;
    bot.light = !bot.light;
    return bot.light;
  }

  /** Trigger an expressive personality emote. */
  triggerEmote(id: number, emote: 'spin' | 'nod') {
    const bot = this.npcs.get(id);
    if (!bot) return;
    bot.emote = emote;
    bot.emoteUntil = performance.now() + (emote === 'spin' ? 2200 : 1400);
  }

  /** Set player text command for bot and trigger evaluation. */
  setCommand(id: number, command: string) {
    this.commands.set(id, command);
    const bot = this.npcs.get(id);
    if (bot) {
      bot.lastThinkAt = 0; // rethink immediately
    }
  }

  /** Unload all collected cargo from bot into home base storage chest (chest0). Returns items moved. */
  depositCargo(bot: NpcState): number {
    const cargo = this.items.slots('', `bot${bot.id}`);
    let count = 0;
    for (let i = 0; i < cargo.length; i++) {
      const it = cargo[i];
      if (!it) continue;
      const ok = this.items.giveToBox('', 'chest0', it.kind, it.n ?? 1);
      if (ok) {
        count += it.n ?? 1;
        cargo[i] = null;
      }
    }
    if (count > 0) {
      this.items.save('', `bot${bot.id}`);
    }
    return count;
  }

  /** In the dev test lab, ensure at least one companion robot is placed and active near spawn. */
  initLab(spawn: { x: number; z: number }) {
    if (this.npcs.size > 0) return;
    const x = spawn.x + 2.0;
    const z = spawn.z + 2.5;
    const y = heightAt(x, z);
    this.spawn('', x, y, z, 0, 1);
  }

  /** Tick all companion bots in the world. */
  tick(
    dt: number,
    now: number,
    players: { id: number; browserId: string; state: { x: number; y: number; z: number }; heat?: { heat: number; sips: number; maxSips: number; temp: number } }[],
    tod?: number
  ) {
    if (this.npcs.size === 0) return;

    for (const bot of this.npcs.values()) {
      const owner = players.find((p) => p.browserId === bot.owner) ?? (bot.owner === '' ? players[0] : undefined);

      // Automatic worklight at night when escorting operator
      if (typeof tod === 'number' && bot.task === 'follow') {
        const isNight = tod < 0.22 || tod > 0.78;
        if (isNight && !bot.light) bot.light = true;
        else if (!isNight && bot.light) bot.light = false;
      }

      // --------------------------------------------------------------------------------------------
      // 1. Emote Timer Expiration
      // --------------------------------------------------------------------------------------------
      if (bot.emote !== 'none' && now > bot.emoteUntil) {
        bot.emote = 'none';
      }

      // --------------------------------------------------------------------------------------------
      // 2. Autonomous Threat Radar & Weather Warning
      // --------------------------------------------------------------------------------------------
      let threatDetected = false;

      // Scan for hostile walkers and crawlers within 42m
      for (const w of this.guardians.guardians) {
        if (w.deadAt > 0) continue;
        const d = Math.hypot(w.x - bot.x, w.z - bot.z);
        if (d < 42) {
          threatDetected = true;
          if (now - bot.lastThreatWarnAt > 28000) {
            bot.lastThreatWarnAt = now;
            const heading = compassDir(w.x - bot.x, w.z - bot.z);
            const kind = w.kind === CRAWLER ? 'Crawler' : 'Guardian';
            this.radio(`Warning: Hostile ${kind} spotted ${Math.round(d)}m ${heading}!`);
          }
          break;
        }
      }

      // Scan for sandstorm proximity
      for (const s of this.storms.storms) {
        const d = Math.hypot(s.x - bot.x, s.z - bot.z);
        if (d < s.r + 90) {
          threatDetected = true;
          if (now - bot.lastStormWarnAt > 35000) {
            bot.lastStormWarnAt = now;
            this.radio('Weather alert: Sandstorm approaching. Recommend seeking shelter.');
          }
          break;
        }
      }

      bot.alert = threatDetected;

      // --------------------------------------------------------------------------------------------
      // 3. Autonomous Operator Health & Heat Monitor
      // --------------------------------------------------------------------------------------------
      if (owner?.heat && typeof owner.heat.heat === 'number') {
        if (owner.heat.heat > 70 && now - bot.lastWaterWarnAt > 30000) {
          bot.lastWaterWarnAt = now;
          const cargo = this.items.slots('', `bot${bot.id}`);
          const hasWater = cargo.some((it) => it && (it.kind === 'canteen' || it.kind === 'water_bottle'));
          if (hasWater) {
            this.radio(`Alert: Operator heat index critical (${Math.round(owner.heat.temp)}°C). Canteen ready in cargo hold.`);
          } else {
            this.radio(`Warning: Operator heat index critical (${Math.round(owner.heat.temp)}°C). Seek shade or water.`);
          }
        }
      }

      // --------------------------------------------------------------------------------------------
      // 4. Asynchronous SLM Strategic Decision Loop (Non-blocking)
      // --------------------------------------------------------------------------------------------
      if (!bot.thinking && now - bot.lastThinkAt >= THINK_INTERVAL_MS) {
        bot.lastThinkAt = now;
        bot.thinking = true;
        const ownerPos = owner ? { x: owner.state.x, z: owner.state.z } : null;
        const cmd = this.commands.get(bot.id) ?? '';
        const situation = compileSituation(bot, ownerPos, cmd, this.items, this.loot, this.storms, this.guardians, now);

        queryBotLlm(JSON.stringify(situation)).then((res: LlmDecisionResponse | null) => {
          bot.thinking = false;
          if (res) {
            // Respect explicit player stay/idle command unless fleeing threat
            if (bot.task === 'idle' && res.action !== 'FLEE') return;
            if (res.action === 'GATHER') bot.task = 'gather';
            else if (res.action === 'FOLLOW') bot.task = 'follow';
            else if (res.action === 'WAIT') bot.task = 'idle';
            else if (res.action === 'FLEE') bot.task = 'follow';
            else if (res.action === 'DEPOSIT') bot.task = 'deposit';
          }
        }).catch(() => {
          bot.thinking = false;
        });
      }

      // --------------------------------------------------------------------------------------------
      // 5. Task Execution & Navigation
      // --------------------------------------------------------------------------------------------
      if (bot.task === 'follow' && owner) {
        const dx = owner.state.x - bot.x;
        const dz = owner.state.z - bot.z;
        const d = Math.hypot(dx, dz);

        // Opportunistically grab nearby scrap/loot if cargo has space and owner is nearby (<14m)
        const cargoSlots = this.items.slots('', `bot${bot.id}`);
        const hasSpace = cargoSlots.some((s) => s === null);
        let assistTarget = null;
        if (hasSpace && d < 14) {
          if (!bot.targetScrap && !bot.targetLoot) {
            bot.targetScrap = this.findNearestScrap(bot.x, bot.z, 7.5);
            if (!bot.targetScrap) {
              bot.targetLoot = this.findNearestLoot(bot.x, bot.z, 7.5);
            }
          }
          assistTarget = bot.targetScrap ?? bot.targetLoot;
        } else {
          bot.targetScrap = null;
          bot.targetLoot = null;
        }

        if (assistTarget) {
          const tdx = assistTarget.x - bot.x;
          const tdz = assistTarget.z - bot.z;
          const td = Math.hypot(tdx, tdz);
          if (td <= PICKUP_DIST) {
            bot.vx = 0;
            bot.vz = 0;
            if (bot.targetScrap) {
              const sTarget = bot.targetScrap;
              bot.targetScrap = null;
              this.scrap.takePiece(sTarget.ix, sTarget.iz, sTarget.i, (k) => {
                return this.items.giveToBox('', `bot${bot.id}`, scrapItem(k), 1);
              });
            } else if (bot.targetLoot) {
              const lTarget = bot.targetLoot;
              bot.targetLoot = null;
              this.loot.take({ x: bot.x, y: bot.y, z: bot.z } as any, lTarget.id, (l) => {
                return this.items.giveToBox('', `bot${bot.id}`, l.kind, l.n ?? 1);
              });
            }
          } else {
            let h = Math.atan2(tdx, tdz);
            h = skirt(bot.x, bot.z, h, BOT_RADIUS, bot.skirt, now);
            bot.vx = Math.sin(h) * BOT_SPEED;
            bot.vz = Math.cos(h) * BOT_SPEED;
            bot.yaw = h;
          }
        } else if (d > BOT_FOLLOW_START) {
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
        // Validate target
        if (bot.targetScrap && scrapTaken.has(scrapKey(bot.targetScrap.ix, bot.targetScrap.iz, bot.targetScrap.i))) {
          bot.targetScrap = null;
        }
        if (bot.targetLoot && !this.loot.loot.has(bot.targetLoot.id)) {
          bot.targetLoot = null;
        }

        if (!bot.targetScrap && !bot.targetLoot) {
          bot.targetScrap = this.findNearestScrap(bot.x, bot.z, GATHER_RANGE);
          if (!bot.targetScrap) {
            bot.targetLoot = this.findNearestLoot(bot.x, bot.z, GATHER_RANGE);
          }
        }

        const target = bot.targetScrap ?? bot.targetLoot;
        if (target) {
          const dx = target.x - bot.x;
          const dz = target.z - bot.z;
          const d = Math.hypot(dx, dz);

          if (d <= PICKUP_DIST) {
            bot.vx = 0;
            bot.vz = 0;

            if (bot.targetScrap) {
              const sTarget = bot.targetScrap;
              bot.targetScrap = null;
              const takenKind = this.scrap.takePiece(sTarget.ix, sTarget.iz, sTarget.i, (k) => {
                const item = scrapItem(k);
                return this.items.giveToBox('', `bot${bot.id}`, item, 1);
              });
              if (takenKind === null) {
                this.radio('Cargo hold full (6/6). Ready to deposit.');
                this.triggerEmote(bot.id, 'nod');
                bot.task = 'follow';
              }
            } else if (bot.targetLoot) {
              const lTarget = bot.targetLoot;
              bot.targetLoot = null;
              const taken = this.loot.take({ x: bot.x, y: bot.y, z: bot.z } as any, lTarget.id, (l) => {
                return this.items.giveToBox('', `bot${bot.id}`, l.kind, l.n ?? 1);
              });
              if (taken === null || taken === 'full') {
                this.radio('Cargo hold full (6/6). Ready to deposit.');
                this.triggerEmote(bot.id, 'nod');
                bot.task = 'follow';
              }
            }
          } else {
            let h = Math.atan2(dx, dz);
            h = skirt(bot.x, bot.z, h, BOT_RADIUS, bot.skirt, now);
            bot.vx = Math.sin(h) * BOT_SPEED;
            bot.vz = Math.cos(h) * BOT_SPEED;
            bot.yaw = h;
          }
        } else {
          // If no scrap/loot in range, wait patiently in gather mode
          bot.vx = 0;
          bot.vz = 0;
        }
      } else if (bot.task === 'deposit') {
        // Path toward base bunker entrance
        const dx = BASE.x - bot.x;
        const dz = BASE.z - bot.z;
        const d = Math.hypot(dx, dz);

        if (d <= 4.2) {
          bot.vx = 0;
          bot.vz = 0;
          const deposited = this.depositCargo(bot);
          if (deposited > 0) {
            this.radio(`Deposited ${deposited} items into base storage.`);
            this.triggerEmote(bot.id, 'nod');
          } else {
            this.radio('Cargo already empty.');
          }
          bot.task = 'follow';
        } else {
          let h = Math.atan2(dx, dz);
          h = skirt(bot.x, bot.z, h, BOT_RADIUS, bot.skirt, now);
          bot.vx = Math.sin(h) * BOT_SPEED;
          bot.vz = Math.cos(h) * BOT_SPEED;
          bot.yaw = h;
        }
      } else if (bot.task === 'base') {
        const dx = BASE.x - bot.x;
        const dz = BASE.z - bot.z;
        const d = Math.hypot(dx, dz);

        if (d <= 3.6) {
          bot.vx = 0;
          bot.vz = 0;
          bot.task = 'guard';
          bot.guardPos = { x: bot.x, z: bot.z };
          this.radio('Arrived at home base bunker. Holding guard.');
          this.triggerEmote(bot.id, 'nod');
        } else {
          let h = Math.atan2(dx, dz);
          h = skirt(bot.x, bot.z, h, BOT_RADIUS, bot.skirt, now);
          bot.vx = Math.sin(h) * BOT_SPEED;
          bot.vz = Math.cos(h) * BOT_SPEED;
          bot.yaw = h;
        }
      } else if (bot.task === 'guard') {
        if (!bot.guardPos) bot.guardPos = { x: bot.x, z: bot.z };
        bot.guardAngle += dt * 0.45;
        const tx = bot.guardPos.x + Math.sin(bot.guardAngle) * 4.2;
        const tz = bot.guardPos.z + Math.cos(bot.guardAngle) * 4.2;

        const dx = tx - bot.x;
        const dz = tz - bot.z;
        const d = Math.hypot(dx, dz);

        if (d > 0.6) {
          let h = Math.atan2(dx, dz);
          h = skirt(bot.x, bot.z, h, BOT_RADIUS, bot.skirt, now);
          bot.vx = Math.sin(h) * (BOT_SPEED * 0.55);
          bot.vz = Math.cos(h) * (BOT_SPEED * 0.55);
          bot.yaw = h;
        } else {
          bot.vx = 0;
          bot.vz = 0;
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

  private findNearestLoot(bx: number, bz: number, maxDist: number) {
    let bestDist = maxDist;
    let bestLoot: { id: number; x: number; z: number } | null = null;

    for (const l of this.loot.loot.values()) {
      if (l.kind !== 'scrap' && l.kind !== 'cloth') continue;
      const d = Math.hypot(l.x - bx, l.z - bz);
      if (d < bestDist) {
        bestDist = d;
        bestLoot = { id: l.id, x: l.x, z: l.z };
      }
    }
    return bestLoot;
  }

  snapshot(): NpcSnap[] {
    return [...this.npcs.values()].map((n) => this.snap(n));
  }

  joinMessage(): { t: 'npcs'; list: NpcSnap[] } {
    return { t: 'npcs', list: this.snapshot() };
  }
}
