import { build } from 'esbuild';

await build({
  entryPoints: ['apps/server/src/index.ts'],
  outfile: 'dist/server/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  target: 'node22',
  sourcemap: true,
});
