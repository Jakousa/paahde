# Viewmodel hands: how they hold things

Read this before adding a held item or changing a hand pose in `tools/models/hands.py` (it builds
`public/models/hands.glb`, drawn by `src/viewmodel.ts`). The first-person hands are seen up close, so a pose
that is anatomically wrong reads as "cursed" immediately. Don't hand-tune finger angles: place the object in
the hand correctly and let the fingers close on it.

## Anatomy the code follows

- **Power grip** (Napier 1956, *The prehensile movements of the human hand*). A cylinder (handle, spyglass,
  torch) lies **obliquely across the palm**. It runs from the heel of the hand on the little-finger side to
  the base of the index finger, about 20° off square to the hand (`T_OBLIQUE`). The fingers wrap round it,
  and the thumb closes over the fingers (on the index finger's middle phalanx) or lies along the barrel.
  The object rests **on** the palm surface and does not sink into it.
- **A fist holds a tube across the forearm, not along it.** You can't point a gripped spyglass straight
  ahead with the forearm pointing ahead. Trying to forces the wrist into a 60-90° twist, which is what
  the old pose did. Pick the forearm direction first, then let the object follow. The carry pose holds
  it like a torch: eyepiece up and forward out of the top of the fist.
- **Wrist:** keep the hand roughly in line with the forearm. Allow up to ~30° of ulnar deviation (bending
  towards the little finger) and some flexion. `carry_hand()` builds the hand from the solved elbow so the
  wrist stays in line; `WRIST <clip> <deg>` is printed at build time, so keep it under ~40 (that figure
  includes the residual twist).
- **Proportions** (Buchholz, Armstrong & Goldstein 1992): the phalanx lengths are fractions of hand length
  (`FINGERS`, `THUMB_FR`), on a slightly stubby glove (`FINGER_L`). The knuckle line is arched: the little
  finger's knuckle sits nearer the wrist.
- **Joint ranges:** MCP 0-90°, PIP 0-105°, DIP 0-75° (`FLEX_MAX`); thumb CMC/MCP/IP `THUMB_MAX`. For a
  relaxed curl the DIP follows the PIP at about 2/3 (Rijpkema & Girard 1991), see `curl()`.
- **Relaxed thumb** rests along the side of the index finger, not sticking out sideways (an abducted rest
  thumb looks like a hitchhiker in the idle clips).

## How the code does it

- **Skeleton:** the viewmodel has its own glove (`build_glove` in hands.py, not scavenger.py's). It has four
  fingers × 3 bones (`<Side>Hand{Index,Middle,Ring,Pinky}{1,2,3}`) and a 3-bone thumb (`<Side>HandThumb1-3`).
  The third-person character still has the old 2-bone finger; it isn't touched.
- **Pose deltas:** `key_pose` takes rotations in **rest armature space relative to the parent**
  (D_bone = D_parent · q). So finger angles computed with the hand at rest are valid in every hand pose,
  and a grip can be solved once and reused in all frames (`T_GRIP`, `C_GRIP`).
- **Grasp solver** (`grasp()`, `close_chain()`; GraspIt!-style auto-grasp, Miller & Allen 2004):
  - The held object is a **signed distance function** in rest armature space (`cylinder_sdf`,
    `canteen_sdf`).
  - All joints of a finger flex together. When a phalanx touches (within `SQUISH` × its radius, which allows
    for glove squash), the joints proximal to it stop and the distal ones keep closing.
  - A digit that starts inside the object is opened first.
  - The thumb closes last and collides with the fingers too. With `wrap=<barrel axis>` it first swings
    across the barrel (opposition), then curls round it. Its proximal phalanx rides on the barrel and the
    distal one lands on the fingers.
  - The build prints `GRASP <finger> [mcp, pip, dip]`. Angles all near 0 or all at the limits mean the
    object is placed wrong.
- **Placing the object** (`telescope_in_hand()`): give the barrel axis from the hand frame (`hand_frame`:
  `a` = towards the fingers, `pn` = palm normal, `t` = thumb side) with the oblique angle. Then push it
  along `pn` until the deepest palm vertex is 2 mm inside it (`PALMS` holds the rest palm vertices).
  Which end sticks out by the thumb matters: the spyglass has its eyepiece by the thumb, so the same grip
  brings it to the eye.
- **Bars in general** (`bar_in_hand(pre, contact, axis, ref, roll, grip)`): the same placement for either hand and any
  object: its `axis` across the palm (+ end by the thumb), `ref` out of the palm turned `roll` about it, the point
  `grip` pushed onto the palm. The shovel (both hands on the shaft), the jammer's support hand under its body and the
  scrap offcut use it; the shovel's rolls are searched for the straightest wrists over all the dig's keys.
- **Arm:** `solve_arm()` (two-bone IK with a pole) places the hand; `ELBOW` holds the last solved elbow.
  `right_hand_world(wrist, fingers, thumb)` builds a hand matrix from directions. For the at-eye pose the
  roll about the tube is searched for the straightest wrist that's in reach (`eye_cost`). One-shots
  interpolate hand matrices (`mat_lerp`, slerp plus an arc so the hand doesn't pass through the chin).

## Adding a held item

1. Model it (like `tools/models/telescope.py`), parent it to the `RightHand` bone in hands.py, and toggle
   `.visible` in `src/viewmodel.ts`.
2. Write `<item>_in_hand()`: object matrix relative to the hand bone, plus its sdf, with the palm-contact
   push as above.
3. Solve the grip with `grasp('Right', sdf, wrap=axis_if_cylindrical)`, then build the clips with
   `solve_arm` + `pose.update(GRIP)`.
4. Check it (below). Fix placement or poses, never individual finger angles.

## Checking

- Build: `/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/models/hands.py`
  The export runs `tools/models/prune_hands.py`: obsolete Shovel/Detector meshes, clips and their unreferenced images/buffers are removed without renumbering skeleton nodes.
  takes about 1 minute (bake). Read the `GRASP`/`WRIST` lines. The `WARN out of reach` lines during the
  at-eye roll search are expected.
- Quick pose checks: `HANDS_FAST=1 HANDS_OUT=/tmp/x.glb` skips the bakes (flat colours, a stand-in box jammer) for a
  quicker build; render that file. Only the full build writes the real `hands.glb`.
- Close-ups: `tools/models/render_hand.py -- public/models/hands.glb <prefix> Clip:frame,...`. Tile the views
  with `ffmpeg ... xstack` and look at one image. Check `fp` (what the player sees) and at least two
  close-ups: a pose can look fine from the eye with the thumb through the barrel.
- Compare with the previous build: `git show HEAD:public/models/hands.glb > old.glb`.
- In game: `npm run build`, serve a copy of `dist/` on a private port, then
  `node tools/models/screenshot.mjs "http://localhost:<port>/?debug&hold=telescope" out.png 1600 900 12000`.
  Add `&anim=TelescopeRaise` to loop a clip.
- The rebuild also rewrites `canteen.glb` / `telescope.glb` with bake noise. `git checkout` them unless you
  changed those models.
