import { defineConfig } from 'vite';

// Served from https://<user>.github.io/stl-kit/ on GitHub Pages, so assets need the
// repo name as base path. Locally (dev/preview) the root works too.
export default defineConfig({
  base: '/stl-kit/',
});
