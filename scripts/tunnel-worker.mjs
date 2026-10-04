import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  connectorArguments,
  extractTemporaryUrl,
  publicHealthMatches,
  verifyPublicEntry,
} from './temporary-tunnel.mjs';

const [executable, configPath, localUrl, projectId, instanceId] = process.argv.slice(2);
let connector;
let stopping = false;
let url = '';
let tail = '';
const identity = { projectId, instanceId };
const send = (message) => {
  if (process.connected) process.send(message, () => {});
};
async function saveDiagnostic() {
  try {
    await mkdir('tmp', { recursive: true });
    await writeFile('tmp/public-tunnel.log', tail);
  } catch {}
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  if (connector?.pid && connector.exitCode === null && connector.signalCode === null) {
    await new Promise((done) => {
      connector.once('exit', done);
      connector.kill();
    });
  }
  await saveDiagnostic();
  process.exit(code);
}
process.on('disconnect', () => void shutdown());
process.on('message', (message) => {
  if (message?.type === 'shutdown') void shutdown();
});
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.on('exit', () => {
  if (connector?.exitCode === null) connector.kill();
});

try {
  if (!process.connected) throw new Error('联网组件需要由游戏启动器管理');
  if (!(await publicHealthMatches(localUrl, identity)))
    throw new Error('游戏服务在联网准备期间已退出，请重新双击启动。');
  const deadline = Date.now() + 150_000;
  let ready = false;
  for (let attempt = 1; attempt <= 3 && !stopping && Date.now() < deadline; attempt++) {
    let ended = false;
    tail = '';
    url = '';
    connector = spawn(executable, connectorArguments(localUrl, configPath), {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    connector.on('error', () => {
      ended = true;
    });
    connector.on('exit', async () => {
      ended = true;
      await saveDiagnostic();
      if (ready && !stopping) {
        send({ type: 'status', status: 'unavailable' });
        void shutdown(1);
      }
    });
    const output = (chunk) => {
      tail = (tail + chunk.toString('utf8')).slice(-16_384);
      const hadUrl = !!url;
      url ||= extractTemporaryUrl(tail) ?? '';
      if (!hadUrl && url) {
        send({ type: 'progress', message: '临时公网地址已分配，正在核对页面和实时联机，请稍候……' });
        void saveDiagnostic();
      }
      if (chunk.toString('utf8').includes('Registered tunnel connection')) void saveDiagnostic();
    };
    connector.stdout.on('data', output);
    connector.stderr.on('data', output);
    while (!stopping && !ended && Date.now() < deadline) {
      if (url && (await verifyPublicEntry(url, identity))) {
        if (!stopping && !ended) ready = true;
        break;
      }
      await delay(url ? 1500 : 150);
    }
    if (ready) break;
    if (attempt < 3 && !stopping && Date.now() < deadline) {
      send({ type: 'progress', message: `公网连接暂未成功，正在自动重试（${attempt + 1}/3）……` });
      await delay(attempt * 1500);
    }
  }
  if (!ready)
    throw new Error(
      '临时公网入口尚未连通，没有生成可用二维码。请检查电脑联网，稍后再次双击；同一 Wi-Fi 可使用“启动局域网游戏.cmd”。',
    );
  send({ type: 'status', status: 'ready', url });
  let failures = 0;
  let available = true;
  while (!stopping) {
    await delay(8000);
    if (stopping) break;
    const reachable = await publicHealthMatches(url, identity);
    failures = reachable ? 0 : failures + 1;
    if (!reachable && failures >= 3 && available) {
      available = false;
      await saveDiagnostic();
      send({
        type: 'progress',
        message: '公网入口暂时中断，二维码已收起。正在等待联网恢复，请保持启动窗口打开……',
      });
      send({ type: 'status', status: 'unavailable' });
    } else if (reachable && !available) {
      available = true;
      send({ type: 'progress', message: '公网入口已恢复，继续使用本次二维码和原牌桌。' });
      send({ type: 'status', status: 'ready', url });
    }
  }
} catch (error) {
  await saveDiagnostic();
  send({ type: 'tunnel-error', message: error.message });
  await shutdown(1);
}
