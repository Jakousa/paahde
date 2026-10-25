// Packet arrival never advances simulation time. A server tick consumes at most one queued input;
// excess old inputs are acknowledged as discarded, so reconciliation corrects the client to reality.
export type InputCommand = { seq: number; input: number; yaw: number; pitch: number };
export const MAX_QUEUED_INPUTS = 12;
export const HOLD_INPUT_MS = 250;

export class InputQueue {
  ack = 0;
  private lastSeq = 0;
  private receivedAt = -Infinity;
  private queue: InputCommand[] = [];
  private held: InputCommand | null = null;

  get length() { return this.queue.length; }

  receive(command: InputCommand, now: number): boolean {
    if (!Number.isSafeInteger(command.seq) || command.seq <= this.lastSeq) return false;
    this.lastSeq = command.seq;
    this.receivedAt = now;
    this.queue.push(command);
    while (this.queue.length > MAX_QUEUED_INPUTS) this.ack = this.queue.shift()!.seq;
    return true;
  }

  take(now: number): InputCommand | null {
    const command = this.queue.shift();
    if (command) { this.ack = command.seq; this.held = command; return command; }
    if (this.held && now - this.receivedAt <= HOLD_INPUT_MS) return this.held;
    return null;
  }

  clear() {
    this.ack = this.lastSeq;
    this.queue.length = 0;
    this.held = null;
  }
}
