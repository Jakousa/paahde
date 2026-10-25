// Shared machine recipes: the client supplies its rendering Kit; the server supplies a metadata-only
// adapter. Both execute the same conditional mounts and prerequisite order for each rolled machine.
// These type imports are erased: no renderer or asset loader runs on the server.
import type { Kit, Step, V } from '../src/teardown/junk.ts';
import type { JunkKind } from './salvage.ts';
import { TEXT } from './text.ts';
const S = TEXT.steps;
const HEAVY_LIFT_S = 4;

// ---- broken vehicle frame (#14) ------------------------------------------------------------------------------

/** Ladder chassis of an electric buggy, nose towards -z. The right rail is snapped and its front half bent down.
 *  Battery tray between the rails at the front: a screwed lid with a pry seam over up to three cells, each held by
 *  a strap and its lead. Seat pan in the middle, screwed to four posts, over the chokes (coils). Behind it the
 *  controller plate with finned heat sinks, held by spring clips and their screws. Hub motors at the wheels: the
 *  rear right one on its axle nut and caliper bolts, a spare front-left hub, phase leads running to the
 *  controller. The motors' axle nuts face outwards, so the frame has to be turned to reach both sides. */
export function vehicleFrame(k: Kit) {
  const THREE = k.shapes;
  const g = k.grade;
  const RY = 0.44; // rail centre height
  // rails and cross members
  k.box(0.14, 0.14, 3.0, -0.68, RY - 0.07, 0, 'body');
  k.box(0.14, 0.14, 1.7, 0.68, RY - 0.07, 0.65, 'body');
  const broken = k.box(0.14, 0.14, 1.3, 0.78, 0, -0.78, 'body');
  broken.position.y = RY - 0.25;
  broken.rotation.set(-0.3, 0.08, 0.06);
  k.box(0.16, 0.08, 0.16, 0.7, RY - 0.08, -0.22, 'accent'); // torn end
  k.box(1.5, 0.12, 0.12, 0, RY - 0.06, 1.42, 'trim');
  k.box(1.5, 0.1, 0.1, 0, RY - 0.05, 0.02, 'trim');
  const front = k.box(0.8, 0.1, 0.1, -0.3, RY - 0.05, -1.3, 'trim');
  front.rotation.set(0.25, 0, -0.18);
  // roll hoop, snapped at the top
  k.rod([-0.64, RY, 1.45], [-0.62, 1.2, 1.4], 0.05, 'yellow');
  k.rod([-0.62, 1.2, 1.4], [-0.15, 1.34, 1.42], 0.05, 'yellow');
  k.rod([0.64, RY, 1.45], [0.6, 0.85, 1.3], 0.05, 'yellow');
  k.rod([0.6, 0.85, 1.3], [0.2, 0.7, 0.95], 0.05, 'yellow');

  // rear axle: flat tyre on the left, hub motor on the right
  k.rod([-1.0, 0.4, 1.65], [0.95, 0.4, 1.65], 0.04, 'trim');
  k.cyl(0.4, 0.28, -0.98, 0.4, 1.65, 'black', 'x', 14);
  k.cyl(0.22, 0.3, -0.98, 0.4, 1.65, 'trim', 'x', 12);
  k.box(0.08, 0.5, 0.3, 0.68, 0.18, 1.65, 'trim'); // hub carrier
  // front axle, bent, with a bare hub on the left
  k.rod([-1.0, 0.36, -1.3], [0.25, 0.4, -1.32], 0.05, 'trim');
  k.box(0.08, 0.45, 0.3, -0.76, 0.15, -1.3, 'trim');

  // controller plate behind the seat; phase leads from the motors run to it
  const CY = RY + 0.03, CZ = 0.95;
  k.box(1.5, 0.03, 0.46, 0, RY, CZ, 'dark');
  k.box(0.5, 0.14, 0.4, 0.35, CY, CZ, 'trim');
  k.box(0.5, 0.14, 0.4, -0.35, CY, CZ, 'trim');
  const phase = k.wire(S.phaseLead, [[0.55, CY + 0.12, CZ + 0.18], [0.75, 0.62, 1.35], [0.8, 0.5, 1.6]], 'red', [], 0.03);
  k.cable([[0.6, CY + 0.12, CZ + 0.05], [0.85, 0.66, 1.3], [0.86, 0.46, 1.58]], 0.03, 'yellow');
  for (const x of [0.35, -0.35]) {
    k.mount('heatsink', [[x, CY + 0.14, CZ], [0, 0, 0]], () => [k.clip(S.springClip, [x - 0.3, CY + 0.38, CZ], [-1, 0, 0])]);
  }

  // rear hub motor on its axle nut and a caliper bolt; the spare front hub on the other side
  const axleNut = k.bolt(S.axleNut, [1.25, 0.4, 1.65], [1, 0, 0], [phase], 3);
  k.mount('motor', [[0.98, 0.22, 1.65], [0, 0, Math.PI / 2]], () => [phase, axleNut, k.bolt(S.caliperBolt, [0.74, 0.62, 1.65], [0, 1, 0], [], 2)]);
  k.mount('motor', [[-1.0, 0.18, -1.3], [0, 0, -Math.PI / 2]], () => {
    const lead = k.wire(S.phaseLead, [[-0.85, 0.5, -1.2], [-0.7, 0.6, -0.4], [-0.55, CY + 0.1, CZ - 0.1]], 'red', [], 0.03);
    return [lead, k.bolt(S.hubNut, [-1.27, 0.4, -1.3], [-1, 0, 0], [lead], 3)];
  });

  // seat pan on four posts over the chokes
  k.box(1.36, 0.04, 0.7, 0, RY, 0.5, 'dark');
  for (const [x, z] of [[-0.42, 0.22], [0.42, 0.22], [-0.42, 0.78], [0.42, 0.78]]) k.cyl(0.04, 0.5, x, RY, z, 'trim');
  const seat = new THREE.Group();
  seat.position.set(0, RY + 0.53, 0.5);
  seat.rotation.set(-0.06, 0.1, 0.03);
  k.add(seat);
  k.mesh(new THREE.BoxGeometry(1.0, 0.05, 0.82), 'accent', 0, 0, 0, seat);
  k.mesh(new THREE.BoxGeometry(0.9, 0.12, 0.08), 'accent', 0, 0.06, 0.38, seat);
  const seatScrews = [[-1, -1], [1, 1]].map(([sx, sz]) => k.screw(S.seatScrew, [sx * 0.42, RY + 0.58, 0.5 + sz * 0.28]));
  k.cover(seat, seatScrews, [0.2, 1, 0], 0.03);
  for (const x of [-0.25, 0.25]) {
    k.mount('coil', [[x, RY + 0.02, 0.5], [0, 0, 0]], () => [
      k.bolt(S.chokeBolt, [x, RY + 0.02, 0.5], [0, -1, 0], [], 2), // from underneath: turn the frame over
    ]);
  }

  // battery tray at the front: lid over up to three cells, strapped down and wired together
  k.box(1.2, 0.04, 1.0, 0, RY - 0.19, -0.5, 'trim');
  k.bay(0, -0.5, 1.2, 1.0, RY - 0.15, 0.5);
  k.cable([[0, RY + 0.2, -0.05], [0, RY + 0.35, 0.3], [-0.2, CY + 0.12, CZ - 0.1]], 0.04, 'red');
  const cells: [number, number][] = [[-0.29, -0.76], [0.29, -0.76], [0, -0.25]];
  for (const [x, z] of cells) {
    k.mount('battery', [[x, RY - 0.15, z], [0, 0, 0]], () => [k.clip(S.cellStrap, [x, RY + 0.27, z], [0, 1, 0])]);
  }
  if (g >= 2) k.lamps(4, -0.3, RY + 0.17, CZ + 0.21, 0.2);
}

// ---- broken water jet (#17) ----------------------------------------------------------------------------------

/** A jet ski lying in the sand, bow towards -z. The seat is gone from the model, so here it is the lid of the bay:
 *  a latch at the back and two seat bolts at the front. In the bay: the batteries, strapped and wired, and the
 *  drive motor on two mount bolts, its shaft coupling reached through the intake grate under the hull (turn it
 *  over). A screwed hatch on the stern deck covers the bilge pump motor. */
export function waterJet(k: Kit) {
  const THREE = k.shapes;
  const g = k.grade;
  const DY = 0.6; // deck height
  // hull, deck, bow
  k.box(1.1, DY - 0.08, 2.5, 0, 0.08, 0.25, 'body');
  k.box(0.8, 0.08, 2.4, 0, 0, 0.25, 'trim'); // keel
  k.box(1.14, 0.08, 2.54, 0, DY * 0.45, 0.25, 'accent'); // stripe
  k.box(1.0, 0.04, 2.4, 0, DY, 0.25, 'dark'); // deck mats
  const bow = new THREE.ConeGeometry(0.62, 1.1, 4, 1).rotateY(Math.PI / 4).rotateX(-Math.PI / 2).scale(1.25, 0.84, 1);
  k.mesh(bow, 'body', 0, DY * 0.55, -1.55);
  // steering post, bent handlebar, gauge pod
  k.rod([0, DY, -0.55], [0, 1.25, -0.72], 0.06, 'trim');
  k.rod([-0.62, 1.15, -0.72], [0.0, 1.3, -0.72], 0.035, 'trim');
  k.rod([0.0, 1.3, -0.72], [0.6, 1.28, -0.75], 0.035, 'trim');
  k.cyl(0.05, 0.26, 0.72, 1.28, -0.75, 'black', 'x', 10);
  k.box(0.36, 0.1, 0.2, 0, 1.25, -0.82, 'dark');
  // jet nozzle and ride plate at the stern
  k.cyl(0.16, 0.3, 0, 0.3, 1.62, 'accent', 'z', 12);
  k.box(0.68, 0.05, 0.6, 0, 0, 1.2, 'trim');

  // seat pedestal: walls on the deck, the seat on top as the bay's lid
  const z0 = -0.2, z1 = 1.1, W = 0.8, H = 0.45, t = 0.06, zc = (z0 + z1) / 2, d = z1 - z0;
  k.box(W, H, t, 0, DY, z0 + t / 2, 'trim');
  k.box(W, H, t, 0, DY, z1 - t / 2, 'trim');
  k.box(t, H, d - 2 * t, -W / 2 + t / 2, DY, zc, 'trim');
  k.box(t, H, d - 2 * t, W / 2 - t / 2, DY, zc, 'trim');
  const seat = new THREE.Group();
  seat.position.set(0, DY + H + 0.09, zc);
  k.add(seat);
  k.mesh(new THREE.BoxGeometry(0.84, 0.18, d + 0.04), 'black', 0, 0, 0, seat);
  k.mesh(new THREE.BoxGeometry(0.7, 0.03, d - 0.1), 'brown', 0, 0.1, 0, seat);
  const latch = k.clip(S.seatClip, [0, DY + H - 0.12, z1 + 0.01], [0, 0, 1]);
  const seatBolts = [k.screw(S.seatBolt, [0, DY + H + 0.18, z0 + 0.1])];
  k.cover(seat, [latch, ...seatBolts], [0, 1, 0.3], 0.09);

  // in the bay: batteries in front, the drive motor behind them
  for (const z of [-0.03, 0.34]) {
    k.mount('battery', [[0, DY, z], [0, 0, 0]], () => {
      k.cable([[0.18, DY + 0.42, z], [0.25, DY + 0.38, (z + 0.75) / 2], [0.12, DY + 0.38, 0.72]], 0.03, 'red');
      return [k.clip(S.batteryStrap, [-0.12, DY + 0.42, z], [0, 1, 0])];
    });
  }
  k.box(0.5, 0.03, 0.2, 0, DY, 1.25 - 0.05, 'dark');
  // intake grate under the hull, over the drive shaft coupling
  const grate = new THREE.Group();
  grate.position.set(0, -0.02, 1.0);
  k.add(grate);
  k.mesh(new THREE.BoxGeometry(0.44, 0.03, 0.5), 'trim', 0, 0, 0, grate);
  for (const x of [-0.12, 0, 0.12]) k.mesh(new THREE.BoxGeometry(0.03, 0.04, 0.46), 'dark', x, -0.02, 0, grate);
  const grateScrews = k.rect(S.grateScrew, [0, -0.04, 1.0], [0, -1, 0], 0.34, 0.4);
  k.cover(grate, grateScrews, [0, -1, 0], 0.02);
  k.mount('motor', [[0, DY, 0.8], [0, Math.PI / 2, 0]], () => [
    k.wire(S.phaseLead, [[-0.16, DY + 0.38, 0.75], [-0.25, DY + 0.4, 0.4], [-0.2, DY + 0.36, 0.1]], 'yellow', [], 0.03),
    k.bolt(S.motorMountBolt, [0.28, DY + 0.04, 0.8], [0, 1, 0], [], 2),
    k.screw(S.shaftCoupling, [0, 0.0, 0.92], [0, -1, 0], grateScrews), // only through the intake grate
  ]);

  // stern hatch over the bilge pump motor
  k.bay(0, 1.32, 0.76, 0.44, DY, 0.42, { screws: 0, pry: true });
  k.cable([[-0.2, DY + 0.34, 1.3], [-0.3, DY + 0.5, 1.18], [-0.32, DY + 0.38, 1.02]], 0.025, 'blue');
  k.mount('motor', [[0, DY + 0.02, 1.32], [0, 0, 0]], () => [k.clip(S.pumpBracket, [0.3, DY + 0.2, 1.32], [1, 0, 0])]);
  if (g >= 2) k.lamps(3, -0.1, 1.3, -0.92, 0.1);
}

// ---- warp drive core (#16) -----------------------------------------------------------------------------------

/** The reactor column lying on its side in a bent cradle, axis along x: the capped end at -x, torn off at +x,
 *  the middle section breached so the core glows through. On top of the capped section: the fin bank, up to three
 *  heat sinks under a screwed shroud, each on a coolant clamp and a bolt. On the +z flank: the compute rack, a door
 *  on four screws and a pry seam, two rack bolts from underneath, a card latch on every board. On the -z flank of
 *  the torn section: the uranium cells, clamped in their cage; vent the coolant first. */
export function warpCore(k: Kit) {
  const THREE = k.shapes;
  const g = k.grade;
  const AY = 0.62, R = 0.5;
  const oct = (r: number, len: number, x: number, key: 'body' | 'trim' | 'accent' | 'dark' | 'glow') =>
    k.mesh(new THREE.CylinderGeometry(r, r, len, 8).rotateY(Math.PI / 8).rotateZ(Math.PI / 2), key, x, AY, 0);
  // cradle skids
  for (const x of [-0.75, 0.6]) {
    k.box(0.16, 0.08, 1.2, x, 0, 0, 'trim');
    for (const z of [-0.38, 0.38]) k.box(0.12, 0.3, 0.1, x, 0.06, z, 'trim');
  }
  // glowing core inside, with coil rings
  k.cyl(0.24, 2.3, 0.0, AY, 0, 'glow', 'x', 12);
  for (let i = 0; i < 6; i++) k.cyl(0.32, 0.06, -0.3 + i * 0.2, AY, 0, 'dark', 'x', 12);
  // housing: capped section, breached middle (lower half only), torn section
  oct(R, 0.85, -0.78, 'body');
  k.shell(R, 0.5, [-0.1, AY, 0], 'x', 'lower', 'body');
  oct(R, 0.6, 0.45, 'body');
  k.shell(R * 0.98, 0.2, [0.85, AY, 0], 'x', 'full', 'dark');
  for (const x of [-0.36, 0.15]) oct(R + 0.05, 0.08, x, 'trim');
  if (g >= 2) for (const x of [-0.3, 0.21]) oct(R + 0.012, 0.025, x, 'glow');
  // capped end: taper, coupling flange and stub
  k.mesh(new THREE.CylinderGeometry(R * 0.7, R, 0.18, 8).rotateY(Math.PI / 8).rotateZ(Math.PI / 2), 'trim', -1.29, AY, 0);
  k.cyl(0.22, 0.08, -1.42, AY, 0, 'trim', 'x');
  k.cyl(0.13, 0.14, -1.53, AY, 0, 'copper', 'x', 12);
  // cables spilling out of the torn end
  k.cable([[0.85, AY + 0.1, 0.1], [1.1, AY - 0.1, 0.15], [1.25, 0.05, 0.3], [1.45, 0.03, 0.35]], 0.03);
  k.cable([[0.85, AY - 0.05, -0.1], [1.12, AY - 0.25, -0.2], [1.3, 0.04, -0.25]], 0.03, 'red');

  // fin bank on top of the capped section, under a shroud
  const TOP = AY + R * Math.cos(Math.PI / 8);
  k.box(0.95, 0.05, 0.5, -0.78, TOP, 0, 'trim');
  const coolant = k.wire(S.coolantLine, [[-1.3, AY + 0.25, 0.15], [-1.3, TOP + 0.2, 0.15], [-1.1, TOP + 0.44, 0.15], [-0.4, TOP + 0.44, 0.15]], 'copper', [], 0.035);
  const shroud = new THREE.Group();
  shroud.position.set(-0.78, TOP + 0.5, 0);
  k.add(shroud);
  k.mesh(new THREE.BoxGeometry(1.0, 0.04, 0.56), 'body', 0, 0, 0, shroud);
  for (const z of [-0.27, 0.27]) k.mesh(new THREE.BoxGeometry(1.0, 0.44, 0.03), 'body', 0, -0.22, z, shroud);
  if (g >= 3) k.mesh(new THREE.BoxGeometry(0.8, 0.02, 0.04), 'glow', 0, 0.03, 0, shroud);
  k.cover(shroud, k.rect(S.shroudScrew, [-0.78, TOP + 0.53, 0], [0, 1, 0], 0.84, 0.4), [0, 1, 0.2], 0.22);
  for (const x of [-1.08, -0.78, -0.48]) {
    k.mount('heatsink', [[x, TOP + 0.05, 0], [0, Math.PI / 2, 0]], () => [coolant, k.clip(S.coolantClamp, [x, TOP + 0.36, 0.15], [0, 1, 0])]);
  }

  // compute rack on the +z flank: shelves of boards behind a door
  const RX = -0.78, RZ = 0.73;
  for (const x of [RX - 0.33, RX + 0.33]) k.box(0.04, 0.84, 0.46, x, AY - 0.42, RZ, 'trim');
  for (let i = 0; i < 4; i++) k.box(0.62, 0.03, 0.44, RX, AY - 0.44 + i * 0.27, RZ, 'dark');
  const rackBolts = [k.bolt(S.rackBolt, [RX, AY - 0.45, RZ], [0, -1, 0], [], 2)];
  const door = new THREE.Group();
  door.position.set(RX, AY - 0.02, RZ + 0.25);
  k.add(door);
  k.mesh(new THREE.BoxGeometry(0.7, 0.86, 0.04), 'body', 0, 0, 0, door);
  k.mesh(new THREE.BoxGeometry(0.5, 0.04, 0.02), g >= 1 ? 'accent' : 'trim', 0, 0.3, 0.025, door);
  const seam = k.pry(S.doorSeam, [RX + 0.35, AY - 0.02, RZ + 0.27], [1, 0, 0]);
  k.cover(door, [seam, ...rackBolts], [0, 0.2, 1], 0.02);
  for (let i = 0; i < 3; i++) {
    const y = AY - 0.41 + i * 0.27;
    k.mount('compute', [[RX, y, RZ - 0.02], [0, 0, 0]], () => [k.clip(S.cardLatch, [RX + 0.18, y + 0.1, RZ + 0.2], [0, 0, 1])]);
  }
  if (g >= 2) k.lamps(3, RX - 0.2, AY + 0.42, RZ + 0.27, 0.2);

  // uranium cells in a cage on the -z flank of the torn section; vent the coolant before touching them
  const BZ = -0.68;
  k.box(0.8, 0.05, 0.36, 0.5, AY - 0.12, BZ, 'trim');
  k.box(0.8, 0.04, 0.06, 0.5, AY + 0.3, BZ - 0.17, 'trim'); // cage band
  const vent = k.pry(S.fieldVent, [0.5, AY - 0.1, BZ - 0.2], [0, 0, -1]);
  for (const x of [0.32, 0.68]) {
    k.mount('uranium', [[x, AY - 0.07, BZ], [0, 0, 0]], () => [vent, k.bolt(S.cageClamp, [x, AY + 0.32, BZ - 0.2], [0, 0, -1], [vent], 2)]);
  }
}

// ---- AI control system (#15) ---------------------------------------------------------------------------------

/** A rack cabinet standing on its plinth, front towards +z. Compute modules slide into the front, each held by
 *  two faceplate screws (the first two also by the ribbon to the backplane). The big heat sinks are bolted to the
 *  right side (+x) where the panel has rusted away, all on one copper coolant loop from the roof. On the roof the
 *  fan hood, screwed down, over the power supply's choke (a coil). */
export function aiControl(k: Kit) {
  const THREE = k.shapes;
  const g = k.grade;
  const W = 1.2, D = 1.0, H = 2.0, T = 0.05, P = 0.16;
  k.box(W + 0.04, P, D + 0.04, 0, 0, 0, 'trim');
  k.box(T, H - P, D, -W / 2 + T / 2, P, 0, 'body'); // left side
  k.box(W, H - P, T, 0, P, -D / 2 + T / 2, 'body'); // back
  k.box(W + 0.04, T, D + 0.04, 0, H, 0, 'body'); // roof
  k.box(T, 0.4, D - 0.06, W / 2 - T / 2, P, 0, 'body'); // right side, lower panel only
  k.box(W - 2 * T, H - P - 0.1, 0.04, 0, P + 0.05, -D / 2 + T + 0.02, 'dark'); // dark inside of the back
  for (const x of [-W / 2 + 0.03, W / 2 - 0.03]) k.box(0.06, H - P, 0.06, x, P, D / 2 - 0.03, 'trim'); // front posts
  k.box(0.06, H - P, 0.06, W / 2 - 0.03, P, -D / 2 + 0.03, 'trim');
  // top bezel: the dead eye and a cracked screen
  k.box(W - 0.06, 0.28, 0.06, 0, H - 0.3, D / 2 - 0.03, 'trim');
  k.cyl(0.11, 0.05, -0.3, H - 0.16, D / 2 + 0.02, 'dark', 'z', 16);
  k.cyl(0.08, 0.06, -0.3, H - 0.16, D / 2 + 0.03, g >= 2 ? 'glow' : 'red', 'z', 16);
  k.box(0.46, 0.18, 0.02, 0.22, H - 0.25, D / 2 + 0.01, 'chip');

  // compute modules in the front slots, ribbons to the backplane
  for (let i = 0; i < 4; i++) {
    const y = P + 0.06 + i * 0.34;
    k.box(W - 2 * T, 0.03, D - 0.2, 0, y - 0.03, 0.0, 'trim'); // slot rail
    k.mount('compute', [[0, y, 0.15], [0, 0, 0]], () => {
      if (i < 2) k.cable([[-0.15, y + 0.12, 0.1], [-0.2, y + 0.2, -0.1], [-0.25, y + 0.18, -0.4]], 0.025, 'blue'); // ribbon
      return [k.screw(S.faceplateScrew, [0.45, y + 0.1, D / 2 + 0.01], [0, 0, 1])];
    });
  }

  // heat sinks on the right side, fins out along +x, on one coolant loop
  const loop = k.wire(S.coolantPipe, [[0.0, H + 0.06, -0.38], [0.45, H + 0.06, -0.4], [0.7, H - 0.1, -0.42], [0.82, 0.7, -0.42]], 'copper', [], 0.035);
  k.box(0.04, 1.5, D - 0.08, W / 2 + 0.02, 0.5, 0, 'trim'); // base plate
  for (const y of [0.75, 1.25, 1.75]) {
    k.mount('heatsink', [[W / 2 + 0.04, y, 0], [0, 0, -Math.PI / 2]], () => [loop, k.bolt(S.heatSinkBolt, [W / 2 + 0.06, y, 0.38], [1, 0, 0], [], 2)]);
  }

  // fan hood on the roof over the power supply choke, clipped down on its top (under the hood, facing up)
  k.bay(-0.1, 0.02, 0.72, 0.72, H + T, 0.5);
  k.cable([[0.08, H + T + 0.4, 0.02], [0.18, H + T + 0.3, -0.15], [0.2, H + T + 0.05, -0.25]], 0.03, 'brown'); // supply lead
  k.mount('coil', [[-0.1, H + T, 0.02], [0, 0, 0]], () => [k.clip(S.chokeClip, [-0.1, H + T + 0.47, 0.02], [0, 1, 0])]);
  if (g >= 2) k.lamps(4, 0.06, H - 0.12, D / 2 + 0.01, 0.08);
}

// ---- pump housing ------------------------------------------------------------------------------------------

/** End-suction centrifugal pump on a skid, motor-driven through a guarded coupling.
 *  Front (-x): suction cover held by a bolt circle (drain the casing first: the plug is underneath) over the
 *  impeller. Middle: bearing housing with a prised-on inspection lid over two bearings, a valve in the discharge.
 *  Back (+x): latched coupling guard, the motor hub's set screw, the motor on its pedestal, and its terminal box:
 *  supply through a gland, live via a contactor to the terminals, neutral. */
function pumpHousing(k: Kit) {
  const THREE = k.shapes;
  const g = k.grade;
  const SY = 0.62; // shaft height
  k.box(3.7, 0.15, 0.95, 0.3, 0, 0, 'trim');
  for (const [x, z] of [[-1.4, -0.38], [-1.4, 0.38], [2.0, -0.38], [2.0, 0.38]]) k.stud(x, 0.17, z, 0.06);
  k.rod([-0.95, SY, 0], [1.75, SY, 0], 0.045, 'copper');

  // volute casing with a back wall; discharge goes straight up from the top
  k.shell(0.42, 0.5, [-0.75, SY, 0], 'x', 'full', 'body');
  k.cyl(0.42, 0.04, -0.5, SY, 0, 'body', 'x');
  k.box(0.5, 0.14, 0.5, -0.75, 0.15, 0, 'trim'); // foot
  if (g >= 2) k.ring(0.43, 0.025, -0.52, SY, 0, 'accent', 'x');
  if (g >= 3) k.ring(0.43, 0.02, -0.98, SY, 0, 'glow', 'x');
  // On the casing's flank, low down: the big machines can't be turned over, so every step faces somewhere you can walk to.
  const drain = k.bolt(S.drainPlug, [-0.75, SY - 0.2, 0.37], [0, 0, 1], [], 2);

  // suction cover: disc, suction nozzle, inlet flange
  const cov = k.group([-1.03, SY, 0]);
  k.mesh(new THREE.CylinderGeometry(0.44, 0.44, 0.06, 32).rotateZ(Math.PI / 2), 'body', 0, 0, 0, cov);
  k.mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.4, 20).rotateZ(Math.PI / 2), 'body', -0.28, 0, 0, cov);
  k.mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.05, 28).rotateZ(Math.PI / 2), 'trim', -0.5, 0, 0, cov);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    k.mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.09, 6).rotateZ(Math.PI / 2), 'trim', -0.5, Math.cos(a) * 0.24, Math.sin(a) * 0.24, cov); // inlet flange studs
  }
  const coverBolts = k.circle(S.coverBolt, [-1.065, SY, 0], [-1, 0, 0], 0.36, 4, [drain], 'bolt', Math.PI / 4);
  k.cover(cov, coverBolts, [-1, 0.25, 0], 0.44);
  // impeller on the shaft, behind the cover, held by its nut
  k.mount('impeller', k.ax('impeller', [-0.78, SY, 0], 'x'), () => [k.bolt(S.impellerNut, [-0.96, SY, 0], [-1, 0, 0], [], 3)]);

  // discharge with the check valve between two flanges
  k.cyl(0.13, 0.12, -0.75, 1.0, 0, 'body');
  k.cyl(0.42, 0.04, -0.75, 1.06, 0, 'trim', 'y', 32);
  const valve = k.take('valve');
  if (valve) {
    const bolts = k.circle(S.valveFlangeBolt, [-0.75, 1.1, 0], [0, 1, 0], 0.34, 2, [], 'bolt', Math.PI / 4);
    k.part('valve', valve, [-0.75, 1.1, 0], bolts);
  } else k.cyl(0.12, 0.5, -0.75, 1.1, 0, 'body'); // plain spool piece
  k.cyl(0.12, 0.25, -0.75, 1.6, 0, 'body');
  k.cyl(0.28, 0.04, -0.75, 1.82, 0, 'trim', 'y', 24);

  // bearing housing: lid prised off its seam, over two bearings, each held by a retaining clip
  k.bay(0.275, 0, 0.95, 0.46, 0.15, 0.71, { screws: 0, pry: true });
  for (const x of [0.0, 0.5]) {
    k.mount('bearing', k.ax('bearing', [x, SY, 0], 'x'), () => [k.clip(S.bearingRetainer, [x, SY + 0.27, 0], [0, 1, 0], 2)]);
  }
  k.box(0.1, 0.1, 0.04, 0.275, 0.4, 0.25, g >= 1 ? 'accent' : 'dark'); // oil sight glass
  k.ring(0.06, 0.012, 0.275, 0.45, 0.28, 'copper', 'z');

  // coupling: two hubs with a spider between; the set screw on the motor hub holds the motor on
  k.cyl(0.1, 0.14, 0.9, SY, 0, 'trim', 'x');
  k.cyl(0.12, 0.12, 1.075, SY, 0, 'dark', 'x');
  k.cyl(0.1, 0.14, 1.25, SY, 0, 'trim', 'x');
  k.stud(0.9, SY + 0.1, 0, 0.04);
  const setMotor = k.screw(S.hubSetScrew, [1.25, SY + 0.1, 0]);
  const guard = k.group([1.075, SY, 0]);
  k.shell(0.22, 0.65, [0, 0, 0], 'x', 'upper', 'accent', guard);
  for (const z of [-0.25, 0.25]) k.box(0.65, 0.03, 0.08, 0, -0.01, z, 'accent', guard);
  k.cover(guard, [k.clip(S.guardLatch, [1.075, SY + 0.25, 0], [0, 1, 0])], [0, 1, 0], 0.2);

  // motor on a pedestal, its feet bolted down at the corners
  k.box(0.78, 0.22, 0.7, 1.9, 0.15, 0, 'trim');
  k.box(0.7, 0.05, 0.66, 1.9, 0.37, 0, 'body');
  // terminal box on top: gland on the +z wall, contactor on a rail, terminal block along the far wall
  k.bay(1.9, 0, 0.8, 0.5, 0.95, 0.36);
  k.box(0.7, 0.03, 0.38, 1.9, 0.95, 0, 'dark');
  k.cyl(0.06, 0.12, 1.7, 1.1, 0.3, 'trim', 'z');
  k.cable([[1.7, 1.1, 0.36], [1.7, 1.0, 0.65], [1.0, 0.18, 0.66], [-0.2, 0.18, 0.66]], 0.045);
  k.box(0.04, 0.03, 0.4, 2.1, 0.98, 0, 'trim'); // terminal block rail
  for (const z of [-0.15, 0, 0.15]) k.box(0.1, 0.1, 0.08, 2.1, 1.0, z, 'yellow');
  const G: V = [1.7, 1.1, 0.25];
  const relayTier = k.take('relay');
  const neutral = k.wire(S.neutral, [[1.72, 1.08, 0.25], [1.9, 1.04, 0.2], [2.06, 1.04, 0.0]], 'blue');
  k.cable([[1.76, 1.06, 0.25], [1.95, 1.02, 0.24], [2.1, 1.06, 0.15]], 0.035, 'green'); // earth
  const liveToMotor = k.wire(S.liveToMotor, [[1.88, 1.26, 0.1], [1.98, 1.22, -0.02], [2.1, 1.06, -0.15]], 'brown');
  if (relayTier) {
    const liveIn = k.wire(S.liveIn, [G, [1.69, 1.2, 0.18], [1.68, 1.26, 0.1]], 'brown');
    const din = k.clip(S.railClip, [1.78, 0.98, 0.21], [0, 1, 0]);
    k.part('relay', relayTier, [1.78, 0.98, 0], [din, liveIn, liveToMotor]);
  } else k.cable([[G[0], G[1], G[2]], [1.8, 1.2, 0.1], [1.88, 1.26, 0.1]], 0.035, 'brown'); // straight through
  const motorHolds = [setMotor, liveToMotor, neutral];
  const feet = [[-1, -1], [1, 1]].map(([sx, sz]) => k.bolt(S.motorFootBolt, [1.9 + sx * 0.31, 0.42, sz * 0.28], [0, 1, 0], motorHolds, 2));
  // the motor is heavy: once the feet are free, a long hold heaves it off (HEAVY_LIFT_S)
  k.mount('motor', [[1.9, 0.42, 0], [0, 0, 0]], () => [...motorHolds, ...feet, k.lift(S.liftTheMotorOff, [2.17, 0.67, 0], [1, 0, 0], feet, HEAVY_LIFT_S)]);
  if (g >= 3) k.lamps(4, 1.65, 0.45, 0.4, 0.2);
}

// ---- jet engine --------------------------------------------------------------------------------------------

/** Small turbojet on a stand. Compressor casing split along the horizontal: a row of bolts down each side
 *  (the far side needs a turn), over two bearings in pillow blocks. Accessory gearbox under the front with a side
 *  cover over two gears and the starter motor flanged to its back. Fuel valve on the combustor feed line,
 *  igniter coil on the combustor. Beside it the control box: ECU on standoffs, a heatsink on its power stage, the
 *  starter relay; harness cables run from three round connectors on its wall out to the starter, valve and igniter. */
function jetEngine(k: Kit) {
  const THREE = k.shapes;
  const g = k.grade;
  const AY = 0.95;
  k.box(3.3, 0.12, 2.4, 0.2, 0, 0.3, 'trim');
  for (const x of [-1.05, 0.45, 1.1]) {
    k.box(0.2, 0.43, 0.7, x, 0.12, 0, 'body');
    k.ring(0.43, 0.025, x, AY, 0, 'trim', 'x');
  }
  k.rod([-1.1, AY, 0], [1.4, AY, 0], 0.06, 'copper');

  // intake and nose cone
  k.shell(0.46, 0.45, [-1.12, AY, 0], 'x', 'full', 'trim');
  k.mesh(new THREE.ConeGeometry(0.17, 0.45, 20).rotateZ(Math.PI / 2), 'accent', -1.3, AY, 0);
  for (let i = 0; i < 10; i++) {
    const b = k.box(0.03, 0.34, 0.1, -1.05, 0, 0, 'dark');
    b.position.set(-1.05, AY, 0);
    b.geometry.translate(0, 0.22, 0);
    b.rotation.x = (i / 10) * Math.PI * 2;
  }

  // compressor casing: lower half is the body, the upper half comes off
  k.shell(0.42, 1.0, [-0.4, AY, 0], 'x', 'lower', 'body');
  for (const z of [-1, 1]) k.box(1.0, 0.04, 0.1, -0.4, AY - 0.02, z * 0.47, 'body');
  for (let i = 0; i < 5; i++) k.cyl(0.3 - i * 0.02, 0.03, -0.8 + i * 0.17, AY, 0, 'dark', 'x'); // rotor discs
  const top = k.group([-0.4, AY, 0]);
  k.shell(0.42, 1.0, [0, 0, 0], 'x', 'upper', 'body', top);
  for (const z of [-1, 1]) k.box(1.0, 0.04, 0.1, 0, 0, z * 0.47, 'body', top);
  const split: Step[] = [];
  for (const z of [-1, 1]) split.push(...k.row(S.splitLineBolt, [-0.7, AY + 0.02, z * 0.47], [-0.1, AY + 0.02, z * 0.47], 2, [0, 1, 0]));
  // the upper casing is heavy: once the flange bolts are out, a long hold heaves it clear (HEAVY_LIFT_S)
  k.cover(top, [...split, k.lift(S.liftTheCasingOff, [-0.4, AY + 0.46, 0], [0, 1, 0], split, HEAVY_LIFT_S)], [0, 1, 0.1], 0.45);
  // bearings on pedestals under cap blocks, one screw each
  for (const x of [-0.75, -0.1]) {
    k.box(0.26, 0.16, 0.4, x, 0.55, 0, 'trim');
    const cap = k.group([x, AY + 0.27, 0]);
    k.mesh(new THREE.BoxGeometry(0.28, 0.06, 0.46), 'trim', 0, 0, 0, cap);
    const screws = [k.screw(S.bearingCapScrew, [x, AY + 0.3, 0.2])];
    k.cover(cap, screws, [0, 1, 0], 0.03);
    k.mount('bearing', k.ax('bearing', [x, AY, 0], 'x'), () => screws);
  }

  // combustor with manifold, injectors, and the igniter coil on its top
  k.cyl(0.4, 0.65, 0.42, AY, 0, 'body', 'x');
  k.ring(0.41, 0.03, 0.55, AY, 0, 'copper', 'x');
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    k.rod([0.55, AY + Math.cos(a) * 0.41, Math.sin(a) * 0.41], [0.55, AY + Math.cos(a) * 0.5, Math.sin(a) * 0.5], 0.025, 'copper');
  }
  k.box(0.74, 0.04, 0.44, 0.4, AY + 0.4 - 0.02, 0, 'trim');
  const igniterLead = k.wire(S.igniterLead, [[0.4, 1.62, 0.05], [0.3, 1.45, 0.3], [0.2, 0.9, 0.7], [0.0, 0.34, 0.72]], 'black', [], 0.03);
  k.mount('coil', [[0.4, AY + 0.4 + 0.02, 0], [0, 0, 0]], () => [igniterLead, k.bolt(S.igniterBolt, [0.7, AY + 0.43, 0], [0, 1, 0], [igniterLead], 2)]);

  // turbine and nozzle
  k.cyl(0.36, 0.55, 1.03, AY, 0, 'body', 'x');
  k.mesh(new THREE.CylinderGeometry(0.34, 0.24, 0.45, 28).rotateZ(Math.PI / 2), 'trim', 1.55, AY, 0);
  if (g >= 2) k.ring(0.37, 0.02, 0.76, AY, 0, 'accent', 'x');
  if (g >= 3) k.ring(0.25, 0.02, 1.78, AY, 0, 'glow', 'x');

  // fuel valve on the feed line to the manifold; union nut above and below
  const fuelLine: V[] = [[0.75, 1.0, 0.65], [0.55, 1.0, 0.43]];
  k.rod(fuelLine[0], fuelLine[1], 0.03, 'copper');
  k.rod([0.75, 0.64, 0.65], [0.75, 1.0, 0.65], 0.03, 'copper');
  k.rod([0.75, 0.14, 0.65], [1.4, 0.14, 0.65], 0.03, 'copper');
  const valveLead = k.wire(S.solenoidLead, [[0.78, 0.45, 0.65], [0.4, 0.2, 0.75], [-0.4, 0.3, 0.72]], 'brown', [], 0.03);
  k.mount('valve', [[0.75, 0.14, 0.65], [0, 0, 0]], () => [valveLead, k.bolt(S.unionNut, [0.75, 0.68, 0.65], [0, 1, 0], [valveLead], 2)]);

  // accessory gearbox under the front: open towards +z, closed by a cover; starter flanged on the -z side
  const gb = [-0.45, 0.365, 0] as V;
  k.box(0.7, 0.04, 0.6, gb[0], 0.2, 0, 'trim');
  k.box(0.7, 0.04, 0.6, gb[0], 0.5, 0, 'trim');
  k.box(0.04, 0.3, 0.6, -0.8, 0.22, 0, 'trim');
  k.box(0.04, 0.3, 0.6, -0.1, 0.22, 0, 'trim');
  k.box(0.7, 0.3, 0.04, gb[0], 0.22, -0.3, 'body');
  const cover = k.group([gb[0], gb[1], 0.31]);
  k.mesh(new THREE.BoxGeometry(0.74, 0.34, 0.04), 'body', 0, 0, 0, cover);
  k.cover(cover, k.rect(S.gearboxScrew, [gb[0], gb[1], 0.33], [0, 0, 1], 0.62, 0.26), [0, 0.2, 1], 0.17);
  for (const x of [-0.6, -0.3]) {
    k.rod([x, gb[1], -0.28], [x, gb[1], 0.22], 0.03, 'copper');
    k.mount('gear', k.ax('gear', [x, gb[1], 0], 'z'), () => [k.clip(S.gearClip, [x, gb[1], 0.22], [0, 0, 1])]);
  }
  const sLead = k.wire(S.starterLead, [[-0.35, 0.58, -0.85], [-0.7, 0.16, -0.85], [-1.3, 0.16, -0.1], [-1.2, 0.16, 0.6], [-0.85, 0.3, 0.72]], 'red', [], 0.04);
  k.cable([[-0.25, 0.58, -0.85], [-0.65, 0.16, -0.8], [-1.35, 0.16, -0.1], [-1.25, 0.16, 0.6], [-0.75, 0.3, 0.72]], 0.04, 'black');
  k.cyl(0.34, 0.05, -0.3, gb[1], -0.33, 'trim', 'z');
  k.mount('motor', [[-0.3, 0.12, -0.65], [0, 0, 0]], () => [sLead, ...k.circle(S.starterFlangeBolt, [-0.3, gb[1], -0.36], [0, 0, -1], 0.27, 2, [sLead], 'bolt', Math.PI / 4)]);
  k.rod([-0.3, gb[1], -0.45], [-0.3, gb[1], -0.2], 0.04, 'copper');

  // control box beside the engine
  const cx = -0.35, cz = 1.05;
  k.bay(cx, cz, 1.58, 0.6, 0.12, 0.42);
  k.box(1.4, 0.03, 0.46, cx, 0.12, cz, 'dark');
  for (let i = 0; i < 3; i++) { // round connectors on the wall facing the engine
    const x = -0.8 + i * 0.4;
    k.cyl(0.1, 0.1, x, 0.34, 0.72, 'chip', 'z');
  }
  // contents, left to right: starter relay, ECU on standoffs, power stage with heatsink
  const connector = k.bolt(S.connectorRing, [-0.4, 0.34, 0.68], [0, 0, -1], [], 2);
  k.cable([[-0.2, 0.3, 1.0], [-0.3, 0.32, 0.9], [-0.4, 0.3, 0.8]], 0.025, 'blue'); // ribbon
  k.box(0.56, 0.04, 0.44, -0.45, 0.15, cz, 'pcb');
  k.mount('relay', [[-0.92, 0.15, cz], [0, 0, 0]], () => [
    k.clip(S.railClip, [-0.92, 0.17, cz + 0.2], [0, 1, 0]),
    k.wire(S.relayFeed, [[-0.93, 0.5, 1.0], [-0.9, 0.42, 0.9], [-0.8, 0.3, 0.78]], 'red', [], 0.04),
  ]);
  const standoffs = [[-1, -1], [1, 1]].map(([sx, sz]) => k.screw(S.ecuStandoff, [-0.45 + sx * 0.27, 0.19, cz + sz * 0.2]));
  k.mount('compute', [[-0.45, 0.2, cz], [0, 0, 0]], () => [...standoffs, connector]);
  k.box(0.4, 0.04, 0.4, 0.05, 0.15, cz, 'pcb');
  k.box(0.26, 0.05, 0.26, 0.05, 0.19, cz, 'chip');
  k.mount('heatsink', [[0.05, 0.2, cz], [0, 0, 0]], () => [k.clip(S.springClip, [0.3, 0.55, cz], [0, 1, 0])]);
  if (g >= 2) k.lamps(6, -1.0, 0.12, 1.37, 0.2);
}

// ---- robot arm joint ---------------------------------------------------------------------------------------

/** One joint of a robot arm. A vertical housing: a round top cover on a bolt circle over the output gear, held
 *  by its centre bolt, over a clamp ring (a smaller bolt circle) over the slewing bearing. A side gearbox
 *  on -x with a screwed cover over the idler gears. The servo motor on +x, flanged with four bolts, its power and
 *  encoder cables running along the link into the driver bay on the link: a lid over the controller board, the
 *  driver heatsink and a brake relay; the brake solenoid sits on the base, fed by a long cable. */
function robotArm(k: Kit) {
  const THREE = k.shapes;
  const g = k.grade;
  k.box(1.9, 0.12, 2.25, 0, 0, 0.375, 'trim');
  for (const [x, z] of [[-0.8, -0.65], [0.8, -0.65], [-0.8, 1.4], [0.8, 1.4]]) k.stud(x, 0.14, z, 0.07);

  // housing, with a top cover on a bolt circle; stack inside: bearing, clamp ring, output gear
  k.shell(0.55, 0.88, [0, 0.56, 0], 'y', 'full', 'body');
  k.cyl(0.55, 0.04, 0, 0.12, 0, 'dark', 'y', 32);
  k.ring(0.55, 0.04, 0, 1.0, 0, 'trim', 'y');
  k.cyl(0.57, 0.06, 0, 0.3, 0, 'trim', 'y', 32);
  if (g >= 2) k.ring(0.57, 0.02, 0, 0.7, 0, 'accent', 'y');
  if (g >= 3) k.ring(0.57, 0.015, 0, 0.5, 0, 'glow', 'y');
  const topCover = k.group([0, 1.0, 0]);
  k.mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.05, 36), 'body', 0, 0.025, 0, topCover);
  k.mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.03, 20), 'trim', 0, 0.065, 0, topCover);
  const coverBolts = k.circle(S.topCoverBolt, [0, 1.05, 0], [0, 1, 0], 0.42, 3, [], 'bolt', Math.PI / 6);
  k.cover(topCover, coverBolts, [0, 1, 0], 0.03);
  const gearBolt = k.bolt(S.gearRetainingBolt, [0, 0.85, 0], [0, 1, 0], [], 3);
  const clampRing = k.group([0, 0.6, 0]);
  k.mesh(new THREE.LatheGeometry([new THREE.Vector2(0.2, 0), new THREE.Vector2(0.42, 0), new THREE.Vector2(0.42, 0.04), new THREE.Vector2(0.2, 0.04), new THREE.Vector2(0.2, 0)], 32), 'trim', 0, 0, 0, clampRing);
  const clampBolts = k.circle(S.clampRingBolt, [0, 0.64, 0], [0, 1, 0], 0.34, 3, [gearBolt], 'bolt', -Math.PI / 6);
  k.cover(clampRing, clampBolts, [0, 1, 0], 0.03);
  k.rod([0, 0.15, 0], [0, 0.9, 0], 0.05, 'copper');
  k.mount('gear', k.ax('gear', [0, 0.76, 0], 'y'), () => [gearBolt]);
  k.mount('bearing', k.ax('bearing', [0, 0.45, 0], 'y'), () => clampBolts);

  // side gearbox on -x: bearing and two idler gears on parallel shafts, closed by a screwed plate
  k.box(0.04, 0.65, 1.2, -0.52, 0.25, 0, 'trim');
  k.box(0.46, 0.04, 1.2, -0.75, 0.25, 0, 'trim');
  k.box(0.46, 0.04, 1.2, -0.75, 0.86, 0, 'trim');
  for (const z of [-0.6, 0.6]) k.box(0.46, 0.65, 0.04, -0.75, 0.25, z, 'body');
  const gbCover = k.group([-0.98, 0.575, 0]);
  k.mesh(new THREE.BoxGeometry(0.04, 0.65, 1.2), 'body', 0, 0, 0, gbCover);
  k.cover(gbCover, k.rect(S.gearboxScrew, [-1.0, 0.575, 0], [-1, 0, 0], 1.0, 0.5), [-1, 0.2, 0], 0.33);
  const slots: [number, 'bearing' | 'gear'][] = [[-0.38, 'bearing'], [0, 'gear'], [0.38, 'gear']];
  for (const [z, part] of slots) {
    k.rod([-0.52, 0.575, z], [-0.95, 0.575, z], 0.03, 'copper');
    k.mount(part, k.ax(part, [-0.76 - (part === 'gear' && z > 0 ? 0.12 : 0), 0.575, z], 'x'), () => [k.clip(part === 'gear' ? S.gearClip : S.bearingClip, [-0.9, 0.575, z], [-1, 0, 0])]);
  }

  // servo motor on +x: shelf, adapter plate with four bolts, shaft into the housing; cables run to the driver bay
  k.box(0.6, 0.06, 0.52, 0.95, 0.24, 0, 'trim');
  k.box(0.06, 0.74, 0.74, 0.58, 0.18, 0, 'body');
  k.rod([0.75, 0.55, 0], [0.4, 0.55, 0], 0.045, 'copper');
  const power = k.wire(S.motorPowerCable, [[0.95, 0.82, 0.15], [0.8, 0.95, 0.5], [0.45, 0.98, 0.9], [0.3, 0.98, 1.1], [0.1, 0.96, 1.45]], 'red', [], 0.05);
  const encoder = k.wire(S.encoderCable, [[1.1, 0.7, 0.2], [0.9, 0.85, 0.6], [0.5, 0.9, 1.0], [0.3, 0.92, 1.4], [0.1, 0.92, 1.55]], 'blue', [], 0.025);
  const plate = k.circle(S.motorFlangeBolt, [0.62, 0.55, 0], [1, 0, 0], 0.38, 2, [power, encoder], 'bolt', Math.PI / 4);
  k.mount('motor', [[0.95, 0.3, 0], [0, 0, 0]], () => [power, encoder, ...plate]);

  // the link, and the driver bay on top of it
  k.cyl(0.24, 1.85, 0, 0.55, 1.375, 'body', 'z');
  k.cyl(0.32, 0.06, 0, 0.55, 2.3, 'trim', 'z');
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    k.stud(Math.cos(a) * 0.25, 0.55 + Math.sin(a) * 0.25, 2.34, 0.04);
  }
  k.box(0.8, 0.04, 1.5, 0, 0.78, 1.45, 'trim');
  k.bay(0, 1.45, 0.8, 1.5, 0.82, 0.36, { screws: 0, pry: true });
  k.box(0.7, 0.03, 1.3, 0, 0.82, 1.45, 'pcb');
  const dy = 0.85;
  k.box(0.26, 0.05, 0.26, 0, dy, 1.05, 'chip');
  k.mount('heatsink', [[0, dy + 0.05, 1.05], [0, 0, 0]], () => [k.clip(S.springClip, [0.3, dy + 0.4, 1.05], [0, 1, 0])]);
  const standoffs = [[-1, -1], [1, 1]].map(([sx, sz]) => k.screw(S.boardStandoff, [sx * 0.31, dy, 1.55 + sz * 0.27]));
  k.mount('compute', [[0, dy, 1.55], [0, 0, 0]], () => [...standoffs, encoder]);
  // brake relay in the bay, brake solenoid on the base, joined by one long cable
  k.box(0.8, 0.04, 0.5, -0.65, 0.12, 1.0, 'trim');
  const relayT = k.take('relay'), coilT = k.take('coil');
  const brakeFeed = relayT || coilT ? k.wire(S.brakeFeed, [[-0.2, 1.1, 1.95], [-0.5, 0.9, 1.85], [-0.7, 0.7, 1.4], [-0.65, 0.6, 1.0]], 'yellow', [], 0.03) : null;
  if (relayT && brakeFeed) {
    k.part('relay', relayT, [0, dy, 1.98], [k.clip(S.railClip, [0, dy + 0.3, 2.13], [0, 1, 0]), brakeFeed]);
  }
  if (coilT && brakeFeed) k.part('coil', coilT, [-0.65, 0.16, 1.0], [brakeFeed, k.bolt(S.solenoidBolt, [-0.35, 0.18, 1.0], [0, 1, 0], [brakeFeed], 2)]);
  if (g >= 2) k.lamps(4, -0.3, 0.82, 0.72, 0.2);
}

// ---- control cabinet ---------------------------------------------------------------------------------------

/** A small control cabinet, lying with its door up. Mains come in through a gland on the -z wall to a terminal
 *  block (earth to a stud), live and neutral go to the transformer's primary, its secondary feeds the first
 *  contactor on the DIN rail, the contactors switch the controller board. The door has screws, a pry tab
 *  and a latch on the back wall; the transformer is bolted through the back plate. */
function controlCabinet(k: Kit) {
  const THREE = k.shapes;
  const g = k.grade;
  k.box(1.6, 0.05, 1.5, 0, 0, 0, 'trim'); // back plate
  k.box(1.4, 0.02, 1.3, 0, 0.05, 0, 'dark'); // mounting plate
  for (const z of [-0.6, 0.6]) k.cyl(0.04, 0.3, -0.83, 0.25, z, 'trim', 'y'); // hinge knuckles
  k.bay(0, 0, 1.6, 1.5, 0.05, 0.6, { screws: 0, latch: true, pry: true });
  const Y = 0.07;
  // cable gland and the cable going off
  k.cyl(0.07, 0.12, -0.55, 0.3, -0.75, 'trim', 'z');
  k.cable([[-0.55, 0.3, -0.82], [-0.55, 0.12, -1.3], [-0.2, 0.1, -1.8]], 0.045);
  // terminal block, DIN rail
  for (const x of [-0.75, -0.62, -0.49]) k.box(0.1, 0.12, 0.12, x, Y, -0.5, 'yellow');
  k.box(0.04, 0.03, 1.2, 0, Y, -0.05, 'chip');
  k.cable([[-0.6, 0.3, -0.68], [-0.7, 0.14, -0.55], [-0.78, 0.1, -0.3]], 0.035, 'green'); // earth to its stud
  k.stud(-0.78, Y + 0.02, -0.28, 0.05);
  const mains = k.wire(S.mainsCable, [[-0.55, 0.3, -0.68], [-0.55, 0.4, -0.3], [-0.5, 0.34, 0.0]], 'brown', [], 0.045);
  const secondary = k.wire(S.transformerSecondary, [[-0.45, 0.34, 0.22], [-0.25, 0.4, 0.1], [-0.08, 0.33, -0.5]], 'red', [], 0.03);
  // transformer on the left, bolted through the back plate
  k.mount('coil', [[-0.5, Y, 0.1], [0, 0, 0]], () => [mains, secondary, k.bolt(S.transformerBolt, [-0.5, 0, 0.1], [0, -1, 0], [mains, secondary], 2)]);
  // two contactors on the rail: the first fed by the transformer, the second driven from the board
  const relay1 = k.take('relay');
  const out1 = k.wire(S.contactor1Out, [[0.08, 0.33, -0.5], [0.3, 0.4, -0.45], [0.42, 0.14, -0.45]], 'red', [], 0.03);
  if (relay1) k.part('relay', relay1, [0.0, Y, -0.4], [k.clip(S.railClip, [0.0, Y + 0.02, -0.2], [0, 1, 0]), secondary, out1]);
  const relay2 = k.take('relay');
  const extra: Step[] = [];
  if (relay2) {
    const out2 = k.wire(S.contactor2Out, [[-0.08, 0.33, 0.3], [0.2, 0.42, 0.1], [0.4, 0.14, -0.05]], 'red', [], 0.03);
    extra.push(out2);
    k.part('relay', relay2, [0.0, Y, 0.2], [k.clip(S.railClip, [0.0, Y + 0.02, 0.4], [0, 1, 0]), out2]);
  }
  // controller board and the heatsink on its regulator
  k.box(0.62, 0.04, 0.5, 0.5, Y, -0.25, 'pcb');
  const standoffs = [[-1, -1], [1, 1]].map(([sx, sz]) => k.screw(S.boardStandoff, [0.5 + sx * 0.3, Y + 0.04, -0.25 + sz * 0.22]));
  k.mount('compute', [[0.5, Y + 0.04, -0.25], [0, 0, 0]], () => [...standoffs, out1, ...extra]);
  k.box(0.4, 0.04, 0.4, 0.5, Y, 0.42, 'pcb');
  k.box(0.26, 0.05, 0.26, 0.5, Y + 0.04, 0.42, 'chip');
  k.mount('heatsink', [[0.5, Y + 0.09, 0.42], [0, 0, 0]], () => [k.clip(S.springClip, [0.78, Y + 0.45, 0.42], [0, 1, 0])]);
  // backup battery for the controller, strapped down in the free corner by the hinges
  k.mount('battery', [[-0.45, Y, 0.58], [0, 0, 0]], () => [k.clip(S.batteryStrap, [-0.45, Y + 0.28, 0.58], [0, 1, 0])]);
  if (g >= 2) k.lamps(5, -0.4, 0.65, 0.5, 0.2);
}

// ---- starter machines (scrap fields) ---------------------------------------------------------------------

/** Hand winch off a cargo hoist, on its base plate: a cable drum on a shaft between two pillow blocks, the -x block's
 *  bearing under a cap bolted down at each side. On +x, under a screwed guard: the drum gear on the shaft end (a nut)
 *  and the crank's pinion above it (a clip). */
function winch(k: Kit) {
  const THREE = k.shapes;
  const g = k.grade;
  const Y = 0.55, PY = Y + 0.52;
  k.box(1.8, 0.08, 0.9, 0, 0, 0, 'trim');
  for (const [x, z] of [[-0.8, -0.36], [0.8, -0.36], [-0.8, 0.36], [0.8, 0.36]]) k.stud(x, 0.1, z, 0.05);
  // pillow blocks: the -x one split at the shaft (its cap holds the bearing), the +x one tall enough for the crank
  k.box(0.24, Y - 0.18, 0.5, -0.55, 0.08, 0, 'body');
  k.box(0.2, PY + 0.12 - 0.08, 0.4, 0.42, 0.08, 0, 'body');
  // drum with its cable, the shaft through everything
  k.rod([-0.85, Y, 0], [0.82, Y, 0], 0.045, 'copper');
  k.cyl(0.24, 0.66, -0.03, Y, 0, 'body', 'x');
  for (const x of [-0.37, 0.31]) k.cyl(0.34, 0.04, x, Y, 0, 'trim', 'x');
  for (let i = 0; i < 6; i++) k.ring(0.26, 0.024, -0.29 + i * 0.105, Y, 0, 'dark', 'x');
  k.cable([[0.0, Y - 0.25, 0.1], [0.1, 0.12, 0.55], [0.5, 0.06, 0.95], [0.9, 0.05, 1.1]], 0.024, 'dark');
  // ratchet and pawl on the -x flange
  k.cyl(0.3, 0.05, -0.42, Y, 0, 'dark', 'x', 12);
  k.box(0.05, 0.06, 0.26, -0.42, Y + 0.24, 0.12, 'yellow');
  if (g >= 2) k.ring(0.35, 0.015, 0.31, Y, 0, 'accent', 'x');

  const cap = k.group([-0.55, Y - 0.1, 0]);
  k.mesh(new THREE.BoxGeometry(0.26, 0.4, 0.5), 'trim', 0, 0.2, 0, cap);
  const capBolts = [k.bolt(S.bearingCapBolt, [-0.55, Y + 0.3, 0.18], [0, 1, 0], [], 2)];
  k.cover(cap, capBolts, [0, 1, 0], 0.13);
  k.mount('bearing', k.ax('bearing', [-0.55, Y, 0], 'x'), () => capBolts);

  // crank shaft and handle
  k.rod([0.32, PY, 0], [1.08, PY, 0], 0.035, 'copper');
  k.rod([1.08, PY, 0], [1.08, PY + 0.35, 0], 0.03, 'trim');
  k.cyl(0.05, 0.22, 1.08, PY + 0.35, 0, 'red', 'x');
  // gear guard over both gears, a latch on its outer face
  const guard = k.group([0.72, Y - 0.32, 0]);
  k.mesh(new THREE.BoxGeometry(0.34, 1.18, 0.66), 'body', 0, 0.59, 0, guard);
  k.mesh(new THREE.BoxGeometry(0.02, 0.9, 0.06), g >= 1 ? 'accent' : 'trim', 0.18, 0.59, 0, guard);
  const guardScrews = [k.clip(S.guardLatch, [0.9, Y + 0.6, 0], [1, 0, 0])];
  k.cover(guard, guardScrews, [1, 0.3, 0], 0.17);
  k.mount('gear', k.ax('gear', [0.7, Y, 0], 'x'), () => [k.bolt(S.drumGearNut, [0.84, Y, 0], [1, 0, 0], guardScrews, 2)]);
  k.mount('gear', k.ax('gear', [0.7, PY, 0], 'x'), () => [k.clip(S.pinionClip, [0.84, PY, 0], [1, 0, 0], 1, guardScrews)]);
}

/** A cut-off section of coolant line on two saddles with a solenoid valve in it: the valve body sits in the line
 *  between two flanges (four bolts each), its coil on top, fed by a lead from a junction box (screwed lid). */
function solenoidValve(k: Kit) {
  const THREE = k.shapes;
  const g = k.grade;
  const Y = 0.4;
  k.box(1.7, 0.06, 0.7, 0, 0, 0, 'trim');
  for (const x of [-0.6, 0.6]) {
    k.box(0.14, Y - 0.2, 0.32, x, 0.06, 0, 'dark');
    k.cyl(0.12, 0.48, x * 1.05, Y, 0, 'body', 'x');
  }
  // the line's flanges either side of the valve
  for (const x of [-0.32, 0.32]) k.cyl(0.24, 0.05, x, Y, 0, 'trim', 'x', 24);
  const flanges = [-0.36, 0.36].map((x) => k.bolt(S.flangeBolt, [x, Y + 0.18, 0], [Math.sign(x), 0, 0], [], 2));
  if (g >= 2) for (const x of [-0.6, 0.6]) k.ring(0.125, 0.015, x, Y, 0, 'accent', 'x');
  // junction box on the bracket, a lead up to the coil
  k.box(0.36, 0.22, 0.3, 0.45, 0.06, 0.48, 'body');
  const lid = k.group([0.45, 0.3, 0.48]);
  k.mesh(new THREE.BoxGeometry(0.38, 0.03, 0.32), 'trim', 0, 0, 0, lid);
  const lidScrews = [k.screw(S.junctionBoxScrew, [0.59, 0.32, 0.48])];
  k.cover(lid, lidScrews, [0, 1, 0.3], 0.02);
  const lead = k.wire(S.coilLead, [[0.45, 0.3, 0.48], [0.4, 0.75, 0.2], [0.15, 0.85, -0.25], [0.0, Y + 0.45, -0.47]], 'brown', lidScrews, 0.03);
  const valve = k.take('valve');
  if (valve) k.part('valve', valve, [0, Y - 0.25, 0], [...flanges, lead]);
  else k.cyl(0.12, 0.5, 0, Y - 0.25, 0, 'body'); // plain spool piece
  // the coil on a shelf bracket behind the valve, bolted down at both ends
  k.box(0.4, Y + 0.24, 0.05, 0, 0.06, -0.66, 'trim');
  k.box(0.5, 0.04, 0.36, 0, Y + 0.26, -0.47, 'trim');
  k.mount('coil', [[0, Y + 0.3, -0.47], [0, 0, 0]], () => [lead, k.bolt(S.coilBolt, [0.2, Y + 0.3, -0.47], [0, 1, 0], [lead], 2)]);
}

/** A crashed distress beacon lying on its side: a drum-shaped body with the battery pack under a latched, screwed
 *  lid, and the transmitter coil in the foot of the snapped-off mast, bolted to its flange. */
function beacon(k: Kit) {
  const THREE = k.shapes;
  const g = k.grade;
  k.box(1.2, 0.05, 1.3, 0, 0, 0, 'dark'); // scorched skid plate
  k.box(1.0, 0.45, 1.0, 0, 0.05, 0, 'body');
  k.box(1.04, 0.06, 0.12, 0, 0.12, -0.45, 'yellow');
  k.box(1.04, 0.06, 0.12, 0, 0.12, 0.45, 'yellow');
  // battery bay on top
  const lid = k.bay(0, -0.05, 0.9, 0.6, 0.5, 0.3, { screws: 0, latch: true });
  k.mount('battery', [[0, 0.52, -0.05], [0, 0, 0]], () => [...lid.holds, k.clip(S.batteryStrap, [0, 0.82, -0.05], [0, 1, 0], 1, lid.holds)]);
  // mast foot on +z with the transmitter coil, the mast snapped off and lying alongside
  k.cyl(0.3, 0.06, 0, 0.5, 0.52, 'trim', 'y', 24);
  const feed = k.wire(S.antennaFeed, [[0.3, 0.5, 0.25], [0.4, 0.62, 0.4], [0.2, 0.6, 0.55]], 'red', lid.holds, 0.03);
  const footBolts = k.circle(S.mastFootBolt, [0, 0.57, 0.52], [0, 1, 0], 0.24, 2, [feed]);
  k.mount('coil', [[0, 0.56, 0.52], [0, 0, 0]], () => [feed, ...footBolts]);
  k.rod([0.55, 0.06, 0.7], [0.65, 0.06, -0.8], 0.04, 'trim');
  k.cyl(0.07, 0.08, 0.56, 0.06, 0.62, 'red', 'y', 10);
  k.lamps(g >= 2 ? 3 : 2, -0.4, 0.5, 0.42, 0.12);
}

// ---- torn out of the crashed pod (shared/tables.ts POD_LOOT) ------------------------------------------------------
// In the pod's paint (off-white panels, grey, an orange band, red trim), laid out like their Blender models
// (tools/blender/finds.py: what lies on the sand and the icons), so what you carried in is what lies on the bench.

/** The pod's instrument console, torn off its frame: a sloped desk unit, low at the front (+z), tall at the back, an
 *  off-white faceplate (screen, gauges, a row of toggles, the orange band) screwed on at its corners, a bent bracket at
 *  each end. Under the faceplate, the wiring loom: up to two coils at the back, each on its harness and a connector
 *  latch. The loom spills out of the torn +x end, cut. */
function podConsole(k: Kit) {
  const THREE = k.shapes;
  const W = 1.8, D = 1.1, HF = 0.3, HB = 0.8;
  const A = Math.atan2(HB - HF, D), ca = Math.cos(A), sa = Math.sin(A);
  const CY = (HF + HB) / 2 + 0.03, L = D / ca;
  /** A point on the faceplate: x across, v up the slope (from its middle), w out of it. */
  const face = (x: number, v: number, w: number): V => [x, CY + v * sa + w * ca, w * sa - v * ca];
  const NRM: V = [0, ca, sa];
  k.box(W, 0.06, D, 0, 0, 0, 'hullGrey');
  k.box(W, HF - 0.06, 0.06, 0, 0.06, D / 2 - 0.03, 'hullGrey');
  k.box(W, HB - 0.06, 0.06, 0, 0.06, -D / 2 + 0.03, 'hullGrey');
  // the sides: wedges, low at the front (+z), tall at the back
  const side = new THREE.Shape([new THREE.Vector2(-D / 2, 0.06), new THREE.Vector2(D / 2, 0.06), new THREE.Vector2(D / 2, HF), new THREE.Vector2(-D / 2, HB)]);
  for (const s of [-1, 1]) {
    k.mesh(new THREE.ExtrudeGeometry(side, { depth: 0.06, bevelEnabled: false }).rotateY(-Math.PI / 2), 'hullGrey', s * (W / 2 - 0.03) + 0.03, 0, 0);
    // bent brackets where it was wrenched off
    const b = k.box(0.08, 0.04, 0.36, s * 1.0, 0.33, 0.33, 'trim');
    b.rotation.set(0.3 * s, 0.25 * s, 0.6 * s);
  }
  // the loom inside, along the back wall, and spilling out of the torn +x end, cut
  k.cable([[-0.8, 0.12, -0.42], [-0.3, 0.1, -0.45], [0.3, 0.12, -0.42], [0.92, 0.33, -0.17]], 0.035, 'black');
  k.cable([[-0.8, 0.18, -0.38], [-0.2, 0.17, -0.4], [0.4, 0.19, -0.36], [0.92, 0.36, -0.14]], 0.025, 'yellow');
  for (const [pts, r, key] of [
    [[[0.92, 0.37, -0.2], [1.1, 0.2, -0.1], [1.23, 0.03, 0.2], [1.17, 0.03, 0.5]], 0.03, 'red'],
    [[[0.92, 0.33, -0.13], [1.17, 0.13, -0.23], [1.43, 0.03, -0.17], [1.63, 0.03, 0.03]], 0.03, 'yellow'],
    [[[0.92, 0.3, -0.17], [1.03, 0.1, -0.37], [1.2, 0.04, -0.63], [1.1, 0.04, -0.87]], 0.037, 'black'],
  ] as [V[], number, 'red' | 'yellow' | 'black'][]) {
    k.cable(pts, r, key);
    const e = pts[pts.length - 1];
    k.cyl(r * 0.7, 0.05, e[0], e[1] - 0.025, e[2], 'copper');
  }

  // the faceplate, sloping down to the front
  const plate = k.group([0, CY, 0], [A, 0, 0]);
  const on = (w: number, d: number, x: number, v: number, key: Parameters<Kit['mesh']>[1], h = 0.02) =>
    k.mesh(new THREE.BoxGeometry(w, h, d), key, x, 0.03 + h / 2, -v, plate);
  on(W + 0.05, L + 0.05, 0, 0, 'hull', 0.06).position.y = 0;
  on(W + 0.05, 0.15, 0, L / 2 - 0.1, 'orange');
  on(W + 0.05, 0.05, 0, -L / 2 + 0.03, 'red');
  on(0.72, 0.46, -0.4, 0.03, 'dark'); // screen
  on(0.06, 0.5, -0.42, 0.06, 'black', 0.03).rotation.y = 0.7; // its crack
  for (const x of [0.28, 0.6]) {
    on(0.24, 0.24, x, 0.17, 'dark', 0.03);
    k.mesh(new THREE.TorusGeometry(0.12, 0.015, 6, 20).rotateX(Math.PI / 2), 'trim', x, 0.06, -0.17, plate);
  }
  for (let i = 0; i < 5; i++) {
    const x = 0.15 + i * 0.14;
    on(0.08, 0.12, x, -0.22, 'dark', 0.03);
    on(0.025, 0.025, x, -0.22 + (i % 2 ? 0.02 : -0.02), 'trim', 0.08);
  }
  const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  const faceScrews = corners.map(([sx, sv]) => k.screw(S.faceplateScrew, face(sx * 0.83, sv * (L / 2 - 0.06), 0.06), NRM));
  k.cover(plate, faceScrews, [0.2, 1, 0.4], 0.04);

  // the coils of the loom at the back, each on its harness to the back wall and a connector latch
  for (const [x, key] of [[-0.42, 'red'], [0.42, 'blue']] as [number, 'red' | 'blue'][]) {
    k.mount('coil', [[x, 0.06, -0.26], [0, 0, 0]], () => {
      const lead = k.wire(S.harness, [[x + 0.2, 0.3, -0.2], [x + 0.32, 0.36, -0.36], [x + 0.28, 0.5, -0.48]], key, faceScrews, 0.03);
      return [lead, k.clip(S.connectorLatch, [x - 0.3, 0.5, -0.49], [0, 0, 1], 1, faceScrews)];
    });
  }
}

/** The pod's power box, torn out by its cables: grey walls with the orange band, an off-white lid screwed down at its
 *  corners. Inside, the emergency battery under a strap and the distribution coil on its bolt, joined by a lead. Cable
 *  glands on one side, the cables cut short. */
function podPowerbox(k: Kit) {
  const THREE = k.shapes;
  const H = 0.6;
  k.box(1.1, 0.06, 0.8, 0, 0, 0, 'trim');
  for (const z of [-0.37, 0.37]) k.box(1.1, H, 0.06, 0, 0.06, z, 'hullGrey');
  for (const x of [-0.52, 0.52]) k.box(0.06, H, 0.68, x, 0.06, 0, 'hullGrey');
  for (const z of [-0.405, 0.405]) k.box(1.12, 0.12, 0.01, 0, 0.3, z, 'orange');
  for (const x of [-0.555, 0.555]) k.box(0.01, 0.12, 0.8, x, 0.3, 0, 'orange');
  // cable glands on +x, the cables cut
  for (const z of [-0.18, 0.18]) {
    k.cyl(0.07, 0.08, 0.58, 0.38, z, 'dark', 'x', 12);
    k.cable([[0.6, 0.38, z], [0.8, 0.3, z * 1.3], [0.95, 0.04, z * 1.8], [1.2, 0.03, z * 2.2]], 0.035, z < 0 ? 'black' : 'red');
    k.cyl(0.04, 0.05, 1.2, 0.0, z * 2.2, 'copper');
  }
  // the lid
  const lid = k.group([0, H + 0.09, 0]);
  k.mesh(new THREE.BoxGeometry(1.16, 0.06, 0.86), 'hull', 0, 0, 0, lid);
  k.mesh(new THREE.BoxGeometry(1.16, 0.03, 0.06), 'red', 0, 0.04, 0.4, lid);
  k.mesh(new THREE.BoxGeometry(0.3, 0.02, 0.2), 'yellow', 0.3, 0.04, 0, lid); // the warning plate
  const lidScrews = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => k.screw(S.lidScrew, [sx * 0.48, H + 0.13, sz * 0.33]));
  k.cover(lid, lidScrews, [0, 1, 0.3], 0.04);
  // inside: the battery, strapped, a lead over to the coil on its bolt
  const lead = k.wire(S.coilLead, [[-0.2, 0.58, 0.05], [0.0, 0.62, 0.1], [0.25, 0.42, 0.1]], 'red', lidScrews, 0.03);
  k.mount('battery', [[-0.22, 0.06, 0], [0, 0, 0]], () => [lead, k.clip(S.batteryStrap, [-0.22, 0.58, -0.12], [0, 1, 0], 1, lidScrews)]);
  k.mount('coil', [[0.25, 0.06, 0], [0, 0, 0]], () => [lead, k.bolt(S.coilBolt, [0.25, 0.1, 0.27], [0, 1, 0], lidScrews, 2)]);
}

export const BUILDERS: Record<JunkKind, (k: Kit) => void> = {
  pump_housing: pumpHousing,
  jet_engine: jetEngine,
  robot_arm: robotArm,
  control_cabinet: controlCabinet,
  winch,
  solenoid_valve: solenoidValve,
  beacon,
  pod_console: podConsole,
  pod_powerbox: podPowerbox,
  vehicle_frame: vehicleFrame,
  water_jet: waterJet,
  warp_core: warpCore,
  ai_control: aiControl,
};
