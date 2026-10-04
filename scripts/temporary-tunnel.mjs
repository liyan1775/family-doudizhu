import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, chmod, writeFile } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopChild } from './managed-child.mjs';

// Official release assets and SHA-256 digests, checked on 2026-10-04.
// Keep versions pinned: never execute an unverified latest download.
export const CONNECTOR_VERSION = '2026.9.3';
const ARTIFACTS = {
  'win32-x64': [
    'cloudflared-windows-amd64.exe',
    'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2',
  ],
  'win32-ia32': [
    'cloudflared-windows-386.exe',
    '9b95ddc2eba67b86ed3dc4cc2a15881960563031b52ce564376af41fb91ad402',
  ],
  'linux-x64': [
    'cloudflared-linux-amd64',
    '77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2',
  ],
  'linux-arm64': [
    'cloudflared-linux-arm64',
    'aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d',
  ],
};

async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function downloadVerified(
  url,
  destination,
  digest,
  { fetcher = fetch, maxBytes = 80 * 1024 * 1024, timeout = 15 * 60_000, log = () => {} } = {},
) {
  const partial = `${destination}.${randomUUID()}.part`;
  let file;
  try {
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': 'family-doudizhu-launcher' },
    });
    if (!response.ok || !response.body) throw new Error('下载服务暂时不可用');
    if (response.url && new URL(response.url).protocol !== 'https:')
      throw new Error('下载地址不是安全连接');
    if (Number(response.headers.get('content-length')) > maxBytes)
      throw new Error('下载文件大小异常');
    file = await open(partial, 'wx');
    const hash = createHash('sha256');
    let size = 0;
    let lastProgress = Date.now();
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new Error('下载文件大小异常');
      hash.update(chunk);
      await file.writeFile(chunk);
      if (Date.now() - lastProgress > 15_000) {
        log(`正在下载联网组件，已收到${Math.round(size / 1024 / 1024)} MB，请稍候……`);
        lastProgress = Date.now();
      }
    }
    if (hash.digest('hex') !== digest) throw new Error('联网组件校验失败，未运行下载文件');
    await file.close();
    file = null;
    await rename(partial, destination);
  } finally {
    await file?.close();
    await rm(partial, { force: true });
  }
}

export async function ensureConnector({
  directory,
  log = console.log,
  platform = process.platform,
  arch = process.arch,
}) {
  // Windows on ARM can run the official x64 executable through its emulator.
  const key = `${platform}-${platform === 'win32' && arch === 'arm64' ? 'x64' : arch}`;
  const artifact = ARTIFACTS[key];
  if (!artifact) throw new Error('这台电脑暂不支持自动公网启动，请使用 Windows 电脑。');
  const [name, digest] = artifact;
  const folder = resolve(directory, 'data/tools/cloudflared', CONNECTOR_VERSION, key);
  const executable = resolve(folder, platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  const configPath = resolve(folder, 'empty.yml');
  await mkdir(folder, { recursive: true });
  let valid = false;
  try {
    valid = (await fileHash(executable)) === digest;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!valid) {
    log('首次公网启动，正在自动准备联网组件，无需安装或注册，请稍候……');
    try {
      await downloadVerified(
        `https://github.com/cloudflare/cloudflared/releases/download/${CONNECTOR_VERSION}/${name}`,
        executable,
        digest,
        { log },
      );
    } catch (error) {
      throw new Error(
        `联网组件没有准备好：${error.message}。请确认电脑可以访问 GitHub，然后重新双击；同一 Wi-Fi 可使用“启动局域网游戏.cmd”。`,
      );
    }
  }
  if (platform !== 'win32') await chmod(executable, 0o755);
  // An explicit empty configuration avoids adopting the user's named tunnel.
  await writeFile(configPath, '{}\n');
  return { executable, configPath };
}

export function extractTemporaryUrl(output) {
  return (
    output
      .match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com(?=$|[\s|])/i)?.[0]
      ?.toLowerCase() ?? null
  );
}

export function connectorArguments(localUrl, configPath) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(localUrl))
    throw new Error('联网组件只能连接本机游戏服务');
  return [
    'tunnel',
    '--config',
    configPath,
    '--url',
    localUrl,
    '--no-autoupdate',
    '--protocol',
    'http2',
    '--edge-ip-version',
    '4',
    '--metrics',
    '127.0.0.1:0',
  ];
}

export async function publicHealthMatches(url, { projectId, instanceId }, timeout = 6000) {
  try {
    const response = await fetch(`${url}/api/health`, {
      signal: AbortSignal.timeout(timeout),
      redirect: 'error',
      cache: 'no-store',
    });
    if (!response.ok) return false;
    if (!response.body) return false;
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) {
        await reader.cancel();
        return false;
      }
      chunks.push(Buffer.from(value));
    }
    const health = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return (
      health.ok === true &&
      health.service === 'family-doudizhu' &&
      health.projectId === projectId &&
      health.instanceId === instanceId &&
      health.entryMode === 'temporary'
    );
  } catch {
    return false;
  }
}

export async function verifyPublicEntry(url, identity, { timeout = 6000 } = {}) {
  if (!/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(url)) return false;
  if (!(await publicHealthMatches(url, identity, timeout))) return false;
  return verifyRealtimeEntry(url, { timeout });
}

export async function verifyRealtimeEntry(url, { timeout = 6000 } = {}) {
  // Import only after npm ci: first use must not require preinstalled packages.
  const { io } = await import('socket.io-client');
  for (const transport of ['websocket', 'polling']) {
    const connected = await new Promise((done) => {
      let finished = false;
      const socket = io(url, {
        transports: [transport],
        upgrade: false,
        reconnection: false,
        forceNew: true,
        timeout,
      });
      const finish = (ok) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        socket.disconnect();
        done(ok);
      };
      const timer = setTimeout(() => finish(false), timeout * 2);
      socket.once('connect', () => {
        socket
          .timeout(timeout)
          .emit('join-room', { roomId: '', name: '' }, (error, ack) =>
            finish(!error && ack?.ok === false && ack.error === '请输入6位房间号'),
          );
      });
      socket.once('connect_error', () => finish(false));
    });
    if (connected) return true;
  }
  return false;
}

export async function startTemporaryTunnel({
  directory,
  localUrl,
  projectId,
  instanceId,
  log = console.log,
  onStatus = async () => {},
}) {
  const { executable, configPath } = await ensureConnector({ directory, log });
  log('正在连接临时公网入口，并检查扫码页面和实时联机……');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('TUNNEL_')),
  );
  const child = fork(
    fileURLToPath(new URL('./tunnel-worker.mjs', import.meta.url)),
    [executable, configPath, localUrl, projectId, instanceId],
    {
      cwd: directory,
      execArgv: [],
      env,
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      windowsHide: true,
    },
  );
  try {
    return await new Promise((done, fail) => {
      let ready = false;
      let updates = Promise.resolve();
      const timer = setTimeout(
        () => fail(new Error('公网入口连接超时。请检查电脑的互联网连接，稍后再次双击。')),
        180_000,
      );
      child.on('message', (message) => {
        if (message?.type === 'progress') log(message.message);
        if (message?.type === 'status') {
          updates = updates
            .then(async () => {
              await onStatus({ status: message.status, url: message.url });
              if (message.status === 'ready' && !ready) {
                ready = true;
                clearTimeout(timer);
                done({ child, url: message.url });
              }
            })
            .catch((error) => {
              if (!ready) fail(error);
            });
        } else if (message?.type === 'tunnel-error') {
          clearTimeout(timer);
          fail(new Error(message.message));
        }
      });
      child.once('error', () => {
        clearTimeout(timer);
        fail(new Error('联网组件无法启动，请检查电脑安全软件是否阻止了它。'));
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (!ready) fail(new Error('联网组件已退出，没有生成可用公网二维码。请稍后重新双击。'));
        else {
          updates = updates.then(() => onStatus({ status: 'unavailable' })).catch(() => {});
          if (code !== 0) log('公网入口已结束。请关闭本次启动窗口，再双击重新开桌并分享新二维码。');
        }
      });
    });
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}
