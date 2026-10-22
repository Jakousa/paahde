// A player's pickups (scrap, debris, small machines): a short burst, refilled at a steady rate. Counted as the requests
// reach the server, where a link that stalls and catches up bunches presses made well apart, so a fixed gap between
// pickups would refuse some of them; a burst lets those through and still stops a flood.

const BURST = 5;
/** Pickups a second, once the burst is spent. */
const RATE = 5;

export type PickupLimit = { tokens: number; at: number };

export const pickupLimit = (): PickupLimit => ({ tokens: BURST, at: Date.now() });

/** Spend one pickup at `now` (ms); false if over the limit. */
export function spendPickup(l: PickupLimit, now: number): boolean {
  l.tokens = Math.min(BURST, l.tokens + ((now - l.at) / 1000) * RATE);
  l.at = now;
  if (l.tokens < 1) return false;
  l.tokens -= 1;
  return true;
}
