import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchLocal, stopChild } from './local-launcher.mjs';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error('请安装 Node.js 24 LTS 后，再双击“启动游戏”。当前 Node.js 版本过旧。');
  process.exitCode = 1;
} else {
  try {
    const directory = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
    process.chdir(directory);
    console.log('聚会斗地主 · 正在为您打开游戏');
    const result = await launchLocal({
      directory,
      mode: process.argv.includes('--public') ? 'public' : 'lan',
      ...(process.env.FAMILY_DDZ_NO_BROWSER === '1' ? { browser: async () => {} } : {}),
    });
    if (result.child) {
      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        await stopChild(result.tunnel);
        await stopChild(result.child);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      const code = await new Promise((done) => {
        if (result.child.exitCode !== null) done(result.child.exitCode);
        else result.child.once('exit', done);
      });
      process.exitCode = stopping ? 0 : (code ?? 1);
      await stopChild(result.tunnel);
    }
  } catch (error) {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  }
}
