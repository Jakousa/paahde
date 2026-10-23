// Heat haze over the main menu's title (src/landing.ts): the title shimmers as if seen through hot air. The haze is
// fixed to the page, not to the title: an SVG filter on a still layer that holds the title, its noise in the layer's
// own coordinates, so when the title moves (stage(), src/landing.ts) it moves through the heat. The noise drifts up
// like rising air: two copies of it, offset half a loop apart, are cross-faded so the loop never shows a seam. Only a
// band round where the title is is worked out each frame (the noise stays put; only what's computed follows), at 30 fps.
const NS = 'http://www.w3.org/2000/svg';
/** How far the haze bends the title (px), its grain (across, up) and how fast it rises (px/s). Gentle. (The bend
 *  samples the title pixel by pixel, so a hair of blur after it keeps the edges smooth.) */
const SCALE = 4;
const FREQ = '0.009 0.028';
const RISE = 28;
/** The rising noise loops every this many px (each copy is faded out as it wraps). */
const LOOP = 240;
/** Room round the title's box, for its glow and the bend (px). */
const PAD = 48;

let ids = 0;

/** Put `title` (inside `page`) behind the haze; it stops by itself when the page goes. */
export function haze(page: HTMLElement, title: HTMLElement) {
  const id = `haze${ids++}`;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  svg.innerHTML = `<filter id="${id}" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="${FREQ}" numOctaves="1" seed="7" result="noise"/>
<feOffset in="noise" result="a"/><feOffset in="noise" result="b"/>
<feComposite in="a" in2="b" operator="arithmetic" k1="0" k4="0" result="air"/>
<feDisplacementMap in="SourceGraphic" in2="air" scale="${SCALE}" xChannelSelector="R" yChannelSelector="G" result="bent"/>
<feGaussianBlur in="bent" stdDeviation="0.35"/></filter>`;
  const filter = svg.querySelector('filter')!;
  const noise = svg.querySelector('feTurbulence')!;
  const [a, b] = svg.querySelectorAll('feOffset');
  const mix = svg.querySelector('feComposite')!;
  const bend = [...svg.querySelectorAll('feDisplacementMap, feGaussianBlur')];

  // The still layer: the whole page, the title inside it (it moves by its own transform).
  const layer = document.createElement('div');
  layer.className = 'haze';
  layer.style.filter = `url(#${id})`;
  title.replaceWith(layer);
  layer.append(svg, title);

  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return void (layer.style.filter = '');
  const t0 = performance.now();
  let last = 0;
  const frame = (now: number) => {
    if (!page.isConnected) return;
    requestAnimationFrame(frame);
    if (now - last < 33) return;
    last = now;
    // Where the title is now, in the layer's space: the band the filter works on.
    const l = layer.getBoundingClientRect();
    const r = title.getBoundingClientRect();
    const x = Math.floor(r.left - l.left - PAD);
    const y = Math.floor(r.top - l.top - PAD);
    const w = Math.ceil(r.width + 2 * PAD);
    const h = Math.ceil(r.height + 2 * PAD);
    // The filter's region reaches a loop below the band: the noise is cut to it before it's shifted up.
    for (const [el, hh] of [[filter, h + LOOP], [a, h], [b, h], [mix, h], ...bend.map((e) => [e, h] as const)] as const) {
      el.setAttribute('x', String(x));
      el.setAttribute('y', String(y));
      el.setAttribute('width', String(w));
      el.setAttribute('height', String(hh));
    }
    // The noise below the band too, as far as one loop: rising, the air comes up from there.
    noise.setAttribute('x', String(x));
    noise.setAttribute('y', String(y));
    noise.setAttribute('width', String(w));
    noise.setAttribute('height', String(h + LOOP));
    const p = (((now - t0) / 1000) * RISE) % LOOP;
    const q = (p + LOOP / 2) % LOOP;
    a.setAttribute('dy', String(-p));
    b.setAttribute('dy', String(-q));
    // Each copy fades out as it wraps; the weights add up to one.
    const wa = Math.sin((Math.PI * p) / LOOP) ** 2;
    mix.setAttribute('k2', String(wa));
    mix.setAttribute('k3', String(1 - wa));
  };
  requestAnimationFrame(frame);
}
