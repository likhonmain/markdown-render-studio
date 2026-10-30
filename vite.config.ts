import { defineConfig } from 'vite';

// `base: './'` keeps every asset URL relative, so the `dist/` folder works on
// GitHub Pages project sites, Cloudflare Pages, or opened from any sub-path.
export default defineConfig({
  plugins: [],
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  server: {
    host: true,
    port: 5178,
    strictPort: false,
  },
});
