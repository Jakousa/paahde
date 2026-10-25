// Putting things down and picking them up (shared/placed.ts). Select a placeable item in the hotbar (1–5) and
// a see-through preview follows the crosshair over the bunker floor: green where it fits, red where it doesn't; R
// turns it, left mouse / E puts it down (the server checks it again). Looking at a placed thing, G picks it back up
// into the bag. A UV lamp aimed at a bed snaps over it (and a bed under a lone lamp).
//
// The buildings (shared/crafting.ts BUILDS) are put up with the wrench: with it in hand the right mouse opens the build
// menu (src/buildMenu.ts), and the building picked there is previewed the same way, out on the sand, and goes up from
// the base materials in the bag (red, too, when they're short). With the wrench, G takes a building down.
//
// Looking at a beacon with nothing to put down, R gives its light the next colour (shared/placed.ts BEACON_COLORS).
import { BUILDS, isBuildable, pickIngredients, WRENCH } from '../shared/crafting.ts';
import { BEACON, BEACON_COLORS, isPlaceable, onSand, placeAim, placed, placedTarget, placedY, placeError, turnsOf, type Placed } from '../shared/placed.ts';
import { EYE_HEIGHT, pitchFromQ } from '../shared/dig.ts';
import { heightAt } from '../shared/terrain.ts';
import { yawFromQ } from '../shared/sim.ts';
import { isBound, kbd } from './bindings';
import { actionHeld, ui, useHeld } from './input';
import type { BuildMenu } from './buildMenu';
import { itemLabel } from './inventory';
import type { Net } from './net';
import type { PlacedView } from './world/placed';
import { TEXT } from '../shared/text.ts';

export class Placer {
  private net: Net;
  private view: PlacedView;
  private menu: BuildMenu;
  private rot = 0;
  private usePrev = false;
  private aimPrev = false;
  private pickPressed = false;
  private rotPressed = false;
  /** The building picked in the build menu, put up with the wrench in hand; null for none. */
  private chosen: string | null = null;

  constructor(net: Net, view: PlacedView, menu: BuildMenu) {
    this.net = net;
    this.view = view;
    this.menu = menu;
    addEventListener('keydown', (e) => {
      if (ui.inventoryOpen || e.repeat || e.ctrlKey || e.metaKey) return;
      if (isBound('rotate', e.code)) this.rotPressed = true;
      if (isBound('pickPlaced', e.code)) this.pickPressed = true;
    });
  }

  /**
   * Every frame. `slot`: the selected hotbar slot (-1 none); yaw/pitch quantized like the input. `toast` shows
   * a refusal. Returns the prompt for the crosshair (placing, or picking up the thing in view), and the placed
   * thing in view.
   */
  update(slot: number, feet: { x: number; y: number; z: number }, yawQ: number, pitchQ: number, active: boolean,
    toast: (text: string) => void): { prompt: string | null; target: Placed | null } {
    const yaw = yawFromQ(yawQ), pitch = pitchFromQ(pitchQ);
    const bag = this.net.boxes.bag ?? [];
    const held = bag[slot]?.kind;
    const wrench = held === WRENCH;
    if (!wrench) this.chosen = null;
    const use = useHeld() && !ui.inventoryOpen;
    const pressed = use && !this.usePrev;
    this.usePrev = use;
    // (Tracked while a menu is open too: the press that closes the build menu doesn't open it again.)
    const aim = actionHeld('aim');
    const aimed = aim && !this.aimPrev && !ui.inventoryOpen;
    this.aimPrev = aim;
    const pick = this.pickPressed;
    this.pickPressed = false;
    const rotate = this.rotPressed;
    this.rotPressed = false;
    if (!active || !this.net.connected) {
      this.view.preview(null, null, false);
      return { prompt: null, target: null };
    }
    if (wrench && aimed) this.menu.open(bag, this.chosen, (k) => (this.chosen = k));

    // Buildings come down with the wrench (all they took comes back), the rest is picked up by hand.
    const target = placedTarget(feet, yaw, pitch, placed);
    const takeable = target && (!isBuildable(target.kind) || wrench) ? target : null;
    if (pick && takeable) this.net.unplace(takeable.id);
    const pickHint = takeable
      ? `${kbd('pickPlaced')}${isBuildable(takeable.kind) ? TEXT.prompt.dismantle(itemLabel(takeable.kind)) : TEXT.prompt.pickUp(itemLabel(takeable.kind))}` : null;
    const menuHint = wrench ? `${kbd('aim')}${TEXT.prompt.buildMenu}` : null;

    // What goes down: the building picked with the wrench, or the placeable in hand (buildings never are).
    const kind = wrench ? this.chosen : held && isPlaceable(held) && !isBuildable(held) ? held : null;
    if (!kind) {
      this.view.preview(null, null, false);
      // A beacon in view: R its next colour.
      const beacon = target?.kind === BEACON ? target : null;
      if (rotate && beacon) this.net.beaconColor(beacon.id, ((beacon.color ?? 0) + 1) % BEACON_COLORS.length);
      const colourHint = beacon ? `${kbd('rotate')}${TEXT.prompt.colour}` : null;
      return { prompt: [menuHint, colourHint, pickHint].filter(Boolean).join(' ') || null, target };
    }
    // R turns it: along X or Z, or a tarp a quarter at a time.
    const turns = turnsOf(kind);
    if (rotate) this.rot = (this.rot + 1) % turns;
    const at = placeAim(feet, yaw, pitch, kind, this.rot % turns, placed);
    // Down in the bunker with something for the sand: it goes outside.
    const below = onSand(kind) && feet.y + EYE_HEIGHT < heightAt(feet.x, feet.z);
    const short = wrench && !pickIngredients(bag, BUILDS[kind]);
    const why = below ? TEXT.notice.outsideOnly : !at ? (onSand(kind) ? TEXT.prompt.aimAtGround : TEXT.prompt.aimAtFloor)
      : placeError(kind, at.x, at.z, at.rot, placed, [feet]) ?? (short ? TEXT.notice.missingMaterials : null);
    this.view.preview(kind, at && { ...at, y: placedY(kind, at.x, at.z, at.rot) }, !why);
    if (pressed) {
      if (why) toast(why);
      else if (wrench) this.net.build(kind, at!.x, at!.z, at!.rot);
      else this.net.place(slot, at!.x, at!.z, at!.rot);
    }
    const what = wrench ? TEXT.prompt.build(itemLabel(kind)) : TEXT.prompt.place(itemLabel(kind));
    const prompt = why ? `<span class="bad">${why}</span> ${kbd('rotate')}${TEXT.prompt.turn}` : `${kbd('use')}${what} ${kbd('rotate')}${TEXT.prompt.turn}`;
    return { prompt: [prompt, pickHint].filter(Boolean).join(' '), target };
  }
}

/** "Plant bed" → "plant bed", but "UV lamp" stays. */
