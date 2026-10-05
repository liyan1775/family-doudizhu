import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RTCPeerConnection as NodePeer } from 'werift';
import { CommandLedger } from '../apps/server/src/command-ledger.js';
import { makeServer } from '../apps/server/src/server.js';
import { PlayerConnection } from '../apps/web/src/player-connection.js';
import type { Ack, RoomView, Session } from '../packages/game/src/types.js';
import { MODES, PROFILES, suggestPlay } from '../packages/game/src/index.js';
import type { CommandEnvelope } from '../packages/game/src/transport.js';

const instanceId = randomUUID();
function envelope(seq: number, event: CommandEnvelope['event'] = 'play'): CommandEnvelope {
  return {
    protocol: 1,
    instanceId,
    id: randomUUID(),
    seq,
    event,
    data: { revision: 7, ids: ['one'] },
  };
}
test('命令回执先于版本校验；两路重复、篡改、乱序和缓存淘汰均不能再次执行', () => {
  const ledger = new CommandLedger(instanceId, 2);
  let actions = 0;
  const run = () => {
    actions++;
    return { ok: true, data: actions };
  };
  const one = envelope(1);
  const first = ledger.execute(one, run);
  assert.deepEqual(ledger.execute(structuredClone(one), run), first);
  assert.equal(actions, 1);
  assert.equal(ledger.execute({ ...one, data: { revision: 8 } }, run).reply.ok, false);
  assert.equal(ledger.execute(envelope(1), run).reply.ok, false);
  ledger.execute(envelope(2), run);
  ledger.execute(envelope(3), run);
  assert.equal(ledger.execute(one, run).reply.ok, false);
  assert.equal(ledger.execute({ ...envelope(4), instanceId: randomUUID() }, run).reply.ok, false);
  assert.equal(ledger.execute({ ...envelope(4), data: 'x'.repeat(17_000) }, run).reply.ok, false);
  assert.equal(actions, 3);
});

async function waitUntil(predicate: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('等待连接/状态超时');
    await new Promise((done) => setTimeout(done, 20));
  }
}
interface Peer {
  client: PlayerConnection;
  pcs: NodePeer[];
  state: RoomView | null;
  states: RoomView[];
}
async function fixture(rtc = true, turnDurationMs = 30_000) {
  const server = makeServer({ turnDurationMs });
  await new Promise<void>((done) => server.http.listen(0, '0.0.0.0', done));
  const address = server.http.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const peers: Peer[] = [];
  async function peer(polling = false) {
    const pcs: NodePeer[] = [];
    const client = new PlayerConnection(url, {
      socket: {
        forceNew: true,
        reconnection: false,
        ...(polling ? { transports: ['polling'], upgrade: false } : {}),
      },
      rtcFactory: rtc
        ? () => {
            const pc = new NodePeer({ iceServers: [], iceUseIpv6: false });
            pcs.push(pc);
            return pc as unknown as RTCPeerConnection;
          }
        : () => {
            throw new Error('模拟不支持RTC');
          },
      directRetryMs: 60_000,
    });
    const p: Peer = { client, pcs, state: null, states: [] };
    peers.push(p);
    client.on('room-state', (state) => {
      p.state = state;
      p.states.push(state);
    });
    await waitUntil(() => client.connected);
    return p;
  }
  return {
    server,
    peer,
    close: async () => {
      peers.forEach((p) => p.client.disconnect());
      await Promise.all(peers.flatMap((p) => p.pcs).map((pc) => pc.close()));
      await server.close();
    },
  };
}
async function request<T>(p: Peer, event: string, data: object = {}): Promise<Ack<T>> {
  return new Promise((resolve, reject) =>
    p.client
      .timeout(6000)
      .volatile.emit(event, { revision: p.state?.event.id, ...data }, (error, reply) =>
        error ? reject(error) : resolve(reply),
      ),
  );
}
async function seatPair(f: Awaited<ReturnType<typeof fixture>>) {
  const a = await f.peer();
  const b = await f.peer();
  const created = await request<Session>(a, 'create-room', {
    name: '房主',
    mode: 'two',
    profile: 'two-simple',
  });
  assert.ok(created.ok && created.data);
  const joined = await request<Session>(b, 'join-room', {
    name: '家人',
    roomId: created.data.roomId,
  });
  assert.ok(joined.ok && joined.data);
  await waitUntil(() => a.state?.players.length === 2 && b.state?.players.length === 2);
  return { a, b, session: created.data };
}

test(
  '真实RTC连接：统一身份，公网断时继续直连，直连断时自动回公网，清理所有RTC资源',
  { timeout: 30_000 },
  async () => {
    const f = await fixture();
    try {
      const { a, b, session } = await seatPair(f);
      await waitUntil(
        () =>
          a.client.diagnostics().route === 'direct' && b.client.diagnostics().route === 'direct',
      );
      assert.equal(f.server.transportStats().directPeers, 2);
      const selected = a.pcs[0].iceTransports[0].getSelectedCandidatePair();
      assert.ok(selected);
      assert.equal(selected.local.toJSON().candidate.includes('typ host'), true);
      assert.equal(selected.remote.toJSON().candidate.includes('typ host'), true);
      const before = a.state!.event.id;
      a.client.publicSocket.disconnect();
      await new Promise((done) => setTimeout(done, 100));
      assert.equal(a.client.connected, true);
      assert.equal(a.state!.event.id, before);
      assert.equal(a.state!.players.find((p) => p.id === session.playerId)!.online, true);
      assert.ok((await request(a, 'ready', { ready: true })).ok);
      a.client.publicSocket.connect();
      await waitUntil(() => a.client.diagnostics().publicConnected);
      assert.equal(a.state!.youId, session.playerId);
      const sequence = a.client.diagnostics().sequence;
      await a.pcs[0].close();
      await waitUntil(() => a.client.diagnostics().route === 'public');
      assert.equal(a.client.connected, true);
      assert.equal(a.state!.players.find((p) => p.id === session.playerId)!.online, true);
      assert.ok((await request(a, 'ready', { ready: false })).ok);
      assert.equal(a.client.diagnostics().sequence, sequence + 1);
      assert.equal(a.state!.youId, session.playerId);
      assert.ok(
        a.states.every((state, i) => !i || state.stateVersion! > a.states[i - 1].stateVersion!),
      );
    } finally {
      await f.close();
    }
    assert.deepEqual(f.server.transportStats(), { links: 0, directPeers: 0 });
  },
);

test('不支持RTC时直接完成入座与游戏，未要求玩家选网络', async () => {
  const f = await fixture(false);
  try {
    const { a, b } = await seatPair(f);
    assert.equal(a.client.diagnostics().route, 'public');
    assert.ok((await request(a, 'ready', { ready: true })).ok);
    await waitUntil(() => !!b.state?.players.find((p) => p.id === a.state!.youId)?.ready);
    assert.ok((await request(b, 'ready', { ready: true })).ok);
    await waitUntil(() => a.state?.phase === 'bidding');
    const first = a.state!.turnId === a.state!.youId ? a : b;
    assert.ok((await request(first, 'bid', { value: 3 })).ok);
    await waitUntil(() => a.state?.phase === 'playing');
  } finally {
    await f.close();
  }
});

test('公网回执较慢时保留完整6秒预算，重试仍返回同一个入座结果', { timeout: 15_000 }, async () => {
  const f = await fixture(false);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  try {
    const p = await f.peer();
    const socket = f.server.io.sockets.sockets.get(p.client.publicSocket.id!)!;
    const original = socket.listeners('game-command')[0];
    socket.removeAllListeners('game-command');
    socket.on('game-command', (command, ack) =>
      original(command, (receipt: unknown) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          ack(receipt);
        }, 2800);
        timers.add(timer);
      }),
    );
    const result = await request<Session>(p, 'create-room', { name: '慢网家人', mode: 'three' });
    assert.ok(result.ok && result.data);
    assert.equal(p.state!.players.length, 1);
    assert.equal(p.state!.youId, result.data.playerId);
    assert.equal(p.client.diagnostics().sequence, 1);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    await f.close();
  }
});

test(
  '出牌执行后丢失RTC回执，公网重试取回原回执；迟到旧快照不回滚手牌',
  { timeout: 30_000 },
  async () => {
    const f = await fixture();
    try {
      const { a, b } = await seatPair(f);
      await waitUntil(
        () => a.client.diagnostics().directConnected && b.client.diagnostics().directConnected,
      );
      assert.ok((await request(a, 'ready', { ready: true })).ok);
      await waitUntil(() => !!b.state?.players.find((p) => p.id === a.state!.youId)?.ready);
      assert.ok((await request(b, 'ready', { ready: true })).ok);
      await waitUntil(() => a.state?.phase === 'bidding' && b.state?.phase === 'bidding');
      const first = a.state!.turnId === a.state!.youId ? a : b;
      assert.ok((await request(first, 'bid', { value: 3 })).ok);
      await waitUntil(() => a.state?.phase === 'playing' && b.state?.phase === 'playing');
      const actor = a.state!.turnId === a.state!.youId ? a : b;
      const previous = structuredClone(actor.state!);
      const channel = actor.pcs[0].sctpTransport!.channelByLabel('family-doudizhu-v1')!;
      const message = channel.onmessage!;
      let lost = 0;
      channel.onmessage = (event) => {
        if (JSON.parse(String(event.data)).type === 'ack') {
          lost++;
          return;
        }
        message(event);
      };
      // Simulate the separate mirrored receipt also being lost. Socket request ACKs still work.
      actor.client.publicSocket.off('command-ack');
      const count = previous.hand.length;
      const revision = previous.event.id;
      const reply = await request(actor, 'play', { ids: [previous.hand[0].id] });
      assert.ok(reply.ok, reply.error ?? '出牌失败');
      assert.equal(lost, 1);
      assert.equal(actor.state!.hand.length, count - 1);
      assert.equal(actor.state!.event.id, revision + 1);
      const socket = f.server.io.sockets.sockets.get(actor.client.publicSocket.id!)!;
      const latestVersion = actor.state!.stateVersion;
      socket.emit('room-state', previous);
      await new Promise((done) => setTimeout(done, 80));
      assert.equal(actor.state!.stateVersion, latestVersion);
      assert.equal(actor.state!.hand.length, count - 1);
      // Another player's hand and session secret are absent on the direct/private snapshot.
      assert.equal(JSON.stringify(actor.state).includes('token'), false);
      assert.equal(Object.hasOwn(actor.state!, 'hands'), false);
    } finally {
      await f.close();
    }
  },
);

test(
  '两路合并在线状态，单路切换不重置30秒；全部断开才暂停并保留身份和剩余时间',
  { timeout: 30_000 },
  async () => {
    const f = await fixture();
    try {
      const { a, b, session } = await seatPair(f);
      await waitUntil(
        () => a.client.diagnostics().directConnected && b.client.diagnostics().directConnected,
      );
      assert.ok((await request(a, 'ready', { ready: true })).ok);
      await waitUntil(() => !!b.state?.players.find((p) => p.id === a.state!.youId)?.ready);
      assert.ok((await request(b, 'ready', { ready: true })).ok);
      await waitUntil(() => a.state?.phase === 'bidding' && b.state?.phase === 'bidding');
      const first = a.state!.turnId === a.state!.youId ? a : b;
      assert.ok((await request(first, 'bid', { value: 3 })).ok);
      await waitUntil(() => a.state?.phase === 'playing' && b.state?.phase === 'playing');
      const deadline = a.state!.turnDeadline!;
      const cards = structuredClone(a.state!.hand);
      const seat = a.state!.players.find((p) => p.id === session.playerId)!.seat;
      a.client.publicSocket.disconnect();
      await new Promise((done) => setTimeout(done, 100));
      assert.equal(b.state!.turnDeadline, deadline);
      assert.equal(a.client.connected, true);
      await a.pcs[0].close();
      await waitUntil(
        () =>
          !a.client.connected && !b.state!.players.find((p) => p.id === session.playerId)!.online,
      );
      assert.equal(b.state!.turnDeadline, null);
      const remaining = deadline - Date.now();
      await new Promise((done) => setTimeout(done, 180));
      a.client.publicSocket.connect();
      await waitUntil(
        () =>
          a.client.connected && !!b.state!.players.find((p) => p.id === session.playerId)!.online,
      );
      assert.ok((await request(a, 'resume-room', session)).ok);
      assert.equal(a.state!.youId, session.playerId);
      assert.equal(a.state!.players.find((p) => p.id === session.playerId)!.seat, seat);
      assert.deepEqual(a.state!.hand, cards);
      assert.ok(Math.abs(a.state!.turnDeadline! - Date.now() - remaining) < 130);
    } finally {
      await f.close();
    }
  },
);

test(
  '扫码换桌撤销旧RTC凭据；旧桌取消不计分，旧房间命令不能作用于新座位',
  { timeout: 30_000 },
  async () => {
    const f = await fixture();
    try {
      const { a, b, session } = await seatPair(f);
      const c = await f.peer();
      const target = await request<Session>(c, 'create-room', { name: '另一房主', mode: 'three' });
      assert.ok(target.ok && target.data);
      await waitUntil(
        () => a.client.diagnostics().directConnected && b.client.diagnostics().directConnected,
      );
      assert.ok((await request(a, 'ready', { ready: true })).ok);
      await waitUntil(() => !!b.state?.players.find((p) => p.id === a.state!.youId)?.ready);
      assert.ok((await request(b, 'ready', { ready: true })).ok);
      await waitUntil(() => a.state?.phase === 'bidding' && b.state?.phase === 'bidding');
      const oldState = structuredClone(a.state!);
      const pc = a.pcs[0];
      const switched = await request<Session>(a, 'enter-room', {
        roomId: target.data.roomId,
        name: '房主',
        previousSession: session,
        requestId: randomUUID(),
      });
      assert.ok(switched.ok && switched.data);
      await waitUntil(
        () => a.state?.roomId === target.data!.roomId && b.state?.phase === 'waiting',
      );
      assert.equal(b.state!.players.length, 1);
      assert.equal(b.state!.players[0].score, 0);
      assert.equal(b.state!.players[0].ready, false);
      await waitUntil(() => pc.connectionState === 'closed');
      const stale: CommandEnvelope = {
        protocol: 1,
        instanceId: oldState.instanceId!,
        id: randomUUID(),
        seq: a.client.diagnostics().sequence + 1,
        event: 'ready',
        seat: { roomId: session.roomId, playerId: session.playerId },
        data: { revision: a.state!.event.id, ready: true },
      };
      const receipt = await a.client.publicSocket.timeout(3000).emitWithAck('game-command', stale);
      assert.equal(receipt.reply.ok, false);
      assert.match(receipt.reply.error, /原座位/);
      assert.equal(a.state!.players.find((p) => p.id === switched.data!.playerId)!.ready, false);
      const badOffer = await a.client.publicSocket.timeout(3000).emitWithAck('rtc-offer', {
        id: randomUUID(),
        session,
        description: { type: 'offer', sdp: '' },
      });
      assert.equal(badOffer.ok, false);
      assert.match(badOffer.error, /身份已失效/);
    } finally {
      await f.close();
    }
  },
);

test(
  'RTC与长轮询共用现代协议：五种玩法完成整局、结算和下一局，保持私人手牌与状态顺序',
  { timeout: 60_000 },
  async () => {
    const f = await fixture();
    try {
      for (const [profile, info] of Object.entries(PROFILES)) {
        const peers = await Promise.all(
          Array.from({ length: MODES[info.mode].players }, () => f.peer(true)),
        );
        const created = await request<Session>(peers[0], 'create-room', {
          name: '房主',
          mode: info.mode,
          profile,
        });
        assert.ok(created.ok && created.data);
        for (let i = 1; i < peers.length; i++) {
          assert.ok(
            (
              await request(peers[i], 'join-room', {
                roomId: created.data.roomId,
                name: '家人' + i,
              })
            ).ok,
          );
          await waitUntil(() =>
            peers.slice(0, i + 1).every((p) => p.state?.players.length === i + 1),
          );
        }
        await waitUntil(() => peers.every((p) => p.client.diagnostics().directConnected));
        for (const p of peers) {
          const revision = p.state!.event.id;
          assert.ok((await request(p, 'ready', { ready: true })).ok);
          await waitUntil(() => peers.every((other) => other.state!.event.id > revision));
        }
        while (['bidding', 'calling', 'robbing'].includes(peers[0].state!.phase)) {
          const p = peers.find((p) => p.state!.youId === p.state!.turnId)!;
          const v = p.state!;
          assert.ok(
            (
              await request(
                p,
                v.phase === 'bidding' ? 'bid' : 'rob',
                v.phase === 'bidding' ? { value: 3 } : { yes: v.phase === 'calling' },
              )
            ).ok,
          );
          await waitUntil(() => peers.every((other) => other.state!.event.id > v.event.id));
        }
        for (const p of peers) {
          for (const other of peers.filter((other) => other !== p)) {
            for (const card of other.state!.hand.filter(
              (card) => !p.state!.bottom.some((bottom) => bottom.id === card.id),
            ))
              assert.equal(JSON.stringify(p.state).includes('"' + card.id + '"'), false);
          }
        }
        let actions = 0;
        while (peers[0].state!.phase === 'playing' && actions++ < 500) {
          const p = peers.find((p) => p.state!.youId === p.state!.turnId)!;
          const v = p.state!;
          const limit = v.bombLimits[v.youId];
          const ids = suggestPlay(
            v.hand,
            v.lastPlay?.combo ?? null,
            v.mode,
            v.profile,
            limit.limit === null || limit.used < limit.limit,
          );
          const reply = await request(p, ids.length ? 'play' : 'pass', ids.length ? { ids } : {});
          assert.ok(reply.ok, reply.error ?? '动作失败');
          await waitUntil(() => peers.every((other) => other.state!.event.id > v.event.id));
        }
        assert.equal(peers[0].state!.phase, 'finished');
        assert.equal(
          peers[0].state!.settlement.reduce((sum, item) => sum + item.delta, 0),
          0,
        );
        assert.ok(
          peers.every((p) =>
            p.states.every((s, i) => !i || s.stateVersion! > p.states[i - 1].stateVersion!),
          ),
        );
        assert.ok((await request(peers[0], 'next-round')).ok);
        await waitUntil(() => peers.every((p) => p.state?.phase === 'waiting'));
        for (const p of peers) p.client.disconnect();
      }
    } finally {
      await f.close();
    }
  },
);

test(
  '主机实例更换而旧RTC仍显示健康时触发重新恢复身份，不能停留在旧牌局',
  { timeout: 30_000 },
  async () => {
    const f = await fixture();
    let replacement: ReturnType<typeof makeServer> | undefined;
    try {
      const a = await f.peer();
      const result = await request<Session>(a, 'create-room', { name: '原座位', mode: 'two' });
      assert.ok(result.ok && result.data);
      await waitUntil(() => a.client.diagnostics().directConnected);
      let reconnects = 0;
      let disconnects = 0;
      a.client.on('connect', () => reconnects++);
      a.client.on('disconnect', () => disconnects++);
      const address = f.server.http.address();
      assert.ok(address && typeof address !== 'string');
      // Close only the old public listener; its RTC peer stays live until replaced.
      await new Promise<void>((done) => f.server.io.close(() => done()));
      await waitUntil(() => !a.client.diagnostics().publicConnected);
      assert.equal(a.client.connected, true);
      replacement = makeServer();
      await new Promise<void>((done) => replacement!.http.listen(address.port, '0.0.0.0', done));
      a.client.publicSocket.connect();
      await waitUntil(() => reconnects === 1 && a.client.diagnostics().publicConnected);
      assert.equal(disconnects, 1);
      assert.equal(a.client.diagnostics().route, 'public');
      const resume = await request(a, 'resume-room', result.data);
      assert.equal(resume.ok, false);
      assert.match(resume.error ?? '', /房间已失效/);
    } finally {
      await replacement?.close();
      await f.close();
    }
  },
);
