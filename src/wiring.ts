// Stringing power lines (shared/wires.ts). With a wiring coil in the hotbar, look at a connector and click (the use
// button): the wire hangs from it and follows your aim. Click another connector and it goes up (the server checks it
// again; the coil is used up), or a message says why not ("Out of reach": longer than the coil reaches). Clicking a
// wired pair takes that wire down; right-click, or the first connector again, lets go.
import { pitchFromQ } from '../shared/dig.ts';
import { EYE_HEIGHT } from '../shared/dig.ts';
import { placed } from '../shared/placed.ts';
import { yawFromQ } from '../shared/sim.ts';
import { connectorTarget, isCoil, socketAt, wireBetween, wireError } from '../shared/wires.ts';
import { kbd } from './bindings';
import { actionHeld, ui, useHeld } from './input';
import type { Net } from './net';
import type { WireView } from './world/wires';
import { TEXT } from '../shared/text.ts';

/** Where the loose end hangs when no connector is in view (m along the aim). */
const LOOSE = 3;

export class Wiring {
  private net: Net;
  private view: WireView;
  /** The connector the wire hangs from (placed id), or -1. */
  private from = -1;
  private usePrev = false;
  private cancelPrev = false;

  constructor(net: Net, view: WireView) {
    this.net = net;
    this.view = view;
  }

  /** A wire is hanging from a connector, waiting for its other end (the right mouse cancels it, not aims). */
  get busy() {
    return this.from >= 0;
  }

  /**
   * Every frame. `slot`: the selected hotbar slot; yaw/pitch quantized like the input; `active`: free to use the hands.
   * `toast` shows a refusal. Returns the prompt for the crosshair, or null.
   */
  update(slot: number, feet: { x: number; y: number; z: number }, yawQ: number, pitchQ: number, active: boolean,
    toast: (text: string) => void): string | null {
    const kind = this.net.boxes.bag?.[slot]?.kind;
    const use = useHeld() && !ui.inventoryOpen, cancel = actionHeld('aim') && !ui.inventoryOpen;
    const pressed = use && !this.usePrev, cancelled = cancel && !this.cancelPrev;
    this.usePrev = use;
    this.cancelPrev = cancel;
    const from = placed.find((p) => p.id === this.from);
    if (!active || !this.net.connected || !isCoil(kind) || (this.from >= 0 && !from)) {
      this.from = -1;
      this.view.preview(null, null, false);
      return null;
    }
    const yaw = yawFromQ(yawQ), pitch = pitchFromQ(pitchQ);
    const target = connectorTarget(feet, yaw, pitch, placed);
    if (cancelled && from) {
      this.from = -1;
      this.view.preview(null, null, false);
      return null;
    }
    if (!from) {
      this.view.preview(null, null, false);
      if (!target) return null;
      if (pressed) this.from = target.id;
      return `${kbd('use')}${TEXT.prompt.connect}`;
    }
    // Hanging from `from`: to the connector in view, or loose along the aim.
    const a = socketAt(from);
    const wired = target && target.id !== from.id ? wireBetween(from.id, target.id) : undefined;
    const why = target && target.id !== from.id && !wired ? wireError(from, target, kind) : null;
    const cp = Math.cos(pitch);
    const loose = { x: feet.x - Math.sin(yaw) * cp * LOOSE, y: feet.y + EYE_HEIGHT + Math.sin(pitch) * LOOSE, z: feet.z - Math.cos(yaw) * cp * LOOSE };
    this.view.preview(a, target && target.id !== from.id ? socketAt(target) : loose, !why);
    if (pressed && target) {
      if (target.id === from.id) this.from = -1;
      else if (why) toast(why);
      else {
        this.net.wire(slot, from.id, target.id);
        this.from = -1;
      }
      if (this.from < 0) this.view.preview(null, null, false);
    }
    const cancelHint = `${kbd('aim')}${TEXT.prompt.cancel}`;
    if (!target || target.id === from.id) return cancelHint;
    if (why) return `<span class="bad">${why}</span> ${cancelHint}`;
    return `${kbd('use')}${wired ? TEXT.prompt.takeDown : TEXT.prompt.connect} ${cancelHint}`;
  }
}
