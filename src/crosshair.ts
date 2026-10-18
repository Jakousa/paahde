// The dot in the middle of the screen (hidden in third person and while dead), and the ring that fills
// around it while something takes time (getting on the bike).
const RING_R = 16;
const RING_C = 2 * Math.PI * RING_R;
let ring: SVGSVGElement | null = null;

export function addCrosshair() {
  const style = document.createElement('style');
  style.textContent = `
    #crosshair { position: fixed; left: 50%; top: 50%; width: 6px; height: 6px; margin: -3px 0 0 -3px;
      border-radius: 50%; background: rgba(255,255,255,.85); box-shadow: 0 0 0 1px rgba(0,0,0,.35);
      pointer-events: none; }
    body.third-person #crosshair, body.down #crosshair { display: none; }
    #crossRing { position: fixed; left: 50%; top: 50%; width: ${RING_R * 2 + 8}px; height: ${RING_R * 2 + 8}px;
      margin: -${RING_R + 4}px 0 0 -${RING_R + 4}px; pointer-events: none; display: none; overflow: visible; }
    #crossRing circle { fill: none; stroke-width: 4; }
    #crossRing .bg { stroke: rgba(0,0,0,.35); }
    #crossRing .fg { stroke: rgba(255,255,255,.9); stroke-linecap: round; transform: rotate(-90deg); transform-origin: 50% 50%;
      stroke-dasharray: ${RING_C}; }`;
  document.head.appendChild(style);
  const cross = document.createElement('div');
  cross.id = 'crosshair';
  const c = RING_R + 4;
  const holder = document.createElement('div');
  holder.innerHTML = `<svg id="crossRing" viewBox="0 0 ${c * 2} ${c * 2}"><circle class="bg" cx="${c}" cy="${c}" r="${RING_R}"/><circle class="fg" cx="${c}" cy="${c}" r="${RING_R}"/></svg>`;
  ring = holder.firstElementChild as SVGSVGElement;
  document.body.append(cross, ring);
}

/** Fill the ring around the crosshair to `f` (0..1); null hides it. */
export function crosshairRing(f: number | null) {
  if (!ring) return;
  ring.style.display = f === null ? 'none' : 'block';
  if (f !== null) ring.querySelector<SVGCircleElement>('.fg')!.style.strokeDashoffset = `${RING_C * (1 - Math.min(1, Math.max(0, f)))}`;
}
