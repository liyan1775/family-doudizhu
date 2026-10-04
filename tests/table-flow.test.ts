import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { makeServer, type ServerOptions } from '../apps/server/src/server.js';
import { TurnClock } from '../apps/server/src/turn-clock.js';
import { addPlayer, cancelRound, createGame } from '../packages/game/src/index.js';
import type { Ack, RoomView, Session } from '../packages/game/src/index.js';
import { entryIntent, tableSeat } from '../apps/web/src/entry-session.js';
import { phoneEntryUrls } from '../apps/web/src/phone-links.js';
import { handLayout } from '../apps/web/src/hand-layout.js';

interface Peer {
  socket: Socket;
  state: RoomView | null;
}
async function fixture(options: ServerOptions = {}) {
  const server = makeServer(options);
  await new Promise<void>((done) => server.http.listen(0, '0.0.0.0', done));
  const address = server.http.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const peers: Peer[] = [];
  async function peer(tunnel = false) {
    const p: Peer = {
      socket: io(base, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
        ...(tunnel ? { extraHeaders: { 'CF-Connecting-IP': '198.51.100.7' } } : {}),
      }),
      state: null,
    };
    peers.push(p);
    p.socket.on('room-state', (state) => {
      p.state = state;
    });
    await new Promise<void>((done, fail) => {
      p.socket.once('connect', done);
      p.socket.once('connect_error', fail);
    });
    return p;
  }
  return {
    server,
    base,
    peer,
    close: async () => {
      peers.forEach((p) => p.socket.disconnect());
      await server.close();
    },
  };
}
function request<T = Session>(p: Peer, event: string, data: object = {}): Promise<Ack<T>> {
  return new Promise((done, fail) =>
    p.socket
      .timeout(3000)
      .emit(event, { revision: p.state?.event.id, ...data }, (error: Error | null, ack: Ack<T>) =>
        error ? fail(error) : done(ack),
      ),
  );
}
function waitState(p: Peer, predicate: (state: RoomView) => boolean): Promise<RoomView> {
  if (p.state && predicate(p.state)) return Promise.resolve(p.state);
  return new Promise((done, fail) => {
    const timer = setTimeout(() => {
      p.socket.off('room-state', listener);
      fail(new Error('牌桌同步超时'));
    }, 3000);
    const listener = (state: RoomView) => {
      if (predicate(state)) {
        clearTimeout(timer);
        p.socket.off('room-state', listener);
        done(state);
      }
    };
    p.socket.on('room-state', listener);
  });
}
async function twoPlayers(f: Awaited<ReturnType<typeof fixture>>) {
  const a = await f.peer();
  const b = await f.peer();
  const session = (
    await request(a, 'create-room', { name: '爷爷', mode: 'two', profile: 'two-simple' })
  ).data!;
  assert.ok((await request(b, 'join-room', { name: '奶奶', roomId: session.roomId })).ok);
  await Promise.all([a, b].map((p) => waitState(p, (s) => s.players.length === 2)));
  await request(a, 'ready', { ready: true });
  await waitState(b, (s) => s.players[0].ready);
  await request(b, 'ready', { ready: true });
  await Promise.all([a, b].map((p) => waitState(p, (s) => s.phase === 'bidding')));
  await request(a, 'bid', { value: 3 });
  await Promise.all([a, b].map((p) => waitState(p, (s) => s.phase === 'playing')));
  return { a, b, session };
}

test('新邀请码优先于旧座位，同房间与普通刷新仍恢复原身份，首次扫码需称呼', () => {
  const session = { roomId: '111111', playerId: 'player', token: 'secret' };
  assert.equal(entryIntent('222222', session, '爷爷')?.event, 'enter-room');
  assert.deepEqual(entryIntent('222222', session, '爷爷')?.payload, {
    roomId: '222222',
    name: '爷爷',
    previousSession: session,
  });
  assert.equal(entryIntent('111111', session, '爷爷')?.event, 'resume-room');
  assert.equal(entryIntent('', session, '爷爷')?.event, 'resume-room');
  assert.equal(entryIntent('bad', null, '爷爷'), null);
  assert.equal(entryIntent('222222', null, ''), null);
  assert.equal(entryIntent('222222', null, '爷爷')?.event, 'enter-room');
});

test('横屏座位以本人为底边，二／三／四人完整分配；四人33张可在两行辨认', () => {
  for (const count of [2, 3, 4])
    for (let own = 0; own < count; own++) {
      const positions = Array.from({ length: count }, (_, seat) => tableSeat(seat, own, count));
      assert.equal(new Set(positions).size, count);
      assert.equal(positions[own], 'seat-self');
    }
  assert.deepEqual(
    [0, 1, 2, 3].map((seat) => tableSeat(seat, 3, 4)),
    ['seat-right', 'seat-top', 'seat-left', 'seat-self'],
  );
  for (const width of [520, 610, 780]) {
    const layout = handLayout(33, width, 92, true);
    assert.equal(
      layout.columns.reduce((a, b) => a + b, 0),
      33,
    );
    assert.ok(layout.columns.length <= 2);
    assert.ok(layout.cardHeight * layout.columns.length + 4 * (layout.columns.length - 1) <= 92);
    assert.ok(layout.fontSize >= 18);
  }
});

test('同一Wi-Fi码优先直连，公网中断时局域网继续，异地码保持HTTPS', () => {
  const config = {
    entryMode: 'temporary' as const,
    publicStatus: 'ready' as const,
    publicBaseUrl: 'https://family-table.trycloudflare.com',
    localUrls: ['http://192.168.1.5:3001'],
  };
  assert.deepEqual(phoneEntryUrls(config, 'lan'), [...config.localUrls, config.publicBaseUrl]);
  assert.deepEqual(phoneEntryUrls(config), [config.publicBaseUrl]);
  assert.deepEqual(
    phoneEntryUrls({ ...config, publicStatus: 'unavailable' }, 'lan'),
    config.localUrls,
  );
  assert.deepEqual(phoneEntryUrls({ ...config, publicStatus: 'unavailable' }), []);
});

test('服务端30秒时钟不因普通消息重置，掉线暂停剩余时间，新轮次取消旧计时', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const game = createGame('two');
  addPlayer(game, 'a', '爷爷');
  addPlayer(game, 'b', '奶奶');
  game.phase = 'playing';
  game.turnId = 'a';
  game.round = 1;
  let expired = 0;
  const clock = new TurnClock(30_000, () => expired++);
  clock.sync(game);
  assert.equal(clock.deadline, 31_000);
  t.mock.timers.tick(10_000);
  game.event.id++;
  clock.sync(game);
  assert.equal(clock.deadline, 31_000);
  game.players[1].online = false;
  clock.sync(game);
  assert.equal(clock.deadline, null);
  t.mock.timers.tick(50_000);
  assert.equal(expired, 0);
  game.players[1].online = true;
  clock.sync(game);
  assert.equal(clock.deadline, 81_000);
  t.mock.timers.tick(19_999);
  assert.equal(expired, 0);
  t.mock.timers.tick(1);
  assert.equal(expired, 1);
  game.turnId = 'b';
  clock.sync(game);
  t.mock.timers.tick(10_000);
  game.turnId = 'a';
  clock.sync(game);
  t.mock.timers.tick(20_000);
  assert.equal(expired, 1);
  t.mock.timers.tick(10_000);
  assert.equal(expired, 2);
  game.phase = 'waiting';
  clock.sync(game);
  t.mock.timers.tick(60_000);
  assert.equal(expired, 2);
  clock.stop();
});

test('换桌取消本局清理牌局状态，保留累计积分和轮数，不产生结算', () => {
  const game = createGame('two');
  addPlayer(game, 'a', '爷爷');
  addPlayer(game, 'b', '奶奶');
  game.players[0].score = 18;
  game.players[1].score = -18;
  game.players.forEach((p) => {
    p.ready = true;
  });
  game.phase = 'playing';
  game.round = 4;
  game.startingSeat = 1;
  game.hands = { a: [{ id: 'a-card', rank: 3, suit: 'spades' }] };
  game.bids = { a: 3 };
  game.bombsPlayed = { a: 2 };
  game.landlordId = 'a';
  game.turnId = 'a';
  const revision = game.event.id;
  cancelRound(game);
  assert.equal(game.phase, 'waiting');
  assert.equal(game.turnId, null);
  assert.equal(game.landlordId, null);
  assert.deepEqual(
    game.players.map((p) => p.score),
    [18, -18],
  );
  assert.ok(game.players.every((p) => !p.ready));
  assert.deepEqual(game.hands, {});
  assert.deepEqual(game.bids, {});
  assert.deepEqual(game.bombsPlayed, {});
  assert.deepEqual(game.settlement, []);
  assert.equal(game.round, 4);
  assert.equal(game.startingSeat, 1);
  assert.equal(game.event.id, revision);
});

test(
  '真实联机超时首出最小单张，跟牌自动不出；迟到动作不能重复扣牌',
  { timeout: 8000 },
  async (t) => {
    const f = await fixture({ turnDurationMs: 200 });
    t.after(f.close);
    const { a, b } = await twoPlayers(f);
    const before = a.state!;
    const rank = Math.min(...before.hand.map((c) => c.rank));
    assert.ok(before.turnDeadline! > before.serverTime!);
    const played = await waitState(
      a,
      (s) => s.event.kind === 'play' && s.event.text.includes('超时'),
    );
    assert.equal(played.lastPlay?.cards[0].rank, rank);
    assert.equal(played.hand.length, before.hand.length - 1);
    assert.equal(played.turnId, b.state!.youId);
    assert.equal(
      (await request(a, 'play', { ids: [before.hand[0].id], revision: before.event.id })).ok,
      false,
    );
    const passed = await waitState(
      b,
      (s) => s.event.kind === 'pass' && s.event.text.includes('超时'),
    );
    assert.equal(passed.hand.length, 17);
    assert.equal(passed.lastPlay, null);
    assert.equal(passed.turnId, a.state!.youId);
    assert.deepEqual(passed.event.audio, ['pass']);
  },
);

test('扫码由旧页面换入新桌：旧局不计分、清空手牌、移交房主，新桌重试只占一个座位', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const { a, b, session } = await twoPlayers(f);
  const newHost = await f.peer();
  const target = (await request(newHost, 'create-room', { name: '另一桌房主', mode: 'three' }))
    .data!;
  const scanned = await f.peer();
  let replaced = false;
  a.socket.on('session-replaced', () => {
    replaced = true;
  });
  const payload = {
    roomId: target.roomId,
    previousSession: session,
    name: '爷爷',
    requestId: randomUUID(),
  };
  const result = await request(scanned, 'enter-room', payload);
  assert.ok(result.ok && result.data);
  const old = await waitState(b, (s) => s.phase === 'waiting' && s.players.length === 1);
  assert.equal(old.hostId, old.youId);
  assert.equal(old.hand.length, 0);
  assert.equal(old.players[0].score, 0);
  assert.deepEqual(old.settlement, []);
  assert.equal(old.turnDeadline, null);
  assert.match(old.event.text, /本局结束不计分/);
  const joined = await waitState(scanned, (s) => s.roomId === target.roomId);
  assert.equal(joined.players.length, 2);
  assert.equal(replaced, true);
  assert.deepEqual((await request(scanned, 'enter-room', payload)).data, result.data);
  assert.equal(scanned.state!.players.length, 2);
  const refreshed = await f.peer();
  assert.deepEqual((await request(refreshed, 'enter-room', payload)).data, result.data);
  await waitState(refreshed, (s) => s.youId === result.data!.playerId && s.players.length === 2);
  const oldReturn = await f.peer();
  assert.equal((await request(oldReturn, 'resume-room', session)).ok, false);
  assert.equal(
    (await request(refreshed, 'enter-room', { ...payload, roomId: session.roomId })).ok,
    false,
  );
});

test('目标桌已满／已开局／不存在／称呼冲突／令牌错误时，换桌不能破坏原牌局', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const { a, b, session } = await twoPlayers(f);
  const { a: full } = await twoPlayers(f);
  const other = await f.peer();
  const target = (await request(other, 'create-room', { name: '爷爷', mode: 'three' })).data!;
  const scanned = await f.peer();
  const before = a.state!;
  const waitingHost = await f.peer();
  const waitingGuest = await f.peer();
  const waiting = (await request(waitingHost, 'create-room', { name: '满桌房主', mode: 'two' }))
    .data!;
  await request(waitingGuest, 'join-room', { name: '已占座', roomId: waiting.roomId });
  for (const roomId of ['000000', full.state!.roomId, target.roomId, waiting.roomId]) {
    assert.equal(
      (
        await request(scanned, 'enter-room', {
          roomId,
          previousSession: session,
          name: '爷爷',
          requestId: randomUUID(),
        })
      ).ok,
      false,
    );
  }
  assert.equal(
    (
      await request(scanned, 'enter-room', {
        roomId: target.roomId,
        previousSession: { ...session, token: 'wrong' },
        name: '新称呼',
        requestId: randomUUID(),
      })
    ).ok,
    false,
  );
  assert.equal(a.socket.connected, true);
  assert.equal(a.state!.phase, 'playing');
  assert.deepEqual(a.state!.hand, before.hand);
  assert.equal(a.state!.turnDeadline, before.turnDeadline);
  assert.equal(b.state!.players.length, 2);
});

test('同一连接扫码换桌也能成功；同房间扫码恢复同一身份，不再添一个座位', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const a = await f.peer();
  const host = await f.peer();
  const previous = (await request(a, 'create-room', { name: '爷爷', mode: 'two' })).data!;
  const target = (await request(host, 'create-room', { name: '奶奶', mode: 'three' })).data!;
  const result = (
    await request(a, 'enter-room', {
      roomId: target.roomId,
      name: '爷爷',
      previousSession: previous,
      requestId: randomUUID(),
    })
  ).data!;
  assert.equal(a.socket.connected, true);
  await waitState(a, (s) => s.youId === result.playerId);
  assert.deepEqual(
    (
      await request(a, 'enter-room', {
        roomId: target.roomId,
        previousSession: result,
        name: '爷爷',
        requestId: randomUUID(),
      })
    ).data,
    result,
  );
  assert.equal(a.state!.players.length, 2);
});

test('同一Wi-Fi直连玩家和隧道玩家共用房间、版本和手牌隔离，公网中断不打断直连', async (t) => {
  const f = await fixture({ temporaryPublic: true });
  t.after(f.close);
  const direct = await f.peer();
  const remote = await f.peer(true);
  const session = (
    await request(direct, 'create-room', { name: '家里', mode: 'two', profile: 'two-simple' })
  ).data!;
  assert.ok((await request(remote, 'join-room', { name: '远方', roomId: session.roomId })).ok);
  await Promise.all([direct, remote].map((p) => waitState(p, (s) => s.players.length === 2)));
  const revision = direct.state!.event.id;
  await request(direct, 'ready', { ready: true });
  await waitState(remote, (s) => s.event.id > revision);
  await request(remote, 'ready', { ready: true });
  await Promise.all([direct, remote].map((p) => waitState(p, (s) => s.phase === 'bidding')));
  assert.equal(direct.state!.roomId, remote.state!.roomId);
  for (const card of remote.state!.hand)
    assert.ok(!JSON.stringify(direct.state).includes(`"${card.id}"`));
  f.server.setPublicEntry({ status: 'unavailable' });
  assert.ok((await request(direct, 'bid', { value: 3 })).ok);
  await waitState(remote, (s) => s.phase === 'playing');
  assert.ok(direct.socket.connected);
});
