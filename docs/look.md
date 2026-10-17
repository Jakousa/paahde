# Look: the burning desert

Art direction for the desert planet, from the team's reference images (Dune Part Two poster, golden-hour
dune photography). Every visual change should move the game towards this.

## The one-line version

A low, enormous, overwhelming sun over an endless sea of orange dunes; everything is amber, gold and
deep rust, with crisp black-brown shadows behind every crest.

## Palette (sRGB, approximate)

| Role | Colour | Notes |
|---|---|---|
| Sun disc core | `#fff4d0` → blown out to white | Always clipped/blooming. Never a clean small dot. |
| Sun disc rim / halo | `#ffb347` → `#f08a1c` | Big soft Mie halo, several times the disc size |
| Sky near sun / horizon | `#f7a440` → `#e07b28` | Hot orange band along the horizon |
| Sky zenith | `#4a3a3a` → `#2b2226` | Dusky brown-purple, *not* blue. Darkens upward. |
| Lit sand (facing sun) | `#e8902e` → `#ffb24a` | Saturated orange-gold, near-glowing |
| Sand mid-tone | `#c46a24` | |
| Sand in shadow | `#4a2414` → `#2a120a` | Deep rust/maroon-brown, high contrast, never grey or blue |
| Distant haze | `#d98a45` | Far dunes fade into an orange haze, not white/blue |

## Light

- **Sun low over the horizon** (elevation roughly 5–20°) so every dune has a long shadow side and
  grazing light picks out ripples. The sun direction should usually be visible in front of the
  player's starting view.
- **Huge apparent sun.** The disc should read big (poster 1: it fills a quarter of the sky). Cheat:
  render a sun disc many times the physical 0.5° size, plus a wide halo and bloom.
- **Burning:** bright enough that bloom spills over dune crests that occlude it, flares/streaks, an
  optional halo ring (ref 4), heat shimmer near the ground, slight exposure blow-out when looking at it.
- **Shadows are crisp and dark**, with a warm (rust) ambient fill, never neutral or cool.
- Strong **rim light**: crests against the sun glow (backlit sand, ref 4).

## Sand surface

- **Wind ripples** everywhere, perpendicular to the wind, wavelength ~10–20 cm visual scale, sharper
  on the lee side; they must be visible in grazing light (refs 3 and 4), fading out with distance.
- Dune shape: smooth, long windward slopes, a **sharp crest**, and a steep slip face (~30–34°).
- Subtle sparkle/glitter where the sand faces the sun.

## Atmosphere

- Distance haze is thick and orange; far dunes become silhouettes in layered bands (ref 3).
- Aerial perspective is more about **warmth and loss of contrast** than about brightness.

## Avoid

- Blue sky, white/grey haze, neutral grey shadows, pale beige "beach sand".
- Flat midday lighting.
