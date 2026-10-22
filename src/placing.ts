// Putting things down and picking them up (shared/placed.ts). Select a placeable item in the hotbar (1–5) and
// a see-through preview follows the crosshair over the bunker floor (the sand, for the windmill): green where it
// fits, red where it doesn't; R turns it, left mouse / E puts it down (the server checks it again). Looking at a placed thing,
// G picks it back up into the bag. A UV lamp aimed at a bed snaps over it (and a bed under a lone lamp).
import { isPlaceable, onSand, placeAim, placed, placedTarget, placedY, placeError, type Placed } from '../shared/placed.ts';
import { EYE_HEIGHT, pitchFromQ } from '../shared/dig.ts';
import { heightAt } from '../shared/terrain.ts';
import { yawFromQ } from '../shared/sim.ts';
import { isBound, kbd } from './bindings';
import { ui, useHeld } from './input';
import { itemLabel } from './inventory';
import type { Net } from './net';
import type { PlacedView } from './world/placed';
import { TEXT } from '../shared/text.ts';

export class Placer {
  private net: Net;
  private view: PlacedView;
  private rot = 0;
  private usePrev = false;
  private pickPressed = false;

  constructor(net: Net, view: PlacedView) {
    this.net = net;
    this.view = view;
    addEventListener('keydown', (e) => {
      if (ui.inventoryOpen || e.repeat || e.ctrlKey || e.metaKey) return;
      if (isBound('rotate', e.code)) this.rot ^= 1;
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
    const kind = this.net.boxes.bag?.[slot]?.kind;
    const use = useHeld() && !ui.inventoryOpen;
    const pressed = use && !this.usePrev;
    this.usePrev = use;
    const pick = this.pickPressed;
    this.pickPressed = false;
    if (!active || !this.net.connected) {
      this.view.preview(null, null, false);
      return { prompt: null, target: null };
    }

    const target = placedTarget(feet, yaw, pitch, placed);
    if (pick && target) this.net.unplace(target.id);
    const pickHint = target ? `${kbd('pickPlaced')}${TEXT.prompt.pickUp(itemLabel(target.kind))}` : null;

    if (!kind || !isPlaceable(kind)) {
      this.view.preview(null, null, false);
      return { prompt: pickHint, target };
    }
    const at = placeAim(feet, yaw, pitch, kind, this.rot, placed);
    // Down in the bunker with something for the sand: it goes outside.
    const below = onSand(kind) && feet.y + EYE_HEIGHT < heightAt(feet.x, feet.z);
    const why = below ? TEXT.notice.outsideOnly : at ? placeError(kind, at.x, at.z, at.rot, placed, [feet]) : onSand(kind) ? TEXT.prompt.aimAtGround : TEXT.prompt.aimAtFloor;
    this.view.preview(kind, at && { ...at, y: placedY(kind, at.x, at.z, at.rot) }, !why);
    if (pressed) {
      if (why) toast(why);
      else this.net.place(slot, at!.x, at!.z, at!.rot);
    }
    const prompt = why ? `<span class="bad">${why}</span> ${kbd('rotate')}${TEXT.prompt.turn}` : `${kbd('use')}${TEXT.prompt.place(itemLabel(kind))} ${kbd('rotate')}${TEXT.prompt.turn}`;
    return { prompt: `${prompt}${pickHint ? ` ${pickHint}` : ''}`, target };
  }
}

/** "Plant bed" → "plant bed", but "UV lamp" stays. */
