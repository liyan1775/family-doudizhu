import test from 'node:test';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { makeServer } from '../apps/server/src/server.js';
import { isPublicEntry, phoneEntryUrls } from '../apps/web/src/phone-links.js';
import { createGameConnection, GAME_CONNECTION_OPTIONS } from '../apps/web/src/connection.js';

test('公网二维码只在入口就绪时生成，中断不退回局域网或手机旧地址', () => {
  const config = {
    entryMode: 'temporary' as const,
    publicBaseUrl: 'https://family-table.trycloudflare.com/?host=1#old',
    localUrls: ['http://192.168.1.8:3000'],
  };
  assert.deepEqual(phoneEntryUrls({ ...config, publicStatus: 'connecting' }), []);
  assert.deepEqual(phoneEntryUrls({ ...config, publicStatus: 'unavailable' }), []);
  assert.deepEqual(phoneEntryUrls({ ...config, publicStatus: 'ready' }), [
    'https://family-table.trycloudflare.com',
  ]);
  assert.deepEqual(
    phoneEntryUrls({ ...config, publicStatus: 'ready', publicBaseUrl: 'http://192.168.1.8:3000' }),
    [],
  );
  assert.equal(isPublicEntry({ ...config, publicStatus: 'unavailable' }), true);
  assert.equal(
    isPublicEntry({ entryMode: 'fixed', publicBaseUrl: 'http://192.168.1.8:5173', localUrls: [] }),
    false,
  );
});

test('临时公网配置不公开内网地址，状态更新仅由进程接口接收，旧地址不能缓存', async (t) => {
  const server = makeServer({ temporaryPublic: true, publicBaseUrl: 'http://192.168.1.8:3000' });
  await new Promise<void>((done) => server.http.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const address = server.http.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const read = async () => {
    const response = await fetch(base + '/api/config');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.json();
  };
  assert.deepEqual(await read(), {
    entryMode: 'temporary',
    publicStatus: 'connecting',
    publicBaseUrl: null,
    localUrls: [],
  });
  assert.throws(
    () => server.setPublicEntry({ status: 'ready', url: 'https://bad.example/?target=local' }),
    /地址不正确/,
  );
  assert.equal((await fetch(base + '/api/invite.png')).status, 503);
  server.setPublicEntry({ status: 'ready', url: 'https://family-table.trycloudflare.com' });
  const png = await fetch(base + '/api/invite.png');
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.match(png.headers.get('content-disposition') ?? '', /attachment/);
  assert.deepEqual(
    new Uint8Array(await png.arrayBuffer()).slice(0, 8),
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  assert.equal((await fetch(base + '/api/invite.png?room=000000')).status, 404);
  assert.deepEqual(await read(), {
    entryMode: 'temporary',
    publicStatus: 'ready',
    publicBaseUrl: 'https://family-table.trycloudflare.com',
    localUrls: [],
  });
  assert.equal(
    (
      await fetch(base + '/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"publicBaseUrl":"https://attacker.example"}',
      })
    ).status,
    404,
  );
  server.setPublicEntry({ status: 'unavailable' });
  assert.equal((await fetch(base + '/api/invite.png')).status, 503);
  assert.equal((await read()).publicBaseUrl, null);
  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.publicStatus, 'unavailable');
  assert.ok(health.instanceId);
});

test(
  '网页优先使用WebSocket，遇到只允许长轮询的服务仍能连接并收到动作回执',
  { timeout: 10_000 },
  async (t) => {
    const server = makeServer();
    server.io.engine.opts.transports = ['polling'];
    await new Promise<void>((done) => server.http.listen(0, '127.0.0.1', done));
    const address = server.http.address();
    assert.ok(address && typeof address !== 'string');
    const socket = io(`http://127.0.0.1:${address.port}`, {
      ...GAME_CONNECTION_OPTIONS,
      reconnection: false,
    });
    t.after(async () => {
      socket.disconnect();
      await server.close();
    });
    await new Promise<void>((done, fail) => {
      socket.once('connect', done);
      socket.once('connect_error', fail);
    });
    assert.equal(socket.io.engine.transport.name, 'polling');
    const ack = await new Promise<{ ok: boolean }>((done, fail) =>
      socket
        .timeout(3000)
        .emit(
          'create-room',
          { name: '家人', mode: 'two' },
          (error: Error | null, ack: { ok: boolean }) => (error ? fail(error) : done(ack)),
        ),
    );
    assert.equal(ack.ok, true);
  },
);

test(
  'WebSocket握手无响应时超时重试从HTTP开始，不能永远困在同一种连接',
  { timeout: 10_000 },
  async (t) => {
    const server = makeServer();
    server.io.engine.opts.allowRequest = (request, accept) => {
      const transport = new URL(request.url ?? '/', 'http://localhost').searchParams.get(
        'transport',
      );
      if (transport === 'websocket') return;
      accept(null, true);
    };
    const connections = new Set<import('node:net').Socket>();
    server.http.on('connection', (connection) => {
      connections.add(connection);
      connection.on('close', () => connections.delete(connection));
    });
    await new Promise<void>((done) => server.http.listen(0, '127.0.0.1', done));
    const address = server.http.address();
    assert.ok(address && typeof address !== 'string');
    const socket = createGameConnection(`http://127.0.0.1:${address.port}`, {
      timeout: 200,
      reconnectionDelay: 10,
      reconnectionDelayMax: 10,
      randomizationFactor: 0,
      upgrade: false,
    });
    t.after(async () => {
      socket.disconnect();
      connections.forEach((connection) => connection.destroy());
      await server.close();
    });
    let timeouts = 0;
    socket.on('connect_error', (error) => {
      if (error.message === 'timeout') timeouts++;
    });
    await new Promise<void>((done) => socket.once('connect', done));
    assert.equal(timeouts, 1);
    assert.equal(socket.io.engine.transport.name, 'polling');
    const ack = await new Promise<{ ok: boolean }>((done, fail) =>
      socket
        .timeout(3000)
        .emit(
          'create-room',
          { name: '家人', mode: 'two' },
          (error: Error | null, result: { ok: boolean }) => (error ? fail(error) : done(result)),
        ),
    );
    assert.equal(ack.ok, true);
  },
);

test(
  '公网隧道保留每位访问者的操作限额，不能因一个人的重试阻挡所有家人',
  { timeout: 15_000 },
  async (t) => {
    const server = makeServer({ temporaryPublic: true });
    await new Promise<void>((done) => server.http.listen(0, '127.0.0.1', done));
    const address = server.http.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const sockets = ['198.51.100.1', '198.51.100.2'].map((ip) =>
      io(base, {
        transports: ['websocket'],
        reconnection: false,
        extraHeaders: { 'CF-Connecting-IP': ip },
      }),
    );
    t.after(async () => {
      sockets.forEach((socket) => socket.disconnect());
      await server.close();
    });
    await Promise.all(
      sockets.map(
        (socket) =>
          new Promise<void>((done, fail) => {
            socket.once('connect', done);
            socket.once('connect_error', fail);
          }),
      ),
    );
    const request = (
      index: number,
      event: string,
      payload: object,
    ): Promise<{ ok: boolean; error?: string }> =>
      new Promise((done, fail) => {
        sockets[index]
          .timeout(2000)
          .emit(event, payload, (error: Error | null, ack: { ok: boolean; error?: string }) =>
            error ? fail(error) : done(ack),
          );
      });
    let last;
    for (let i = 0; i < 601; i++)
      last = await request(0, 'join-room', { roomId: '000000', name: '重试者' });
    assert.equal(last?.error, '操作太快了，请稍等');
    assert.equal((await request(1, 'create-room', { name: '家人', mode: 'two' })).ok, true);
  },
);
