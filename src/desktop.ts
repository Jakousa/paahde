// The desktop app (desktop/, docs/desktop.md) serves this page from app://game/ and names the game server in
// desktop/preload.cjs; in a browser the page's own address is the server.
const desktop = (window as unknown as { desktop?: { server: string } }).desktop;

/** The game's address on its server (with the trailing slash): `ws`, `api/...` and invite links hang off it. */
export const PAGE_URL = desktop?.server ?? `${location.origin}${location.pathname}`;
