/** Mouse velocity and its previous direction while a bolt is held. */
export type BoltGesture = { sx: number; sy: number; angle: number };

/** Half-turns made by the mouse's travel direction. Travel is in pixels, dt in seconds.
 * Keep the original 60 Hz feel (0.7 smoothing, 2.5 px/frame threshold) at every refresh rate. */
export function boltTurns(a: BoltGesture, mx: number, my: number, dt: number): number {
  if (!(dt > 0) || !Number.isFinite(dt)) return 0;
  if (dt > 0.25) {
    a.sx = a.sy = 0;
    a.angle = NaN;
    return 0;
  }
  const decay = Math.pow(0.7, dt * 60);
  a.sx = a.sx * decay + (mx / dt) * (1 - decay);
  a.sy = a.sy * decay + (my / dt) * (1 - decay);
  if (Math.hypot(a.sx, a.sy) < 150) {
    // A pause must not connect two unrelated directions into a turn.
    a.angle = NaN;
    return 0;
  }
  const angle = Math.atan2(a.sy, a.sx);
  const delta = Number.isNaN(a.angle) ? 0 : Math.atan2(Math.sin(angle - a.angle), Math.cos(angle - a.angle));
  a.angle = angle;
  return Math.abs(delta) / Math.PI;
}
