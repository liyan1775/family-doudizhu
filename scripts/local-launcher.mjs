import { createHash } from 'node:crypto';
import { fork, spawn } from 'node:child_process';
import { readFile, realpath, mkdir, writeFile, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { isBuildCurrent } from './build-fingerprint.mjs';

export const SERVICE = 'family-doudizhu';
const GATE_SERVICE = 'family-doudizhu-launcher';
const STATE_FILE = 'tmp/local-launcher.json';

export async function projectId(directory) {
  const path = await realpath(directory);
  return createHash('sha256')
    .update(process.platform === 'win32' ? path.toLowerCase() : path)
    .digest('hex')
    .slice(0, 24);
}

export async function readConfig(directory, environment = process.env) {
  let fromFile = {};
  try {
    fromFile = parseEnv(await readFile(resolve(directory, '.env'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw new Error('无法读取游戏配置，请检查 .env 文件是否可以打开。');
  }
  const env = { ...fromFile, ...environment };
  const portText = env.PORT ?? '3000';
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
    throw new Error('启动没有成功：.env 中的 PORT 应填写1到65535之间的整数，例如 PORT=3000。');
  }
  if (env.PUBLIC_BASE_URL) {
    try {
      if (!['http:', 'https:'].includes(new URL(env.PUBLIC_BASE_URL).protocol)) throw new Error();
    } catch {
      throw new Error('.env 中的 PUBLIC_BASE_URL 不是完整的网址，请检查后再启动。');
    }
  }
  const host = env.HOST || '0.0.0.0';
  const contactHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  const authority = contactHost.includes(':') ? `[${contactHost}]` : contactHost;
  return {
    directory,
    id: await projectId(directory),
    env,
    host,
    port: Number(portText),
    base: (port) => `http://${authority}:${port}`,
    page: (port) =>
      host === '0.0.0.0' || host === '::'
        ? `http://localhost:${port}`
        : `http://${authority}:${port}`,
  };
}

async function readUrl(url, timeout = 800) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: 'error' });
    if (!response.ok) return null;
    const reader = response.body.getReader();
    let size = 0;
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return null;
  }
}

async function readJsonUrl(url) {
  try {
    return JSON.parse(await readUrl(url));
  } catch {
    return null;
  }
}

export async function probeGame(config, port, allowLegacy = false) {
  const url = config.base(port);
  const health = await readJsonUrl(`${url}/api/health`);
  if (!health?.ok) return null;
  if (health.service === SERVICE && health.projectId === config.id) {
    return { port, url: config.page(port), version: health.version, legacy: false };
  }
  // The original release had no service identity. Only adopt its exact local
  // game page and configuration at the requested port; never terminate it.
  if (allowLegacy && !health.service) {
    let localHtml;
    try {
      localHtml = await readFile(resolve(config.directory, 'dist/client/index.html'), 'utf8');
    } catch {
      return null;
    }
    if (!localHtml.includes('<title>聚会斗地主 · 家人围一桌</title>')) return null;
    const [html, settings] = await Promise.all([readUrl(url), readJsonUrl(`${url}/api/config`)]);
    if (html === localHtml && Array.isArray(settings?.localUrls) && 'publicBaseUrl' in settings) {
      return { port, url: config.page(port), version: null, legacy: true };
    }
  }
  return null;
}

function candidatePorts(port) {
  return Array.from({ length: Math.min(21, 65536 - port) }, (_, offset) => port + offset);
}

async function existingGame(config) {
  let saved;
  try {
    saved = JSON.parse(await readFile(resolve(config.directory, STATE_FILE), 'utf8'));
  } catch {}
  if (
    saved?.projectId === config.id &&
    saved.host === config.host &&
    saved.preferredPort === config.port &&
    Number.isInteger(saved.port) &&
    saved.port >= 1 &&
    saved.port <= 65535
  ) {
    const game = await probeGame(config, saved.port);
    if (game) return game;
  }
  const ports = candidatePorts(config.port);
  const results = await Promise.all(
    ports.map((port) => probeGame(config, port, port === config.port)),
  );
  return results.find(Boolean) ?? null;
}

async function listen(server, port, host) {
  await new Promise((done, fail) => {
    const onError = (error) => {
      server.off('listening', onReady);
      fail(error);
    };
    const onReady = () => {
      server.off('error', onError);
      done();
    };
    server.once('error', onError);
    server.once('listening', onReady);
    server.listen({ port, host, exclusive: true });
  });
}

async function closeListener(server) {
  if (server.listening) await new Promise((done) => server.close(done));
}

// A loopback socket acts as an OS-owned startup lock. Crashes release it, so a
// stale PID or lock file cannot block the next double-click.
async function acquireStartupGate(config, log) {
  const first = 40000 + (parseInt(config.id.slice(0, 8), 16) % 15000);
  const deadline = Date.now() + 10 * 60_000;
  let announced = false;
  for (let offset = 0; offset < 20; offset++) {
    const port = 40000 + ((first - 40000 + offset * 997) % 15000);
    while (Date.now() < deadline) {
      const gate = createServer((_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ service: GATE_SERVICE, projectId: config.id }));
      });
      try {
        await listen(gate, port, '127.0.0.1');
        return gate;
      } catch (error) {
        if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
        const owner = await readJsonUrl(`http://127.0.0.1:${port}`);
        if (owner?.service === GATE_SERVICE && owner.projectId === config.id) {
          if (!announced) {
            log('游戏正在准备，请稍候。连续双击也只会启动一次。');
            announced = true;
          }
          await delay(250);
          continue;
        }
        // Retry this socket once in case its previous owner just exited.
        try {
          await listen(gate, port, '127.0.0.1');
          return gate;
        } catch {}
        break;
      }
    }
    if (Date.now() >= deadline)
      throw new Error('游戏仍在准备，请查看原来的启动窗口；稍后可以再次双击。');
  }
  throw new Error('启动保护暂时不可用，请稍后再次双击“启动游戏”。');
}

async function portAvailable(port, host) {
  const socket = createSocketServer();
  try {
    await listen(socket, port, host);
    return true;
  } catch (error) {
    if (['EADDRINUSE', 'EACCES'].includes(error.code)) return false;
    throw new Error('无法使用配置的网络地址，请检查 .env 中的 HOST；家庭试玩可填写 HOST=0.0.0.0。');
  } finally {
    await closeListener(socket);
  }
}

export function publicUrlForPort(value, preferred, selected) {
  if (!value || preferred === selected) return value || '';
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('.env 中的 PUBLIC_BASE_URL 不是完整的网址，请检查后再启动。');
  }
  const localHosts = new Set([
    'localhost',
    '127.0.0.1',
    '[::1]',
    ...Object.values(networkInterfaces()).flatMap((items) =>
      (items ?? [])
        .filter((item) => item.family === 'IPv4' && !item.internal)
        .map((item) => item.address),
    ),
  ]);
  if (
    url.protocol === 'http:' &&
    localHosts.has(url.hostname) &&
    Number(url.port || 80) === preferred
  ) {
    url.port = String(selected);
    return url.href.replace(/\/$/, '');
  }
  throw new Error(
    `端口${preferred}正被其他程序使用。当前配置了固定的对外网址，无法自动换端口；家庭试玩请清空 .env 中的 PUBLIC_BASE_URL 后再双击。`,
  );
}

async function npmCommand(directory, args) {
  await new Promise((done, fail) => {
    // Commands are fixed here; no user text is interpolated into shell code.
    const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm';
    const commandArgs =
      process.platform === 'win32' ? ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`] : args;
    const child = spawn(command, commandArgs, {
      cwd: directory,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', fail);
    child.once('exit', (code) =>
      code === 0 ? done() : fail(new Error(`npm ${args.join(' ')} 未完成`)),
    );
  });
}

async function prepareBuild(directory, log) {
  const required = [
    'node_modules/express/package.json',
    'node_modules/socket.io/package.json',
    'node_modules/vite/package.json',
    'node_modules/typescript/package.json',
    'node_modules/esbuild/package.json',
  ];
  const installed = (
    await Promise.all(
      required.map(async (file) => {
        try {
          await access(resolve(directory, file));
          return true;
        } catch {
          return false;
        }
      }),
    )
  ).every(Boolean);
  if (!installed) {
    log('首次使用，正在准备游戏组件，请保持联网并稍候……');
    try {
      await npmCommand(directory, ['ci']);
    } catch {
      throw new Error('游戏组件没有准备完成。请确认电脑可以联网，再双击“启动游戏”。');
    }
  }
  if (await isBuildCurrent(directory)) return;
  log('正在准备最新的游戏内容，请稍候……');
  try {
    await npmCommand(directory, ['run', 'build']);
  } catch {
    throw new Error('游戏内容没有构建成功。请保留上方提示，并交给项目维护者检查。');
  }
}

export async function stopChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise((done) => child.once('exit', done));
  if (child.connected) {
    try {
      child.send({ type: 'shutdown' }, () => {});
    } catch {}
  } else child.kill();
  const timer = setTimeout(() => child.kill(), 3000);
  try {
    await stopped;
  } finally {
    clearTimeout(timer);
  }
}

async function startServer(config, port, publicBaseUrl) {
  const child = fork(resolve(config.directory, 'dist/server/index.js'), [], {
    cwd: config.directory,
    execArgv: [],
    env: { ...process.env, ...config.env, PORT: String(port), PUBLIC_BASE_URL: publicBaseUrl },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
  });
  try {
    await new Promise((done, fail) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.off('error', onError);
        child.off('exit', onExit);
        child.off('message', onMessage);
      };
      const onError = () => {
        cleanup();
        fail(new Error('游戏服务没有启动成功，请确认 Node.js 安装完整。'));
      };
      const onExit = () => {
        cleanup();
        fail(new Error('游戏服务在启动时退出，请保留上方提示并交给项目维护者检查。'));
      };
      const onMessage = (message) => {
        if (message?.type === 'ready' && message.port === port) {
          cleanup();
          done();
        } else if (message?.type === 'startup-error') {
          cleanup();
          fail(Object.assign(new Error('游戏端口暂时不可用。'), { code: message.code }));
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        fail(new Error('游戏启动用时过长，请稍后再次双击。'));
      }, 20_000);
      child.once('error', onError);
      child.once('exit', onExit);
      child.on('message', onMessage);
    });
    if (!(await probeGame(config, port)))
      throw new Error('游戏尚未准备好，未打开页面。请保留上方提示并交给项目维护者检查。');
    return child;
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

export async function openBrowser(url) {
  if (process.platform !== 'win32') return;
  await new Promise((done, fail) => {
    const browser = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Start-Process -FilePath $env:FAMILY_DDZ_START_URL',
      ],
      { env: { ...process.env, FAMILY_DDZ_START_URL: url }, windowsHide: true, stdio: 'ignore' },
    );
    browser.once('error', fail);
    browser.once('exit', (code) => (code === 0 ? done() : fail(new Error('浏览器未打开'))));
  });
}

export async function launchLocal({
  directory,
  environment = process.env,
  log = console.log,
  browser = openBrowser,
}) {
  const config = await readConfig(directory, environment);
  const show = async (game, reused) => {
    const hostUrl = new URL('/?host=1', game.url).href;
    log(
      reused
        ? `电脑主机已经在运行，正在展示扫码二维码：${hostUrl}`
        : `电脑主机已准备好，正在展示扫码二维码：${hostUrl}`,
    );
    if (reused) {
      const version = JSON.parse(
        await readFile(resolve(directory, 'package.json'), 'utf8'),
      ).version;
      if (game.legacy || game.version !== version)
        log('原来的牌局会继续保留。新版本将在原游戏窗口关闭、再次启动后生效。');
    }
    try {
      await browser(hostUrl);
    } catch {
      log(`浏览器没有自动打开，请在这台电脑上打开 ${hostUrl}，即可展示手机扫码二维码。`);
    }
  };
  const running = await existingGame(config);
  if (running) {
    await show(running, true);
    return { kind: 'reused', ...running };
  }
  const gate = await acquireStartupGate(config, log);
  let child;
  try {
    const ready = await existingGame(config);
    if (ready) {
      await show(ready, true);
      return { kind: 'reused', ...ready };
    }
    // Preserve a healthy live game before touching any of its served files.
    await prepareBuild(directory, log);
    for (const port of candidatePorts(config.port)) {
      if (!(await portAvailable(port, config.host))) continue;
      const publicBaseUrl = publicUrlForPort(config.env.PUBLIC_BASE_URL, config.port, port);
      try {
        child = await startServer(config, port, publicBaseUrl);
      } catch (error) {
        if (['EADDRINUSE', 'EACCES'].includes(error.code)) continue;
        throw error;
      }
      const game = { port, url: config.page(port), child };
      await mkdir(resolve(directory, 'tmp'), { recursive: true });
      await writeFile(
        resolve(directory, STATE_FILE),
        JSON.stringify({
          projectId: config.id,
          host: config.host,
          preferredPort: config.port,
          port,
        }),
      );
      if (port !== config.port)
        log(`常用端口${config.port}正在使用，已自动改用${port}。请使用当前页面生成的二维码。`);
      await show(game, false);
      log('手机和电脑连接同一 Wi-Fi。请保持这个窗口打开；结束游戏时关闭窗口。');
      return { kind: 'started', ...game };
    }
    throw new Error('附近的游戏端口都无法使用。请关闭以前的游戏启动窗口，或稍后再次双击。');
  } catch (error) {
    if (child) await stopChild(child);
    throw error;
  } finally {
    await closeListener(gate);
  }
}
