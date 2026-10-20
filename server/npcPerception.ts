// Compiles a compact, token-efficient Situation Image JSON for the LLM
// running in parallel with the game server (docs/craftable_llm_npc_design.md).

import { BASE } from '../shared/base.ts';
import { scrapPieces, SCRAP_CELL, scrapTaken, scrapPiece } from '../shared/scrap.ts';
import type { NpcState } from './npcs.ts';
import type { ItemServer } from './items.ts';
import type { LootServer } from './loot.ts';
import type { StormServer } from './storm.ts';
import type { GuardianServer } from './guardians.ts';

export type SituationImage = {
  self: {
    cargo: string;
    bunker_dist: number;
    state: string;
  };
  owner: {
    dist: number | null;
    command: string;
  };
  hazards: {
    storm_near: boolean;
    threat_dist: number | null;
  };
  targets: Array<{
    type: 'scrap' | 'loot' | 'chest';
    id: number;
    dist: number;
    kind?: string;
    pieces?: number;
    in_bunker?: boolean;
  }>;
};

export function compileSituation(
  bot: NpcState,
  ownerPos: { x: number; z: number } | null,
  lastCommand: string,
  items: ItemServer,
  loot: LootServer,
  storms: StormServer,
  guardians: GuardianServer,
  serverNow: number
): SituationImage {
  const cargoSlots = items.slots('', `bot${bot.id}`);
  const filled = cargoSlots.filter(Boolean).length;
  const cargoStr = `${filled}/${cargoSlots.length}`;

  const bunkerDist = Math.round(Math.hypot(bot.x - BASE.x, bot.z - BASE.z) * 10) / 10;
  const ownerDist = ownerPos ? Math.round(Math.hypot(bot.x - ownerPos.x, bot.z - ownerPos.z) * 10) / 10 : null;

  // Storm hazard
  const stormNear = storms.storms.some((s) => {
    const d = Math.hypot(bot.x - s.x, bot.z - s.z);
    return d < s.r + 150;
  });

  // Hostile walker/crawler threat
  let nearestThreat: number | null = null;
  for (const w of guardians.guardians) {
    if (w.deadAt > 0) continue;
    const d = Math.hypot(bot.x - w.x, bot.z - w.z);
    if (d < 70 && (nearestThreat === null || d < nearestThreat)) {
      nearestThreat = Math.round(d * 10) / 10;
    }
  }

  // Find nearest 3 scrap pieces
  const targets: SituationImage['targets'] = [];
  const minCellX = Math.floor((bot.x - 45) / SCRAP_CELL);
  const maxCellX = Math.floor((bot.x + 45) / SCRAP_CELL);
  const minCellZ = Math.floor((bot.z - 45) / SCRAP_CELL);
  const maxCellZ = Math.floor((bot.z + 45) / SCRAP_CELL);

  for (let cx = minCellX; cx <= maxCellX; cx++) {
    for (let cz = minCellZ; cz <= maxCellZ; cz++) {
      for (const pc of scrapPieces(cx, cz)) {
        if (scrapTaken.has(pc.key)) continue;
        const d = Math.round(Math.hypot(pc.x - bot.x, pc.z - bot.z) * 10) / 10;
        if (d <= 40) {
          targets.push({ type: 'scrap', id: pc.i, dist: d });
        }
      }
    }
  }

  // Sort and keep closest 2 scrap pieces
  targets.sort((a, b) => a.dist - b.dist);
  targets.splice(2);

  // Check loose loot nearby
  for (const l of loot.loot.values()) {
    const d = Math.round(Math.hypot(l.x - bot.x, l.z - bot.z) * 10) / 10;
    if (d <= 30) {
      targets.push({ type: 'loot', id: l.id, dist: d, kind: l.kind });
    }
  }

  // Always include bunker chest as potential deposit target
  targets.push({
    type: 'chest',
    id: 0,
    dist: bunkerDist,
    in_bunker: true,
  });

  return {
    self: {
      cargo: cargoStr,
      bunker_dist: bunkerDist,
      state: bot.task,
    },
    owner: {
      dist: ownerDist,
      command: lastCommand || 'none',
    },
    hazards: {
      storm_near: stormNear,
      threat_dist: nearestThreat,
    },
    targets,
  };
}
