import { defineConfig } from 'vite';

export default defineConfig({
  root: 'demo',
  base: process.env.GITHUB_ACTIONS === 'true' ? '/weather-forecast-layer/' : '/',
  optimizeDeps: { exclude: ['@azohra/meteo.grib'] },
  server: { proxy: { '/data': { target: 'http://127.0.0.1:8080', rewrite: path => path.replace(/^\/data/, '') } } },
  build: { outDir: '../dist-demo', emptyOutDir: true },
});