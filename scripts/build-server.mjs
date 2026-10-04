import { build } from 'esbuild';
import { writeBuildInfo } from './build-fingerprint.mjs';

const buildRoot = process.env.FAMILY_DDZ_BUILD_MODE === 'public' ? 'dist/public' : 'dist';
await build({
  entryPoints: ['apps/server/src/index.ts'],
  outfile: `${buildRoot}/server/index.js`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  target: 'node22',
  sourcemap: true,
});

await writeBuildInfo(process.cwd(), buildRoot);
