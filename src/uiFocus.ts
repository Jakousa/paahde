/** Directional focus in screen coordinates, independent of UI scale and grid spacing. */
export function neighbour<T>(from: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  candidates: { rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>; element: T }[], dx: number, dy: number): T | null {
  const x = from.left + from.width / 2, y = from.top + from.height / 2;
  let best: T | null = null, score = Infinity;
  for (const { rect: r, element } of candidates) {
    const vx = r.left + r.width / 2 - x, vy = r.top + r.height / 2 - y;
    const along = vx * dx + vy * dy, across = Math.abs(vx * dy - vy * dx);
    if (along <= 1) continue;
    const cost = along + across * 3;
    if (cost < score) { score = cost; best = element; }
  }
  return best;
}
