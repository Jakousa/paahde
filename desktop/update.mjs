// Electron adapter; content validation and atomic activation are tested independently.
import { app, net } from 'electron';
import { contentStore } from './content.mjs';

export function gameFiles(dist, server, progress) {
  return contentStore({ dist, server, userData: app.getPath('userData'), fetchFile: net.fetch, progress });
}
