// Companion bots (scavenger bots): client and server shared state.
// Both sides keep NPCS up to date (server/world.ts sends 'npcs' on join and changes),
// so shared/storage.ts knows which bot cargo boxes are within reach.

export type NpcSnap = {
  id: number;
  owner: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  task: string;
  cargoCount: number;
};

/** Active companion bots in the world by id. */
export const NPCS = new Map<number, NpcSnap>();

export const BOT_REACH = 3.0;

export const botBox = (id: number) => `bot${id}`;

/** Is this a bot's box id? */
export const isBotBox = (box: string) => /^bot\d+$/.test(box);

/** A bot's id from its box id, or -1. */
export function botId(box: string): number {
  const m = /^bot(\d+)$/.exec(box);
  const id = m ? Number(m[1]) : -1;
  return id;
}

/** Box ids of bots within reach of position `s`, nearest first. */
export function botsNear(s: { x: number; z: number }, slack = 0): string[] {
  return [...NPCS.values()]
    .map((b) => ({ b, d: Math.hypot(s.x - b.x, s.z - b.z) }))
    .filter((o) => o.d < BOT_REACH + slack)
    .sort((a, b) => a.d - b.d)
    .map((o) => botBox(o.b.id));
}
