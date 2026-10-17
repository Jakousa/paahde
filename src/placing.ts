// Putting things down and picking them up (shared/placed.ts). Select a placeable item in the hotbar (1–4) and
// a see-through preview follows the crosshair over the bunker floor: green where it fits, red where it
// doesn't; R turns it, left mouse / E puts it down (the server checks it again). Looking at a placed thing,
// G picks it back up into the bag. A UV lamp aimed at a bed snaps over it (and a bed under a lone lamp).
import { isPlaceable, placeAim, placed, placedTarget, placeError, type Placed } from '../shared/placed.ts';
import { pitchFromQ } from '../shared/dig.ts';
import { yawFromQ } from '../shared/sim.ts';
import { ui, useHeld } from './input';
import { itemLabel } from './inventory';
import type { Net } from './net';
import type { PlacedView } from './world/placed';

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
      if (e.code === 'KeyR') this.rot ^= 1;
      if (e.code === 'KeyG') this.pickPressed = true;
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
    const pickHint = target ? `<kbd>G</kbd>Pick up ${lower(itemLabel(target.kind))}` : null;

    if (!kind || !isPlaceable(kind)) {
      this.view.preview(null, null, false);
      return { prompt: pickHint, target };
    }
    const at = placeAim(feet, yaw, pitch, kind, this.rot, placed);
    const why = at ? placeError(kind, at.x, at.z, at.rot, placed, [feet]) : 'Aim at the floor of the base';
    this.view.preview(kind, at, !why);
    if (pressed) {
      if (why) toast(why);
      else this.net.place(slot, at!.x, at!.z, at!.rot);
    }
    const label = lower(itemLabel(kind));
    const prompt = why ? `<span class="bad">${why}</span> <kbd>R</kbd>Turn` : `<kbd>LMB</kbd>Place ${label} <kbd>R</kbd>Turn`;
    return { prompt: `${prompt}${pickHint ? ` ${pickHint}` : ''}`, target };
  }
}

/** "Plant bed" → "plant bed", but "UV lamp" stays. */
const lower = (label: string) => (/^[A-Z]{2}/.test(label) ? label : label[0].toLowerCase() + label.slice(1));
