// World generation: what the server and the client compute from the seed before anything is drawn or simulated. Loading
// the layout modules, the heightfield over the core, and every site, shelter, wreck and scrap pile in it, all cold.
import { checksum, time, type Sample } from '../common.ts';

export async function run(): Promise<Sample> {
  const t0 = performance.now();
  const [{ heightAt, normalAt, CORE_HALF }, { biomeAt }, { coreCrashSites }, { sheltersNear }, { wrecksNear }, { scrapPieces, SCRAP_CELL }] = await Promise.all([
    import('../../../shared/terrain.ts'), import('../../../shared/biomes.ts'), import('../../../shared/crashsites.ts'),
    import('../../../shared/shelters.ts'), import('../../../shared/wrecks.ts'), import('../../../shared/scrap.ts'),
  ]);
  const load = performance.now() - t0;

  // The heightfield: 400 × 400 points 10 m apart over the core, then a 2 m grid where the player starts (the detail a
  // terrain chunk is built at).
  const heights: number[] = [];
  const coarse = time(() => {
    for (let i = 0; i < 400; i++) for (let j = 0; j < 400; j++) heights.push(heightAt(-CORE_HALF + i * 10, -CORE_HALF + j * 10));
  });
  const fine = time(() => {
    for (let i = 0; i < 300; i++) for (let j = 0; j < 300; j++) heights.push(heightAt(-300 + i * 2, -300 + j * 2));
  });
  const n = { x: 0, y: 0, z: 0 };
  const normals = time(() => {
    for (let i = 0; i < 200; i++) for (let j = 0; j < 200; j++) normalAt(-CORE_HALF + i * 20, -CORE_HALF + j * 20, n);
  });
  let biomes = 0;
  const biomeMs = time(() => {
    for (let i = 0; i < 200; i++) for (let j = 0; j < 200; j++) if (biomeAt(-CORE_HALF + i * 20, -CORE_HALF + j * 20)) biomes++;
  });

  let sites = 0, shelters = 0, wrecks = 0, pieces = 0;
  const siteMs = time(() => (sites = coreCrashSites().length));
  const shelterMs = time(() => (shelters = sheltersNear(0, 0, CORE_HALF * 1.5).length));
  const wreckMs = time(() => (wrecks = wrecksNear(0, 0, CORE_HALF).length));
  const cells = Math.ceil(CORE_HALF / SCRAP_CELL);
  const scrapMs = time(() => {
    for (let ix = -cells; ix < cells; ix++) for (let iz = -cells; iz < cells; iz++) pieces += scrapPieces(ix, iz).length;
  });

  return {
    m: {
      'load layout modules': [load, 'ms'],
      'heightfield, core at 10 m (160k)': [coarse, 'ms'],
      'heightfield, spawn at 2 m (90k)': [fine, 'ms'],
      'normals (40k)': [normals, 'ms'],
      'biomes (40k)': [biomeMs, 'ms'],
      'crash sites in the core': [siteMs, 'ms'],
      'shelters': [shelterMs, 'ms'],
      'wrecks': [wreckMs, 'ms'],
      'scrap piles in the core': [scrapMs, 'ms'],
      'crash sites': [sites, ''],
      'scrap pieces': [pieces, ''],
    },
    info: { layout: checksum([...heights.filter((_, i) => i % 97 === 0), biomes, sites, shelters, wrecks, pieces], 2) },
  };
}
