import test from 'node:test';
import assert from 'node:assert/strict';
import { io, type Socket } from 'socket.io-client';
import { makeServer } from '../apps/server/src/server.js';
import { phoneEntryUrls } from '../apps/web/src/phone-links.js';
import type { Ack, RoomSummary, RoomView, Session } from '../packages/game/src/index.js';

interface Peer {
  socket: Socket;
  state: RoomView | null;
}
async function fixture() {
  const server = makeServer();
  await new Promise<void>((done) => server.http.listen(0, '127.0.0.1', done));
  const address = server.http.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const peers: Peer[] = [];
  const peer = async () => {
    const p: Peer = { socket: io(base, { reconnection: false }), state: null };
    peers.push(p);
    p.socket.on('room-state', (state) => {
      p.state = state;
    });
    await new Promise<void>((done, fail) => {
      p.socket.once('connect', done);
      p.socket.once('connect_error', fail);
    });
    return p;
  };
  const list = async () => {
    const response = await fetch(base + '/api/rooms');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return ((await response.json()) as { rooms: RoomSummary[] }).rooms;
  };
  return {
    server,
    base,
    peer,
    list,
    close: async () => {
      peers.forEach((p) => p.socket.disconnect());
      await server.close();
    },
  };
}
function request<T = undefined>(peer: Peer, event: string, payload: object = {}): Promise<T> {
  return new Promise((done, fail) =>
    peer.socket
      .timeout(3000)
      .emit(
        event,
        { revision: peer.state?.event.id, ...payload },
        (error: Error | null, ack: Ack<T>) => {
          if (error) fail(error);
          else if (!ack.ok) fail(new Error(ack.error));
          else done(ack.data as T);
        },
      ),
  );
}
function waitState(peer: Peer, predicate: (state: RoomView) => boolean): Promise<void> {
  if (peer.state && predicate(peer.state)) return Promise.resolve();
  return new Promise((done, fail) => {
    const listener = (state: RoomView) => {
      if (predicate(state)) {
        clearTimeout(timer);
        peer.socket.off('room-state', listener);
        done();
      }
    };
    const timer = setTimeout(() => {
      peer.socket.off('room-state', listener);
      fail(new Error('等待牌桌同步超时'));
    }, 3000);
    peer.socket.on('room-state', listener);
  });
}

test('主页二维码排除电脑专用地址，保留实际端口，不携带主机页或房间参数', () => {
  assert.deepEqual(
    phoneEntryUrls({
      publicBaseUrl: 'http://localhost:3000/?host=1',
      localUrls: [
        'http://127.0.0.2:3000',
        'http://[::1]:3000',
        'http://0.0.0.0:3000',
        'http://192.168.1.8:3001/?room=123456&host=1#game',
        'http://192.168.1.8:3001',
        'http://10.1.0.2:3001',
        'not-a-url',
        'file:///home/game',
      ],
    }),
    ['http://192.168.1.8:3001', 'http://10.1.0.2:3001'],
  );
  assert.deepEqual(phoneEntryUrls({ publicBaseUrl: null, localUrls: [] }), []);
  assert.deepEqual(
    phoneEntryUrls({
      publicBaseUrl: 'https://family.example/game/?host=1',
      localUrls: ['http://192.168.1.8:3001'],
    }),
    ['https://family.example/game'],
  );
});

test('房间目录仅公开可入座房间摘要，列表入座与房间码进入同一桌，不泄露身份或手牌', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.list(), []);
    const host = await f.peer();
    const created = await request<Session>(host, 'create-room', {
      name: '奶奶',
      mode: 'three',
      profile: 'three-classic',
    });
    const [summary] = await f.list();
    assert.deepEqual(summary, {
      roomId: created.roomId,
      hostName: '奶奶',
      mode: 'three',
      profile: 'three-classic',
      playerCount: 1,
      maxPlayers: 3,
    });
    assert.deepEqual(Object.keys(summary).sort(), [
      'hostName',
      'maxPlayers',
      'mode',
      'playerCount',
      'profile',
      'roomId',
    ]);
    assert.ok(!JSON.stringify(summary).includes(created.token));
    assert.ok(!JSON.stringify(summary).includes(created.playerId));
    const listedGuest = await f.peer();
    const joined = await request<Session>(listedGuest, 'join-room', {
      name: '爷爷',
      roomId: summary.roomId,
    });
    assert.equal(joined.roomId, created.roomId);
    assert.equal((await f.list())[0].playerCount, 2);
    const qrGuest = await f.peer();
    const roomLink = new URL(`/?room=${created.roomId}`, f.base);
    const scanned = await request<Session>(qrGuest, 'join-room', {
      name: '家人',
      roomId: roomLink.searchParams.get('room'),
    });
    assert.equal(scanned.roomId, joined.roomId);
    assert.deepEqual(await f.list(), []);
  } finally {
    await f.close();
  }
});

test('目录排除离线空桌，重连后恢复；离开空位和房主转移及时反映，已满或开局不再提供加入', async () => {
  const f = await fixture();
  try {
    const host = await f.peer();
    const session = await request<Session>(host, 'create-room', {
      name: '房主',
      mode: 'two',
      profile: 'two-simple',
    });
    host.socket.disconnect();
    const reconnected = await f.peer();
    assert.deepEqual(await f.list(), []);
    await request(reconnected, 'resume-room', session);
    await waitState(reconnected, (state) => state.players.length === 1);
    assert.equal((await f.list())[0].roomId, session.roomId);
    const guest = await f.peer();
    await request(guest, 'join-room', { name: '家人', roomId: session.roomId });
    await Promise.all(
      [reconnected, guest].map((p) => waitState(p, (state) => state.players.length === 2)),
    );
    assert.deepEqual(await f.list(), []);
    await request(reconnected, 'leave-room');
    await waitState(guest, (state) => state.players.length === 1 && state.hostId === state.youId);
    assert.equal((await f.list())[0].hostName, '家人');
    const next = await f.peer();
    await request(next, 'join-room', { name: '另一位家人', roomId: session.roomId });
    await Promise.all(
      [guest, next].map((p) => waitState(p, (state) => state.players.length === 2)),
    );
    const revision = guest.state!.event.id;
    await request(guest, 'ready', { ready: true });
    await Promise.all([guest, next].map((p) => waitState(p, (state) => state.event.id > revision)));
    await request(next, 'ready', { ready: true });
    await Promise.all([guest, next].map((p) => waitState(p, (state) => state.phase !== 'waiting')));
    assert.deepEqual(await f.list(), []);
  } finally {
    await f.close();
  }
});
