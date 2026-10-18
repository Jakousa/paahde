import { defineConfig } from 'vite';

const BUILD_SHA = process.env.BUILD_SHA ?? 'dev';

export default defineConfig({
  // Relative asset URLs so the build works under any path (served at herkku.org/dadajam/).
  base: './',
  build: {
    target: 'es2022',
    // models-lab.html: model review page (src/models/lab.ts), served at ./models-lab.html
    rollupOptions: {
      input: { main: 'index.html', lab: 'models-lab.html' },
      // three and the other libraries in a chunk of their own: its hash only changes when they do, so a
      // deploy of game code leaves it in the browser's cache.
      output: { codeSplitting: { groups: [{ name: 'vendor', test: /node_modules/ }] } },
    },
  },
  define: { __BUILD_SHA__: JSON.stringify(BUILD_SHA) },
  // The server reads dist/version.txt and tells clients, which reload when they're out of date.
  plugins: [
    {
      name: 'version-file',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.txt', source: BUILD_SHA });
      },
    },
  ],
  // In dev, the game server runs separately (npm run dev starts both); proxy its WebSocket.
  server: {
    // Docker dev (docker-compose.yml): listen on all interfaces and poll for changes on the bind mount.
    host: process.env.DEV_DOCKER ? true : undefined,
    proxy: { '/ws': { target: 'ws://localhost:8787', ws: true } },
    // Agent worktrees live under .claude/; their builds shouldn't reload this dev server.
    watch: { ignored: ['**/.claude/**'], usePolling: !!process.env.DEV_DOCKER },
  },
});
