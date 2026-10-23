// Names people type that others see: game names (the main menu's browser, the lobby) and player names (tags, chat).
// Checked on the client as they type (src/profile.ts, src/landing.ts) and again by the server, which has the say
// (server/index.ts for games, server/world.ts for players). A few plain characters only, and nothing on the
// `obscenity` English list (slurs and swears, with its leetspeak and repeated-letter transforms), checked as typed
// and with everything but letters and digits squeezed out ("n i g ..."), plus our own list below.
import { englishDataset, englishRecommendedTransformers, RegExpMatcher } from 'obscenity';
import { NAME_MAX } from './protocol.ts';

/** Letters (with the Nordic ones), digits, spaces and a little punctuation. */
const ALLOWED = /^[A-Za-z0-9äöåÄÖÅ _\-.'!]+$/;
/** Not on obscenity's list, or too close to the game's own voice. Matched in the squeezed, lowercased name. */
const BANNED = ['hitler', 'nazi', 'heil', 'kkk', 'neekeri', 'ryssa', 'admin', 'moderator', 'paahde', 'developer'];

export const GAME_NAME = { min: 3, max: 24 };
export const PLAYER_NAME = { min: 2, max: NAME_MAX };
/** Max players a game can be made with: [least, most], and the default. */
export const MAX_PLAYERS = { min: 1, max: 16, default: 8 };

export type NameWhy = 'short' | 'long' | 'chars' | 'banned';
export type NameCheck = { ok: true; name: string } | { ok: false; why: NameWhy };

let matcher: RegExpMatcher | undefined;
const squeeze = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();

/** `s` tidied (spaces collapsed, trimmed) if it's fit to show, else why not. */
export function checkName(s: unknown, len: { min: number; max: number }): NameCheck {
  if (typeof s !== 'string') return { ok: false, why: 'short' };
  const name = s.replace(/\s+/g, ' ').trim();
  if (name.length < len.min) return { ok: false, why: 'short' };
  if (name.length > len.max) return { ok: false, why: 'long' };
  if (!ALLOWED.test(name)) return { ok: false, why: 'chars' };
  matcher ??= new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers });
  const flat = squeeze(name);
  if (matcher.hasMatch(name) || matcher.hasMatch(flat) || BANNED.some((b) => flat.includes(b))) return { ok: false, why: 'banned' };
  return { ok: true, name };
}

/** A colour as the server takes it: any 24-bit RGB. */
export const isColor = (c: unknown): c is number => Number.isInteger(c) && (c as number) >= 0 && (c as number) <= 0xffffff;
