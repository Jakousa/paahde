import type * as THREE from 'three/webgpu';
import { TEXT } from '../shared/text.ts';

export function showReload(message: string) {
  document.exitPointerLock();
  if (document.getElementById('graphicsRecovery')) return;
  const panel = document.createElement('div');
  panel.id = 'graphicsRecovery';
  panel.setAttribute('role', 'alertdialog');
  panel.setAttribute('aria-modal', 'true');
  panel.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;background:#1a1214;color:#fff0db;font:20px system-ui';
  const title = document.createElement('div');
  title.textContent = message;
  const button = document.createElement('button');
  button.textContent = TEXT.recovery.retry;
  button.style.cssText = 'font:inherit;padding:12px 32px;cursor:pointer';
  button.onclick = () => location.reload();
  panel.append(title, button);
  document.body.append(panel);
  button.focus();
}

/** Stop gameplay as soon as drawing is impossible, and keep a keyboard-accessible route back to the same world. */
export async function initializeRenderer(renderer: THREE.WebGPURenderer, stop: () => void) {
  let failed = false, initialized = false;
  const fail = (startup = false) => {
    if (failed) return;
    failed = true;
    stop();
    if (initialized) void renderer.setAnimationLoop(null);
    showReload(startup ? TEXT.recovery.unavailable : TEXT.recovery.graphics);
  };
  const original = renderer.onDeviceLost;
  renderer.onDeviceLost = (info) => { original.call(renderer, info); fail(); };
  renderer.domElement.addEventListener('webglcontextlost', (event) => { event.preventDefault(); fail(); });
  try {
    await renderer.init();
    initialized = true;
  } catch (error) {
    console.error('Graphics initialization failed', error);
    fail(true);
  }
  // Do not start models, prediction or the render loop after initialization/loss failed. The button reloads the page.
  if (failed) await new Promise<never>(() => {});
  return () => !failed;
}
