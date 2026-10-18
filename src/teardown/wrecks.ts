// Disassembly structure of the salvage wrecks (shared/salvage.ts SALVAGE, issue #13), for the disassembly table.
// Each follows its Blender model (tools/blender/salvage/<id>.py) in layout, so what you carried home is
// recognisably what lies on the table: the parts the model shows are where the model shows them, and everything
// that holds them in is a step, built with the same kit as the crash-site components (junk.ts). A mount only
// gets its hardware when the roll put a part there; SALVAGE yields and tierWeights decide that (buildJunk).
// Kit units are about twice the model's metres; SCALE in junk.ts brings them back to size. Everything is done
// alone on the table, so nothing here needs a two-player lift.
import * as THREE from 'three/webgpu';
import type { Kit } from './junk.ts';

// ---- broken vehicle frame (#14) ------------------------------------------------------------------------------

/** Ladder chassis of an electric buggy, nose towards -z. The right rail is snapped and its front half bent down.
 *  Battery tray between the rails at the front: a screwed lid with a pry seam over up to three cells, each held by
 *  a strap and its lead. Seat pan in the middle, screwed to four posts, over the chokes (coils). Behind it the
 *  controller plate with finned heat sinks, held by spring clips and their screws. Hub motors at the wheels: the
 *  rear right one on its axle nut and caliper bolts, a spare front-left hub, phase leads running to the
 *  controller. The motors' axle nuts face outwards, so the frame has to be turned to reach both sides. */
export function vehicleFrame(k: Kit) {
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
  const phase = k.wire('Phase lead', [[0.55, CY + 0.12, CZ + 0.18], [0.75, 0.62, 1.35], [0.8, 0.5, 1.6]], 'red', [], 0.03);
  k.cable([[0.6, CY + 0.12, CZ + 0.05], [0.85, 0.66, 1.3], [0.86, 0.46, 1.58]], 0.03, 'yellow');
  for (const x of [0.35, -0.35]) {
    k.mount('heatsink', [[x, CY + 0.14, CZ], [0, 0, 0]], () => [k.clip('Spring clip', [x - 0.3, CY + 0.38, CZ], [-1, 0, 0])]);
  }

  // rear hub motor on its axle nut and a caliper bolt; the spare front hub on the other side
  const axleNut = k.bolt('Axle nut', [1.25, 0.4, 1.65], [1, 0, 0], [phase], 3);
  k.mount('motor', [[0.98, 0.22, 1.65], [0, 0, Math.PI / 2]], () => [phase, axleNut, k.bolt('Caliper bolt', [0.74, 0.62, 1.65], [0, 1, 0], [], 2)]);
  k.mount('motor', [[-1.0, 0.18, -1.3], [0, 0, -Math.PI / 2]], () => {
    const lead = k.wire('Phase lead', [[-0.85, 0.5, -1.2], [-0.7, 0.6, -0.4], [-0.55, CY + 0.1, CZ - 0.1]], 'red', [], 0.03);
    return [lead, k.bolt('Hub nut', [-1.27, 0.4, -1.3], [-1, 0, 0], [lead], 3)];
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
  const seatScrews = [[-1, -1], [1, 1]].map(([sx, sz]) => k.screw('Seat screw', [sx * 0.42, RY + 0.58, 0.5 + sz * 0.28]));
  k.cover(seat, seatScrews, [0.2, 1, 0], 0.03);
  for (const x of [-0.25, 0.25]) {
    k.mount('coil', [[x, RY + 0.02, 0.5], [0, 0, 0]], () => [
      k.bolt('Choke bolt', [x, RY + 0.02, 0.5], [0, -1, 0], [], 2), // from underneath: turn the frame over
    ]);
  }

  // battery tray at the front: lid over up to three cells, strapped down and wired together
  k.box(1.2, 0.04, 1.0, 0, RY - 0.19, -0.5, 'trim');
  k.bay(0, -0.5, 1.2, 1.0, RY - 0.15, 0.5);
  k.cable([[0, RY + 0.2, -0.05], [0, RY + 0.35, 0.3], [-0.2, CY + 0.12, CZ - 0.1]], 0.04, 'red');
  const cells: [number, number][] = [[-0.29, -0.76], [0.29, -0.76], [0, -0.25]];
  for (const [x, z] of cells) {
    k.mount('battery', [[x, RY - 0.15, z], [0, 0, 0]], () => [k.clip('Cell strap', [x, RY + 0.27, z], [0, 1, 0])]);
  }
  if (g >= 2) k.lamps(4, -0.3, RY + 0.17, CZ + 0.21, 0.2);
}

// ---- broken water jet (#17) ----------------------------------------------------------------------------------

/** A jet ski lying in the sand, bow towards -z. The seat is gone from the model, so here it is the lid of the bay:
 *  a latch at the back and two seat bolts at the front. In the bay: the batteries, strapped and wired, and the
 *  drive motor on two mount bolts, its shaft coupling reached through the intake grate under the hull (turn it
 *  over). A screwed hatch on the stern deck covers the bilge pump motor. */
export function waterJet(k: Kit) {
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
  const latch = k.clip('Seat clip', [0, DY + H - 0.12, z1 + 0.01], [0, 0, 1]);
  const seatBolts = [k.screw('Seat bolt', [0, DY + H + 0.18, z0 + 0.1])];
  k.cover(seat, [latch, ...seatBolts], [0, 1, 0.3], 0.09);

  // in the bay: batteries in front, the drive motor behind them
  for (const z of [-0.03, 0.34]) {
    k.mount('battery', [[0, DY, z], [0, 0, 0]], () => {
      k.cable([[0.18, DY + 0.42, z], [0.25, DY + 0.38, (z + 0.75) / 2], [0.12, DY + 0.38, 0.72]], 0.03, 'red');
      return [k.clip('Battery strap', [-0.12, DY + 0.42, z], [0, 1, 0])];
    });
  }
  k.box(0.5, 0.03, 0.2, 0, DY, 1.25 - 0.05, 'dark');
  // intake grate under the hull, over the drive shaft coupling
  const grate = new THREE.Group();
  grate.position.set(0, -0.02, 1.0);
  k.add(grate);
  k.mesh(new THREE.BoxGeometry(0.44, 0.03, 0.5), 'trim', 0, 0, 0, grate);
  for (const x of [-0.12, 0, 0.12]) k.mesh(new THREE.BoxGeometry(0.03, 0.04, 0.46), 'dark', x, -0.02, 0, grate);
  const grateScrews = k.rect('Grate screw', [0, -0.04, 1.0], [0, -1, 0], 0.34, 0.4);
  k.cover(grate, grateScrews, [0, -1, 0], 0.02);
  k.mount('motor', [[0, DY, 0.8], [0, Math.PI / 2, 0]], () => [
    k.wire('Phase lead', [[-0.16, DY + 0.38, 0.75], [-0.25, DY + 0.4, 0.4], [-0.2, DY + 0.36, 0.1]], 'yellow', [], 0.03),
    k.bolt('Motor mount bolt', [0.28, DY + 0.04, 0.8], [0, 1, 0], [], 2),
    k.screw('Shaft coupling', [0, 0.0, 0.92], [0, -1, 0], grateScrews), // only through the intake grate
  ]);

  // stern hatch over the bilge pump motor
  k.bay(0, 1.32, 0.76, 0.44, DY, 0.42, { screws: 0, pry: true });
  k.cable([[-0.2, DY + 0.34, 1.3], [-0.3, DY + 0.5, 1.18], [-0.32, DY + 0.38, 1.02]], 0.025, 'blue');
  k.mount('motor', [[0, DY + 0.02, 1.32], [0, 0, 0]], () => [k.clip('Pump bracket', [0.3, DY + 0.2, 1.32], [1, 0, 0])]);
  if (g >= 2) k.lamps(3, -0.1, 1.3, -0.92, 0.1);
}

// ---- warp drive core (#16) -----------------------------------------------------------------------------------

/** The reactor column lying on its side in a bent cradle, axis along x: the capped end at -x, torn off at +x,
 *  the middle section breached so the core glows through. On top of the capped section: the fin bank, up to three
 *  heat sinks under a screwed shroud, each on a coolant clamp and a bolt. On the +z flank: the compute rack, a door
 *  on four screws and a pry seam, two rack bolts from underneath, a card latch on every board. On the -z flank of
 *  the torn section: the uranium cells, clamped in their cage; vent the coolant first. */
export function warpCore(k: Kit) {
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
  const coolant = k.wire('Coolant line', [[-1.3, AY + 0.25, 0.15], [-1.3, TOP + 0.2, 0.15], [-1.1, TOP + 0.44, 0.15], [-0.4, TOP + 0.44, 0.15]], 'copper', [], 0.035);
  const shroud = new THREE.Group();
  shroud.position.set(-0.78, TOP + 0.5, 0);
  k.add(shroud);
  k.mesh(new THREE.BoxGeometry(1.0, 0.04, 0.56), 'body', 0, 0, 0, shroud);
  for (const z of [-0.27, 0.27]) k.mesh(new THREE.BoxGeometry(1.0, 0.44, 0.03), 'body', 0, -0.22, z, shroud);
  if (g >= 3) k.mesh(new THREE.BoxGeometry(0.8, 0.02, 0.04), 'glow', 0, 0.03, 0, shroud);
  k.cover(shroud, k.rect('Shroud screw', [-0.78, TOP + 0.53, 0], [0, 1, 0], 0.84, 0.4), [0, 1, 0.2], 0.22);
  for (const x of [-1.08, -0.78, -0.48]) {
    k.mount('heatsink', [[x, TOP + 0.05, 0], [0, Math.PI / 2, 0]], () => [coolant, k.clip('Coolant clamp', [x, TOP + 0.36, 0.15], [0, 1, 0])]);
  }

  // compute rack on the +z flank: shelves of boards behind a door
  const RX = -0.78, RZ = 0.73;
  for (const x of [RX - 0.33, RX + 0.33]) k.box(0.04, 0.84, 0.46, x, AY - 0.42, RZ, 'trim');
  for (let i = 0; i < 4; i++) k.box(0.62, 0.03, 0.44, RX, AY - 0.44 + i * 0.27, RZ, 'dark');
  const rackBolts = [k.bolt('Rack bolt', [RX, AY - 0.45, RZ], [0, -1, 0], [], 2)];
  const door = new THREE.Group();
  door.position.set(RX, AY - 0.02, RZ + 0.25);
  k.add(door);
  k.mesh(new THREE.BoxGeometry(0.7, 0.86, 0.04), 'body', 0, 0, 0, door);
  k.mesh(new THREE.BoxGeometry(0.5, 0.04, 0.02), g >= 1 ? 'accent' : 'trim', 0, 0.3, 0.025, door);
  const seam = k.pry('Door seam', [RX + 0.35, AY - 0.02, RZ + 0.27], [1, 0, 0]);
  k.cover(door, [seam, ...rackBolts], [0, 0.2, 1], 0.02);
  for (let i = 0; i < 3; i++) {
    const y = AY - 0.41 + i * 0.27;
    k.mount('compute', [[RX, y, RZ - 0.02], [0, 0, 0]], () => [k.clip('Card latch', [RX + 0.18, y + 0.1, RZ + 0.2], [0, 0, 1])]);
  }
  if (g >= 2) k.lamps(3, RX - 0.2, AY + 0.42, RZ + 0.27, 0.2);

  // uranium cells in a cage on the -z flank of the torn section; vent the coolant before touching them
  const BZ = -0.68;
  k.box(0.8, 0.05, 0.36, 0.5, AY - 0.12, BZ, 'trim');
  k.box(0.8, 0.04, 0.06, 0.5, AY + 0.3, BZ - 0.17, 'trim'); // cage band
  const vent = k.pry('Field vent', [0.5, AY - 0.1, BZ - 0.2], [0, 0, -1]);
  for (const x of [0.32, 0.68]) {
    k.mount('uranium', [[x, AY - 0.07, BZ], [0, 0, 0]], () => [vent, k.bolt('Cage clamp', [x, AY + 0.32, BZ - 0.2], [0, 0, -1], [vent], 2)]);
  }
}

// ---- AI control system (#15) ---------------------------------------------------------------------------------

/** A rack cabinet standing on its plinth, front towards +z. Compute modules slide into the front, each held by
 *  two faceplate screws (the first two also by the ribbon to the backplane). The big heat sinks are bolted to the
 *  right side (+x) where the panel has rusted away, all on one copper coolant loop from the roof. On the roof the
 *  fan hood, screwed down, over the power supply's choke (a coil). */
export function aiControl(k: Kit) {
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
      return [k.screw('Faceplate screw', [0.45, y + 0.1, D / 2 + 0.01], [0, 0, 1])];
    });
  }

  // heat sinks on the right side, fins out along +x, on one coolant loop
  const loop = k.wire('Coolant pipe', [[0.0, H + 0.06, -0.38], [0.45, H + 0.06, -0.4], [0.7, H - 0.1, -0.42], [0.82, 0.7, -0.42]], 'copper', [], 0.035);
  k.box(0.04, 1.5, D - 0.08, W / 2 + 0.02, 0.5, 0, 'trim'); // base plate
  for (const y of [0.75, 1.25, 1.75]) {
    k.mount('heatsink', [[W / 2 + 0.04, y, 0], [0, 0, -Math.PI / 2]], () => [loop, k.bolt('Heat sink bolt', [W / 2 + 0.06, y, 0.38], [1, 0, 0], [], 2)]);
  }

  // fan hood on the roof over the power supply choke, clipped down on its top (under the hood, facing up)
  k.bay(-0.1, 0.02, 0.72, 0.72, H + T, 0.5);
  k.cable([[0.08, H + T + 0.4, 0.02], [0.18, H + T + 0.3, -0.15], [0.2, H + T + 0.05, -0.25]], 0.03, 'brown'); // supply lead
  k.mount('coil', [[-0.1, H + T, 0.02], [0, 0, 0]], () => [k.clip('Choke clip', [-0.1, H + T + 0.47, 0.02], [0, 1, 0])]);
  if (g >= 2) k.lamps(4, 0.06, H - 0.12, D / 2 + 0.01, 0.08);
}
