import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: '.',
  // Relative, because Electron loads the renderer from file:// in production.
  base: './',
  plugins: [react()],
  build: { outDir: 'dist/renderer', emptyOutDir: true },
  server: { port: 5199, strictPort: true },
});
