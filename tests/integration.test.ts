import test from 'node:test';
import assert from 'node:assert/strict';
import { io, type Socket } from 'socket.io-client';
import { makeServer } from '../apps/server/src/server.js';
import { MODES, PROFILES, suggestPlay } from '../packages/game/src/index.js';
import type { Ack, RoomView, RuleProfile, Session } from '../packages/game/src/index.js';
import { eventClips, eventVoice, seatVoice } from '../apps/web/src/audio-catalog.js';

interface Peer {
  socket: Socket;
  state: RoomView | null;
}
async function fixture() {
  const server = makeServer();
  await new Promise<void>((resolve) => server.http.listen(0, '127.0.0.1', resolve));
  const address = server.http.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const peers: Peer[] = [];
  async function peer() {
    const socket = io(url, { reconnection: false, forceNew: true });
    const p: Peer = { socket, state: null };
    peers.push(p);
    socket.on('room-state', (state) => {
      p.state = state;
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return p;
  }
  return {
    server,
    url,
    peer,
    close: async () => {
      peers.forEach((p) => p.socket.disconnect());
      await server.close();
    },
  };
}
async function request<T>(peer: Peer, event: string, data: object = {}): Promise<Ack<T>> {
  return new Promise((resolve, reject) =>
    peer.socket
      .timeout(3000)
      .emit(
        event,
        { revision: peer.state?.event.id, ...data },
        (error: Error | null, ack: Ack<T>) => (error ? reject(error) : resolve(ack)),
      ),
  );
}
async function waitState(peer: Peer, predicate: (view: RoomView) => boolean): Promise<RoomView> {
  if (peer.state && predicate(peer.state)) return peer.state;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      peer.socket.off('room-state', listener);
      reject(new Error('等待牌局状态超时'));
    }, 3000);
    const listener = (state: RoomView) => {
      if (predicate(state)) {
        clearTimeout(timer);
        peer.socket.off('room-state', listener);
        resolve(state);
      }
    };
    peer.socket.on('room-state', listener);
  });
}
async function readyPeers(peers: Peer[]) {
  for (const p of peers) {
    const revision = p.state!.event.id;
    assert.ok((await request(p, 'ready', { ready: true })).ok);
    await Promise.all(peers.map((other) => waitState(other, (state) => state.event.id > revision)));
  }
}

test('真实联机：五种玩法均可入座、准备、打完、结算和下一局', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    for (const profile of Object.keys(PROFILES) as RuleProfile[]) {
      const mode = PROFILES[profile].mode;
      const peers = await Promise.all(Array.from({ length: MODES[mode].players }, () => f.peer()));
      const created = await request<Session>(peers[0], 'create-room', {
        name: '房主',
        mode,
        profile,
      });
      assert.ok(created.ok && created.data);
      await waitState(peers[0], (state) => state.players.length === 1);
      for (let i = 1; i < peers.length; i++) {
        assert.ok(
          (await request(peers[i], 'join-room', { roomId: created.data.roomId, name: `家人${i}` }))
            .ok,
        );
        await Promise.all(
          peers.slice(0, i + 1).map((p) => waitState(p, (state) => state.players.length === i + 1)),
        );
      }
      await readyPeers(peers);
      assert.ok(peers.every((p) => p.state!.bottom.length === 0));
      const first = peers.find((p) => p.state!.youId === p.state!.turnId)!;
      if (first.state!.phase === 'calling') {
        assert.ok((await request(first, 'rob', { yes: true })).ok);
        await Promise.all(peers.map((p) => waitState(p, (state) => state.phase === 'robbing')));
        const other = peers.find((p) => p.state!.youId === p.state!.turnId)!;
        assert.ok((await request(other, 'rob', { yes: false })).ok);
      } else assert.ok((await request(first, 'bid', { value: 3 })).ok);
      await Promise.all(peers.map((p) => waitState(p, (state) => state.phase === 'playing')));
      const landlord = peers.find((p) => p.state!.landlordId === p.state!.youId)!;
      for (const p of peers) {
        const view = p.state!;
        assert.deepEqual(view.event.audio, [
          profile === 'two-rob' ? 'no-rob' : 'bid-3',
          'landlord',
        ]);
        assert.equal(view.event.announcements?.[1].actorId, view.landlordId);
        assert.equal(
          eventClips(view.event, view.players, view.youId)[1].key,
          p === landlord ? 'own-landlord' : 'own-farmer',
        );
      }
      if (mode === 'four')
        assert.ok(peers.filter((p) => p !== landlord).every((p) => p.state!.bottom.length === 0));
      for (const p of peers) {
        const serialized = JSON.stringify(p.state!);
        for (const other of peers.filter((other) => other !== p)) {
          for (const card of other.state!.hand.filter(
            (c) => !p.state!.bottom.some((bottom) => bottom.id === c.id),
          ))
            assert.ok(!serialized.includes(`"${card.id}"`));
        }
      }
      let actions = 0;
      while (peers[0].state!.phase === 'playing' && actions++ < 600) {
        const current = peers.find((p) => p.state!.youId === p.state!.turnId)!;
        const view = current.state!;
        const limit = view.bombLimits[view.youId];
        const ids = suggestPlay(
          view.hand,
          view.lastPlay?.combo ?? null,
          view.mode,
          view.profile,
          limit.limit === null || limit.used < limit.limit,
        );
        const ack = await request(current, ids.length ? 'play' : 'pass', ids.length ? { ids } : {});
        assert.ok(ack.ok, ack.error ?? '联机动作失败');
        await Promise.all(
          peers.map((p) => waitState(p, (state) => state.event.id > view.event.id)),
        );
        const actorSeat = view.players.find((p) => p.id === view.youId)!.seat;
        if (peers[0].state!.phase === 'playing') {
          for (const p of peers) {
            assert.equal(p.state!.event.actorId, view.youId);
            assert.equal(eventVoice(p.state!.event, p.state!.players), seatVoice(actorSeat).id);
          }
        }
      }
      assert.equal(peers[0].state!.phase, 'finished');
      assert.equal(
        peers[0].state!.settlement.reduce((sum, s) => sum + s.delta, 0),
        0,
      );
      assert.ok((await request(peers[0], 'next-round')).ok);
      await Promise.all(peers.map((p) => waitState(p, (state) => state.phase === 'waiting')));
      for (const p of peers) p.socket.disconnect();
    }
  } finally {
    await f.close();
  }
});

test('联机身份：满员拒绝加入，离线保留手牌，正确令牌可恢复，错误令牌不可恢复', async () => {
  const f = await fixture();
  try {
    const [a, b, intruder] = await Promise.all([f.peer(), f.peer(), f.peer()]);
    const ack = await request<Session>(a, 'create-room', {
      name: '爷爷',
      mode: 'two',
      profile: 'two-simple',
    });
    const session = ack.data!;
    assert.ok((await request(b, 'join-room', { name: '奶奶', roomId: session.roomId })).ok);
    await Promise.all([a, b].map((p) => waitState(p, (state) => state.players.length === 2)));
    await readyPeers([a, b]);
    const hand = a.state!.hand.map((c) => c.id);
    const voiceBefore = seatVoice(a.state!.players.find((p) => p.id === session.playerId)!.seat).id;
    a.socket.disconnect();
    await waitState(b, (state) => state.players.some((p) => !p.online));
    assert.equal(
      (await request(intruder, 'join-room', { name: '路人', roomId: session.roomId })).ok,
      false,
    );
    assert.equal(
      (await request(intruder, 'resume-room', { ...session, token: 'wrong' })).ok,
      false,
    );
    const resumed = await f.peer();
    assert.ok((await request(resumed, 'resume-room', session)).ok);
    const state = await waitState(resumed, (state) => state.youId === session.playerId);
    assert.deepEqual(
      state.hand.map((c) => c.id),
      hand,
    );
    assert.equal(
      seatVoice(state.players.find((p) => p.id === session.playerId)!.seat).id,
      voiceBefore,
    );
    await waitState(b, (state) => state.players.every((p) => p.online));
    assert.equal((await request(b, 'bid', { value: 3 })).ok, false);
  } finally {
    await f.close();
  }
});

test('网络重试与房间隔离：旧版本动作拒绝，重复出牌不会扣第二次，离开后房主移交', async () => {
  const f = await fixture();
  try {
    const [a, b, c] = await Promise.all([f.peer(), f.peer(), f.peer()]);
    const session = (
      await request<Session>(a, 'create-room', { name: '爷爷', mode: 'two', profile: 'two-simple' })
    ).data!;
    assert.ok((await request(b, 'join-room', { name: '奶奶', roomId: session.roomId })).ok);
    await Promise.all([a, b].map((p) => waitState(p, (state) => state.players.length === 2)));
    await request(c, 'create-room', { name: '另一桌', mode: 'two', profile: 'two-simple' });
    await waitState(c, (state) => state.players.length === 1);
    assert.notEqual(c.state!.roomId, session.roomId);
    await readyPeers([a, b]);
    const revision = a.state!.event.id;
    assert.equal((await request(a, 'bid', { value: 3, revision: revision - 1 })).ok, false);
    assert.ok((await request(a, 'bid', { value: 3 })).ok);
    await Promise.all([a, b].map((p) => waitState(p, (state) => state.phase === 'playing')));
    const state = a.state!;
    const ids = [state.hand[0].id];
    assert.ok((await request(a, 'play', { ids })).ok);
    await Promise.all([a, b].map((p) => waitState(p, (s) => s.event.id > state.event.id)));
    assert.equal((await request(a, 'play', { ids, revision: state.event.id })).ok, false);
    assert.equal(a.state!.hand.length, state.hand.length - 1);
    assert.equal(c.state!.players.length, 1);
    const otherSession = (
      await request<Session>(await f.peer(), 'create-room', { name: '离开测试', mode: 'two' })
    ).data!;
    const guest = await f.peer();
    assert.ok(
      (await request(guest, 'join-room', { name: '接任', roomId: otherSession.roomId })).ok,
    );
    const owner = await f.peer();
    assert.ok((await request(owner, 'resume-room', otherSession)).ok);
    await waitState(owner, (s) => s.players.length === 2);
    assert.ok((await request(owner, 'leave-room')).ok);
    const transferred = await waitState(guest, (s) => s.players.length === 1);
    assert.equal(transferred.hostId, transferred.youId);
  } finally {
    await f.close();
  }
});
