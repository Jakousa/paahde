// Health: what the blows take off (server/world.ts hurt), apart from the heat meter (shared/water.ts). Full on every
// respawn. Heatstroke, a storm front's choking, poison gas and a sand vortex take all of it at once and no shield
// stops them; every other blow is a damage instance a shield plate takes whole (shielded). For now each one is a
// killing blow (KILL): no hit leaves you hurt, so health is server-side only and never shown.

export const HEALTH_MAX = 100;
/** A blow's damage that kills from full health. */
export const KILL = HEALTH_MAX;
