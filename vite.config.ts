import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: 'weather-forecast-layer' },
    rollupOptions: { external: /^ol(?:\/|$)/ },
  },
});