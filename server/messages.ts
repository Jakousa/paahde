// Runtime boundary for JSON from browsers. TypeScript's ClientMsg only describes trusted code;
// reject malformed numbers, containers and registry keys before any game handler sees them.
import type { ClientMsg } from '../shared/protocol.ts';
import { INPUT_MASK, YAW_STEPS } from '../shared/sim.ts';
import { PITCH_STEPS } from '../shared/dig.ts';
import { boxKind } from '../shared/boxes.ts';
import { ITEMS } from '../shared/items.ts';
import { BUILDS, HAND_RECIPES, RECIPES } from '../shared/crafting.ts';

const num = (v: unknown, min = -1e7, max = 1e7): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const int = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => num(v, min, max) && Number.isSafeInteger(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256;
const box = (v: unknown): v is string => str(v) && boxKind(v) !== null;
const optional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v);
const bool = (v: unknown) => typeof v === 'boolean';

export function clientMessage(v: unknown): v is ClientMsg {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const m = v as Record<string, unknown>;
  const pos = (...keys: string[]) => keys.every((k) => num(m[k]));
  switch (m.t) {
    case 'hello': return str(m.browserId) && typeof m.name === 'string' && m.name.length <= 256 && optional(m.color, int) && optional(m.look, int)
      && optional(m.spawn, (x) => ['pod', 'crash', 'field', 'shelter', 'canyon'].includes(x as string));
    case 'input': return int(m.seq, 1) && int(m.input, 0, INPUT_MASK) && int(m.yaw, 0, YAW_STEPS - 1) && int(m.pitch, 0, PITCH_STEPS - 1);
    case 'pickup': return int(m.ix, -1e7, 1e7) && int(m.iz, -1e7, 1e7) && int(m.i, 0, 255);
    case 'tend': return int(m.bed);
    case 'place': return int(m.slot, 0, 4095) && pos('x', 'z') && int(m.rot, 0, 3);
    case 'build': return str(m.kind) && Object.hasOwn(BUILDS, m.kind) && pos('x', 'z') && int(m.rot, 0, 3);
    case 'wire': return int(m.slot, 0, 4095) && int(m.a) && int(m.b);
    case 'unplace': case 'spawnToggle': case 'repairVehicle': case 'mount': case 'lootTake': return int(m.id);
    case 'beaconColor': return int(m.id) && int(m.color, 0, 255);
    case 'craft': return str(m.recipe) && (Object.hasOwn(RECIPES, m.recipe) || Object.hasOwn(HAND_RECIPES, m.recipe));
    case 'setEpoch': return m.epoch === null || num(m.epoch, -8.64e15, 8.64e15);
    case 'drink': case 'fill': case 'call': case 'debugHit': case 'debugVortexVisit': case 'ready': return true;
    case 'hands': return int(m.hands, 0, 5) && optional(m.slot, (x) => int(x, -1, 4095)) && optional(m.aim, bool);
    case 'telemetry': return Array.isArray(m.ev) && m.ev.length <= 16 && optional(m.sum, (x) => !!x && typeof x === 'object' && !Array.isArray(x));
    case 'storm': return optional(m.front, bool) && optional(m.gas, bool) && optional(m.vortex, bool);
    case 'move': return box(m.from) && box(m.to) && int(m.fi, 0, 4095) && int(m.ti, -1, 4095) && optional(m.n, (x) => int(x, 1, 1e6)) && optional(m.r, bool);
    case 'sort': return box(m.box);
    case 'fit': return box(m.from) && int(m.fi, 0, 4095) && int(m.slot, 0, 255) && optional(m.at, box);
    case 'unfit': return box(m.to) && int(m.ti, -1, 4095) && int(m.slot, 0, 255) && optional(m.at, box);
    case 'drop': return box(m.box) && int(m.slot, 0, 4095);
    case 'summon': return ['guardian', 'drone', 'jet', 'crawlers', 'harvester', 'worm', 'carrier', 'queen', 'colossus'].includes(m.what as string);
    case 'jam': return (m.kind === 'jet' || m.kind === 'drone') && int(m.id) && pos('x', 'y', 'z', 'dx', 'dy', 'dz');
    case 'stomped': return int(m.g);
    case 'fire': return pos('x', 'y', 'z', 'ex', 'ey', 'ez') && ['g', 'i', 'd', 'j', 'h', 'hi', 'b', 'bi'].every((k) => optional(m[k], (x) => int(x, -1)));
    case 'throw': return int(m.slot, 0, 4095) && int(m.n) && pos('x', 'y', 'z', 'dx', 'dy', 'dz');
    case 'debugGear': return optional(m.tier, (x) => int(x, 0, 3));
    case 'debugGive': return str(m.kind) && Object.hasOwn(ITEMS, m.kind) && optional(m.n, (x) => int(x, 1, 1e6)) && optional(m.tier, (x) => int(x, -1, 3));
    case 'debugHeat': case 'debugWeather': return bool(m.off);
    case 'crashTake': case 'siteJoin': case 'siteLeave': case 'siteScrap': return str(m.id);
    case 'crashUse': return str(m.kind) && Object.hasOwn(ITEMS, m.kind) && str(m.at);
    case 'benchScrap': return str(m.at);
    case 'labReset': return optional(m.id, str);
    case 'siteDone': case 'siteTake': return str(m.id) && int(m.i, 0, 255);
    case 'chat': return typeof m.text === 'string' && m.text.length <= 1024;
    default: return false;
  }
}
