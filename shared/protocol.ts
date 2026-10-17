// WebSocket message shapes (JSON). `t` is the message type.
import type { PlayerState } from './sim.ts';

export type ClientMsg =
  // First message after connecting. browserId is a random UUID kept in localStorage.
  | { t: 'hello'; browserId: string }
  // One per fixed tick: input bitmask with an increasing sequence number.
  | { t: 'input'; seq: number; input: number };

export type PlayerSnap = PlayerState & { id: number; color: number };

export type ServerMsg =
  // id is a public per-connection id; the browserId is never sent to other players.
  | { t: 'welcome'; id: number; state: PlayerState; color: number }
  // ack = last input seq the server applied for *this* client; time = server clock in ms.
  | { t: 'snap'; time: number; ack: number; players: PlayerSnap[] };
