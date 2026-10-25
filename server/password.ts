// Keep password hashing off the front server's WebSocket proxy thread, with a bounded share of
// libuv's worker pool and bounded waiting work. Existing scrypt parameters remain compatible.
import { scrypt } from 'node:crypto';

const CONCURRENCY = 2;
const MAX_WAITING = 16;
let running = 0;
const waiting: (() => void)[] = [];

export class PasswordBusy extends Error {}

export function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const run = () => {
      running++;
      scrypt(password, salt, 32, (error, key) => {
        running--;
        waiting.shift()?.();
        if (error) reject(error);
        else resolve(key);
      });
    };
    if (running < CONCURRENCY) run();
    else if (waiting.length < MAX_WAITING) waiting.push(run);
    else reject(new PasswordBusy('password service busy'));
  });
}
