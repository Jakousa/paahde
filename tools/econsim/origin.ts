// The world's origin (shared/origin.ts), or the base's spot in a commit from before there was one: this simulator also runs
// against older commits (cli.ts --base), so it's looked up, not imported.
type Point = { x: number; y: number; z: number };
const m = (await import('../../shared/origin.ts').catch(() => import('../../shared/base.ts' as string))) as { ORIGIN?: Point; BASE?: Point };
export const ORIGIN: Point = (m.ORIGIN ?? m.BASE)!;
