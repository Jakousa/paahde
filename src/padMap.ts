// The gamepad's layout in one place: which button does what (src/gamepad.ts in the game, src/padCursor.ts in the
// inventory read it from here) and so what every control hint names while the pad is in use (src/bindings.ts
// promptKey). Change a button here and the game and its hints follow.
import type { Action, Prompt } from './bindings';

/** Standard mapping button indices (https://w3c.github.io/gamepad/#remapping), by their Xbox names. */
export const BTN = {
  a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7, view: 8, menu: 9, ls: 10, rs: 11, up: 12, down: 13, left: 14, right: 15,
} as const;
export type PadButton = keyof typeof BTN;
/** What a hint can show: a button, or a stick. */
export type PadGlyph = PadButton | 'stickL' | 'stickR';

/** In the game: the button that holds each action's key down (src/gamepad.ts). */
export const PAD_HOLD: Partial<Record<Action, PadButton>> = {
  jump: 'a', crouch: 'b', interact: 'x', bike: 'y', aim: 'lt', use: 'rt', inventory: 'view', thirdPerson: 'rs',
  rotate: 'left', pickPlaced: 'right',
};
/** In the game, worked by src/gamepad.ts itself: L3 sprints (latched), LB / RB step the hotbar, the d-pad zooms. */
export const PAD_GAME = { sprint: 'ls', hotbarPrev: 'lb', hotbarNext: 'rb', zoomIn: 'up', zoomOut: 'down', menu: 'menu' } as const;
/** In the inventory and the workbench menu (src/padCursor.ts). */
export const PAD_UI = { drag: 'a', half: 'y', send: 'x', turnL: 'lb', turnR: 'rb', close: 'b' } as const;

/** What each prompt names on the pad; none: it has no button there (its hint hides). */
export const PAD_PROMPT: Partial<Record<Prompt, PadGlyph[]>> = {
  ...Object.fromEntries(Object.entries(PAD_HOLD).map(([a, b]) => [a, [b]])),
  forward: ['stickL'], back: ['stickL'], left: ['stickL'], right: ['stickL'],
  sprint: [PAD_GAME.sprint], spyglass: [PAD_HOLD.aim!],
  hotbarPrev: [PAD_GAME.hotbarPrev], hotbarNext: [PAD_GAME.hotbarNext], zoom: [PAD_GAME.zoomIn, PAD_GAME.zoomOut], menu: [PAD_GAME.menu],
  uiDrag: [PAD_UI.drag], uiHalf: [PAD_UI.half], uiSend: [PAD_UI.send], uiTurn: [PAD_UI.turnL, PAD_UI.turnR], uiClose: [PAD_UI.close],
};

/** Which names the pad's buttons go by: PlayStation pads (Sony's vendor id, or their names) get theirs, others Xbox's. */
export function padStyle(id: string): 'xbox' | 'playstation' {
  return /054c|playstation|dualshock|dualsense/i.test(id) ? 'playstation' : 'xbox';
}
