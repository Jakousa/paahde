import { defineConfig } from 'vite';

const BUILD_SHA = process.env.BUILD_SHA ?? 'dev';

export default defineConfig({
  // Relative asset URLs so the build works under any path (served at herkku.org/dadajam/).
  base: './',
  build: { target: 'es2022' },
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
    proxy: { '/ws': { target: 'ws://localhost:8787', ws: true } },
    // Agent worktrees live under .claude/; their builds shouldn't reload this dev server.
    watch: { ignored: ['**/.claude/**'] },
  },
});
