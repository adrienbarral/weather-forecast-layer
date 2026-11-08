import { defineConfig } from 'vite';

export default defineConfig({
  root: 'demo',
  optimizeDeps: { exclude: ['@azohra/meteo.grib'] },
  server: { proxy: { '/data': { target: 'http://127.0.0.1:8080', rewrite: path => path.replace(/^\/data/, '') } } },
  build: { outDir: '../dist-demo', emptyOutDir: true },
});