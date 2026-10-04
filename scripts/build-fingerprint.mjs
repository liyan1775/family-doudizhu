import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function filesUnder(directory, relative) {
  try {
    const entries = await readdir(resolve(directory, relative), { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const path = `${relative}/${entry.name}`;
        return entry.isDirectory() ? filesUnder(directory, path) : entry.isFile() ? [path] : [];
      }),
    );
    return files.flat();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function hashFiles(directory, files) {
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    hash
      .update(file)
      .update('\0')
      .update(await readFile(resolve(directory, file)))
      .update('\0');
  }
  return hash.digest('hex');
}

export async function sourceHash(directory) {
  const folders = ['apps/web/src', 'apps/web/public', 'apps/server/src', 'packages/game/src'];
  const fixed = [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'apps/web/index.html',
    'apps/web/vite.config.ts',
    'scripts/build-server.mjs',
    'scripts/build-fingerprint.mjs',
    'scripts/voice-lines.json',
  ];
  const present = [];
  for (const file of fixed) {
    try {
      if ((await stat(resolve(directory, file))).isFile()) present.push(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return hashFiles(directory, [
    ...present,
    ...(await Promise.all(folders.map((path) => filesUnder(directory, path)))).flat(),
  ]);
}

async function outputHash(directory, buildRoot) {
  return hashFiles(
    directory,
    (
      await Promise.all(
        [`${buildRoot}/client`, `${buildRoot}/server`].map((path) => filesUnder(directory, path)),
      )
    ).flat(),
  );
}

export async function writeBuildInfo(directory, buildRoot = 'dist') {
  const info = {
    schema: 1,
    source: await sourceHash(directory),
    output: await outputHash(directory, buildRoot),
  };
  await writeFile(resolve(directory, buildRoot, 'build-info.json'), JSON.stringify(info));
}

export async function isBuildCurrent(directory, buildRoot = 'dist') {
  try {
    const info = JSON.parse(
      await readFile(resolve(directory, buildRoot, 'build-info.json'), 'utf8'),
    );
    if (info.schema !== 1) return false;
    for (const file of [`${buildRoot}/client/index.html`, `${buildRoot}/server/index.js`]) {
      if (!(await stat(resolve(directory, file))).isFile()) return false;
    }
    return (
      info.source === (await sourceHash(directory)) &&
      info.output === (await outputHash(directory, buildRoot))
    );
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw error;
  }
}
