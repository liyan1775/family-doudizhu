import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm, stat, utimes } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { io } from 'socket.io-client';
import { makeServer } from '../apps/server/src/server.ts';
import {
  launchLocal,
  projectId,
  probeGame,
  publicUrlForPort,
  readConfig,
  stopChild,
} from '../scripts/local-launcher.mjs';
import { isBuildCurrent, writeBuildInfo } from '../scripts/build-fingerprint.mjs';

const testRoot = resolve('tmp/launcher-tests');
const html = '<!doctype html><title>聚会斗地主 · 家人围一桌</title><p>开桌</p>';

async function listen(server, port = 0) {
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', done);
  });
  return server.address().port;
}
async function close(server) {
  await new Promise((done) => server.close(done));
}
async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function fixture(t, port, health) {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(resolve(testRoot, 'case with space-'));
  const children = [];
  t.after(async () => {
    for (const child of children) await stopChild(child);
    // Recursive removal is limited to this test's newly-created directory.
    assert.ok(resolve(directory).startsWith(testRoot + sep));
    await rm(directory, { recursive: true, force: true });
  });
  for (const folder of ['dist/client', 'dist/server', 'apps/web/src', 'tmp']) {
    await mkdir(resolve(directory, folder), { recursive: true });
  }
  for (const name of ['express', 'socket.io', 'vite', 'typescript', 'esbuild']) {
    await mkdir(resolve(directory, 'node_modules', name), { recursive: true });
    await writeFile(resolve(directory, 'node_modules', name, 'package.json'), '{}');
  }
  await writeFile(resolve(directory, '.env'), `PORT=${port}\nHOST=127.0.0.1\n`);
  await writeFile(resolve(directory, 'package.json'), '{"type":"module","version":"1.0.0"}');
  await writeFile(resolve(directory, 'dist/client/index.html'), html);
  await writeFile(resolve(directory, 'apps/web/src/example.ts'), 'before');
  const id = await projectId(directory);
  const identity = health ?? {
    ok: true,
    service: 'family-doudizhu',
    projectId: id,
    version: '1.0.0',
  };
  const childSource = `
    import { createServer } from 'node:http';
    import { appendFileSync } from 'node:fs';
    const port = Number(process.env.PORT);
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url === '/api/config'
        ? { publicBaseUrl: process.env.PUBLIC_BASE_URL || null, localUrls: ['http://192.168.0.2:' + port] }
        : ${JSON.stringify(identity)}));
    });
    server.once('error', (error) => process.send({ type: 'startup-error', code: error.code }, () => process.exit(1)));
    server.listen(port, process.env.HOST, () => {
      appendFileSync('tmp/server-starts.txt', 'started\\n');
      setTimeout(() => process.send({ type: 'ready', port }), 100);
    });
    let stopping = false;
    const stop = () => { if (stopping) return; stopping = true; server.close(() => process.exit(0)); };
    process.on('message', (message) => { if (message?.type === 'shutdown') stop(); });
    process.on('disconnect', stop);
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  `;
  await writeFile(resolve(directory, 'dist/server/index.js'), childSource);
  await writeBuildInfo(directory);
  const urls = [];
  const messages = [];
  const launch = async (extra = {}) => {
    const result = await launchLocal({
      directory,
      environment: {},
      browser: async (url) => urls.push(url),
      log: (line) => messages.push(line),
      ...extra,
    });
    if (result.child) children.push(result.child);
    return result;
  };
  return { directory, id, launch, urls, messages };
}

test('启动配置遵循环境变量优先级，错误端口和网址给出中文处理说明', async (t) => {
  const f = await fixture(t, 32100);
  const fromFile = await readConfig(f.directory, {});
  assert.equal(fromFile.port, 32100);
  assert.equal((await readConfig(f.directory, { PORT: '32101' })).port, 32101);
  for (const port of ['0', '65536', '3.5', 'oops', '']) {
    await assert.rejects(readConfig(f.directory, { PORT: port }), /PORT.*1到65535/);
  }
  await assert.rejects(readConfig(f.directory, { PUBLIC_BASE_URL: 'bad-url' }), /完整的网址/);
});

test('构建缓存检测源码变化、输出损坏和文件缺失，不依赖文件时间', async (t) => {
  const f = await fixture(t, 32100);
  assert.equal(await isBuildCurrent(f.directory), true);
  const source = resolve(f.directory, 'apps/web/src/example.ts');
  const before = await stat(source);
  await writeFile(source, 'after!');
  await utimes(source, before.atime, before.mtime);
  assert.equal(await isBuildCurrent(f.directory), false);
  await writeBuildInfo(f.directory);
  await mkdir(resolve(f.directory, 'scripts'), { recursive: true });
  await writeFile(resolve(f.directory, 'scripts/voice-lines.json'), JSON.stringify({ test: '新报牌' }));
  assert.equal(await isBuildCurrent(f.directory), false, '网页导入的声音文案也参与构建缓存校验');
  await writeBuildInfo(f.directory);
  await writeFile(resolve(f.directory, 'dist/client/index.html'), html + 'broken');
  assert.equal(await isBuildCurrent(f.directory), false);
  await writeBuildInfo(f.directory);
  await rm(resolve(f.directory, 'dist/server/index.js'));
  assert.equal(await isBuildCurrent(f.directory), false);
});

test(
  '缓存失效时在中文和空格路径实际执行npm构建，准备完成后才打开页面',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t, await freePort());
    await writeFile(
      resolve(f.directory, 'package.json'),
      JSON.stringify({
        type: 'module',
        version: '1.0.0',
        scripts: { build: 'node build.mjs' },
      }),
    );
    const helper = pathToFileURL(resolve('scripts/build-fingerprint.mjs')).href;
    await writeFile(
      resolve(f.directory, 'build.mjs'),
      `
    import { writeBuildInfo } from ${JSON.stringify(helper)};
    import { writeFile } from 'node:fs/promises';
    await writeFile('tmp/build-ran.txt', 'built');
    await writeBuildInfo(process.cwd());
  `,
    );
    assert.equal(await isBuildCurrent(f.directory), false);
    const result = await f.launch();
    assert.equal(result.kind, 'started');
    assert.equal(await readFile(resolve(f.directory, 'tmp/build-ran.txt'), 'utf8'), 'built');
    assert.equal(await isBuildCurrent(f.directory), true);
    assert.equal(f.urls.length, 1);
  },
);

test(
  '连续双击共用一个服务，关闭后遗留的运行记录不会阻止重新启动',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t, await freePort());
    await writeFile(resolve(f.directory, 'tmp/local-launcher.json'), 'old broken state');
    const launches = await Promise.all([f.launch(), f.launch()]);
    assert.deepEqual(launches.map((result) => result.kind).sort(), ['reused', 'started']);
    assert.equal(launches[0].port, launches[1].port);
    assert.equal(f.urls.length, 2);
    for (const url of f.urls) {
      const opened = new URL(url);
      assert.equal(opened.pathname, '/');
      assert.equal(opened.searchParams.get('host'), '1');
      assert.equal(opened.searchParams.has('room'), false);
    }
    assert.equal(
      await readFile(resolve(f.directory, 'tmp/server-starts.txt'), 'utf8'),
      'started\n',
    );
    await stopChild(launches.find((result) => result.child).child);
    const again = await f.launch();
    assert.equal(again.kind, 'started');
    assert.equal(again.port, launches[0].port);
    assert.equal(
      await readFile(resolve(f.directory, 'tmp/server-starts.txt'), 'utf8'),
      'started\nstarted\n',
    );
  },
);

test(
  '其他程序占用端口时自动换端口，二维码用实际端口，再次双击沿用它',
  { timeout: 15_000 },
  async (t) => {
    const foreign = createServer((_req, res) =>
      res.end(JSON.stringify({ ok: true, message: '其他应用' })),
    );
    const port = await listen(foreign);
    t.after(() => close(foreign));
    const f = await fixture(t, port);
    await writeFile(
      resolve(f.directory, '.env'),
      `PORT=${port}\nHOST=127.0.0.1\nPUBLIC_BASE_URL=http://127.0.0.1:${port}\n`,
    );
    const first = await f.launch();
    assert.equal(first.kind, 'started');
    assert.ok(first.port > port && first.port <= port + 20);
    const settings = await (await fetch(first.url + '/api/config')).json();
    assert.equal(settings.publicBaseUrl, first.url);
    assert.ok(settings.localUrls[0].endsWith(`:${first.port}`));
    assert.equal((await f.launch()).port, first.port);
    assert.equal(
      await readFile(resolve(f.directory, 'tmp/server-starts.txt'), 'utf8'),
      'started\n',
    );
    assert.equal((await (await fetch(`http://127.0.0.1:${port}`)).json()).message, '其他应用');
  },
);

test(
  '不同项目的同款游戏不会被认作本项目，固定外部网址占用给出可操作提示',
  { timeout: 10_000 },
  async (t) => {
    const foreign = createServer((_req, res) =>
      res.end(JSON.stringify({ ok: true, service: 'family-doudizhu', projectId: 'another-copy' })),
    );
    const port = await listen(foreign);
    t.after(() => close(foreign));
    const f = await fixture(t, port);
    await writeFile(
      resolve(f.directory, '.env'),
      `PORT=${port}\nHOST=127.0.0.1\nPUBLIC_BASE_URL=https://game.example.com\n`,
    );
    assert.equal(await probeGame(await readConfig(f.directory, {}), port, true), null);
    await assert.rejects(f.launch(), /固定的对外网址.*PUBLIC_BASE_URL/);
    assert.equal(f.urls.length, 0);
    assert.equal(
      publicUrlForPort('https://game.example.com', port, port),
      'https://game.example.com',
    );
  },
);

test(
  '旧版服务须同时匹配本地游戏页面和配置，重复打开不会重建或终止旧服务',
  { timeout: 10_000 },
  async (t) => {
    let page = html + '其他应用';
    const legacy = createServer((req, res) => {
      res.end(
        req.url === '/api/health'
          ? '{"ok":true}'
          : req.url === '/api/config'
            ? '{"publicBaseUrl":null,"localUrls":[]}'
            : page,
      );
    });
    const port = await listen(legacy);
    t.after(() => close(legacy));
    const f = await fixture(t, port);
    const config = await readConfig(f.directory, {});
    assert.equal(await probeGame(config, port, true), null);
    page = html;
    const result = await f.launch();
    assert.equal(result.kind, 'reused');
    assert.equal(result.legacy, true);
    assert.ok(f.messages.some((line) => line.includes('原来的牌局会继续保留')));
    assert.equal((await fetch(result.url + '/api/health')).status, 200);
  },
);

test(
  '启动就绪后仍核对服务身份，失败不打开浏览器且清理自己启动的子进程',
  { timeout: 10_000 },
  async (t) => {
    const port = await freePort();
    const f = await fixture(t, port, { ok: true, service: 'wrong-service' });
    await assert.rejects(f.launch(), /游戏尚未准备好/);
    assert.equal(f.urls.length, 0);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
    assert.equal((await freePort()) > 0, true);
  },
);

test(
  '已有真实牌局的手牌和座位在重复启动后保持，浏览器打开失败仍保留可用网址',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t, 32100);
    const server = makeServer({ projectDirectory: f.directory });
    t.after(() => server.close());
    const port = await listen(server.http);
    await writeFile(resolve(f.directory, '.env'), `PORT=${port}\nHOST=127.0.0.1\n`);
    const peers = [0, 1].map(() => ({
      socket: io(`http://127.0.0.1:${port}`, { reconnection: false }),
      state: null,
    }));
    for (const peer of peers)
      peer.socket.on('room-state', (state) => {
        peer.state = state;
      });
    t.after(() => peers.forEach((peer) => peer.socket.disconnect()));
    await Promise.all(
      peers.map(
        (peer) =>
          new Promise((done, fail) => {
            peer.socket.once('connect', done);
            peer.socket.once('connect_error', fail);
          }),
      ),
    );
    const request = (peer, event, data) =>
      new Promise((done, fail) =>
        peer.socket
          .timeout(3000)
          .emit(event, { revision: peer.state?.event.id, ...data }, (error, ack) =>
            error ? fail(error) : ack.ok ? done(ack.data) : fail(new Error(ack.error)),
          ),
      );
    const waitState = (peer, predicate) => {
      if (peer.state && predicate(peer.state)) return Promise.resolve();
      return new Promise((done, fail) => {
        const listener = (state) => {
          if (!predicate(state)) return;
          clearTimeout(timer);
          peer.socket.off('room-state', listener);
          done();
        };
        const timer = setTimeout(() => {
          peer.socket.off('room-state', listener);
          fail(new Error('等待牌局同步超时'));
        }, 3000);
        peer.socket.on('room-state', listener);
      });
    };
    const created = await request(peers[0], 'create-room', {
      name: '房主',
      mode: 'two',
      profile: 'two-simple',
    });
    await waitState(peers[0], (state) => state.players.length === 1);
    await request(peers[1], 'join-room', { roomId: created.roomId, name: '家人' });
    await Promise.all(peers.map((peer) => waitState(peer, (state) => state.players.length === 2)));
    const revision = peers[0].state.event.id;
    await request(peers[0], 'ready', { ready: true });
    await Promise.all(peers.map((peer) => waitState(peer, (state) => state.event.id > revision)));
    await request(peers[1], 'ready', { ready: true });
    await Promise.all(peers.map((peer) => waitState(peer, (state) => state.hand.length > 0)));
    const snapshot = JSON.parse(JSON.stringify(peers.map((peer) => peer.state)));
    assert.ok(snapshot.every((state) => state.hand.length > 0));
    // A changed source must not trigger a build over a live game's files.
    await writeFile(resolve(f.directory, 'apps/web/src/example.ts'), 'changed');
    const result = await f.launch({
      browser: async () => {
        throw new Error('没有默认浏览器');
      },
    });
    assert.equal(result.kind, 'reused');
    assert.deepEqual(
      peers.map((peer) => peer.state),
      snapshot,
    );
    assert.ok(
      f.messages.some(
        (line) => line.includes('浏览器没有自动打开') && line.includes(`:${port}/?host=1`),
      ),
    );
    assert.equal((await (await fetch(result.url + '/api/health')).json()).projectId, f.id);
  },
);
