// Reproducible retained-world fixture, opt-in: no production databases or gameplay balance changes.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

export async function agedWorld(dir: string, file: string) {
  const { openDb } = await import(pathToFileURL(join(dir, 'server/db.ts')).href);
  const { EDIT_CHUNK } = await import(pathToFileURL(join(dir, 'shared/terrain.ts')).href);
  const db = openDb(file);
  try {
    db.tx(() => {
      for (let i = 0; i < 600; i++) {
        // Widely explored terrain and many retained objects, with a dense band near the origin.
        const x = (i % 30 - 15) * 30, z = (Math.floor(i / 30) - 10) * 30;
        db.insertPlaced('storage_chest', x, 0, z, i % 4, 'aged-fixture');
        db.visitCrash(i, Date.now());
      }
      for (let i = 0; i < 2500; i++) db.insertDropped(1_000_000 + i, 'scrap', undefined, (i % 100 - 50) * 12, (Math.floor(i / 100) - 12) * 12);
    });
    const chunks = [];
    for (let i = 0; i < 500; i++) {
      const data = new Int32Array(EDIT_CHUNK * EDIT_CHUNK);
      for (let j = 0; j < data.length; j += 17) data[j] = -100 - (i + j) % 300;
      chunks.push({ cx: i % 25 - 12, cz: Math.floor(i / 25) - 10, data });
    }
    db.saveChunks(chunks);
  } finally { db.close(); }
}
