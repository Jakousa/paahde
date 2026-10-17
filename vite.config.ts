import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs so the build works under any path (served at herkku.org/dadajam/).
  base: './',
  build: { target: 'es2022' },
  define: { __BUILD_SHA__: JSON.stringify(process.env.BUILD_SHA ?? 'dev') },
});
