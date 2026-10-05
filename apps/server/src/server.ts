import express from 'express';
import { createServer } from 'node:http';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { isIP } from 'node:net';
import QRCode from 'qrcode';
import { Server, type Socket } from 'socket.io';
import packageInfo from '../../../package.json' with { type: 'json' };
import { TurnClock } from './turn-clock.js';
import { DirectPeer } from './direct-peer.js';
import { CommandLedger } from './command-ledger.js';
import {
  ENTRY_EVENTS,
  GAME_EVENTS,
  TRANSPORT_PROTOCOL,
  type CommandEnvelope,
  type DirectOffer,
} from '../../../packages/game/src/transport.js';
import {
  addPlayer,
  announce,
  bid,
  bombLimit,
  cancelRound,
  createGame,
  DEFAULT_PROFILE,
  MODES,
  pass,
  playCards,
  PROFILES,
  resetRound,
  rob,
  setReady,
} from '../../../packages/game/src/index.js';
import type {
  Ack,
  GameMode,
  GameState,
  RoomSummary,
  RoomView,
  RuleProfile,
  Session,
} from '../../../packages/game/src/index.js';

interface SeatSession {
  token: string;
  link: PlayerLink | null;
}
interface PlayerLink {
  id: string;
  socket: Socket | null;
  direct: DirectPeer | null;
  ledger: CommandLedger;
  ip: string;
  touchedAt: number;
  lastNegotiation: number;
  revoked: boolean;
}
interface Room {
  id: string;
  hostId: string;
  game: GameState;
  sessions: Map<string, SeatSession>;
  touchedAt: number;
  clock: TurnClock;
}
interface Binding {
  room: Room;
  playerId: string;
}
export interface ServerOptions {
  publicBaseUrl?: string;
  staticPath?: string;
  projectDirectory?: string;
  temporaryPublic?: boolean;
  turnDurationMs?: number;
  rtc?: boolean;
}

export interface PublicEntry {
  status: 'connecting' | 'ready' | 'unavailable';
  url?: string;
}

export function makeServer(options: ServerOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  const http = createServer(app);
  const io = new Server(http, { maxHttpBufferSize: 16_384, serveClient: false });
  const rooms = new Map<string, Room>();
  const bindings = new WeakMap<PlayerLink, Binding>();
  const links = new Map<string, PlayerLink>();
  const directPeers = new Set<DirectPeer>();
  const handlers = new Map<string, (link: PlayerLink, data: any) => unknown>();
  const requestCounts = new Map<string, { count: number; resetAt: number }>();
  const instanceId = randomUUID();
  let stateVersion = 0;
  let closing = false;
  const turnDuration = options.turnDurationMs ?? 30_000;
  if (!Number.isFinite(turnDuration) || turnDuration <= 0) throw new Error('出牌时间必须大于0');
  const entries = new Map<string, { fingerprint: string; session: Session; expiresAt: number }>();
  let publicEntry: PublicEntry = { status: 'connecting' };
  const entryMode = options.temporaryPublic ? 'temporary' : options.publicBaseUrl ? 'fixed' : 'lan';

  const projectPath = realpathSync(options.projectDirectory ?? process.cwd());
  const projectId = createHash('sha256')
    .update(process.platform === 'win32' ? projectPath.toLowerCase() : projectPath)
    .digest('hex')
    .slice(0, 24);
  app.get('/api/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      service: 'family-doudizhu',
      projectId,
      version: packageInfo.version,
      instanceId,
      entryMode,
      ...(options.temporaryPublic
        ? { publicStatus: publicEntry.status, publicBaseUrl: publicEntry.url ?? null }
        : {}),
    });
  });
  function localEntryUrls() {
    const address = http.address();
    const port = address && typeof address !== 'string' ? address.port : 3000;
    return [
      ...new Set(
        Object.values(networkInterfaces()).flatMap((items) =>
          (items ?? [])
            .filter(
              (item) =>
                item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.'),
            )
            .map((item) => `http://${item.address}:${port}`),
        ),
      ),
    ];
  }
  function isDirectLocalRequest(req: express.Request) {
    // A tunnel request always carries the visitor header. Never publish LAN
    // addresses through it, even when the visitor happens to use the home Wi-Fi.
    if (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']) return false;
    const address = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    return (
      address === '::1' ||
      /^127\./.test(address) ||
      /^10\./.test(address) ||
      /^192\.168\./.test(address) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(address)
    );
  }
  app.get('/api/config', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (options.temporaryPublic) {
      res.json({
        entryMode,
        publicStatus: publicEntry.status,
        publicBaseUrl: publicEntry.status === 'ready' ? publicEntry.url : null,
        localUrls: isDirectLocalRequest(req) ? localEntryUrls() : [],
      });
      return;
    }
    res.json({
      entryMode,
      publicBaseUrl: options.publicBaseUrl?.replace(/\/$/, '') || null,
      localUrls: localEntryUrls(),
    });
  });
  app.get('/api/invite.png', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const lanInvite = req.query.network === 'lan';
    const lanUrls = isDirectLocalRequest(req) ? localEntryUrls() : [];
    const base = lanInvite
      ? typeof req.query.address === 'string'
        ? lanUrls.find((url) => url === req.query.address)
        : (lanUrls.find((url) => new URL(url).host === req.headers.host) ?? lanUrls[0])
      : publicEntry.status === 'ready'
        ? publicEntry.url
        : undefined;
    if (!options.temporaryPublic || !base) {
      res.status(503).send('公网入口尚未连通，请等待二维码重新显示');
      return;
    }
    const roomId = req.query.room;
    if (
      roomId !== undefined &&
      (typeof roomId !== 'string' || !/^\d{6}$/.test(roomId) || !rooms.has(roomId))
    ) {
      res.status(404).send('这桌已结束，请使用本次新二维码');
      return;
    }
    const target = `${base}${roomId ? `/?room=${roomId}` : ''}`;
    const png = await QRCode.toBuffer(target, {
      type: 'png',
      width: 440,
      margin: 4,
      errorCorrectionLevel: 'M',
      color: { dark: '#163e31', light: '#ffffff' },
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', 'attachment; filename="family-doudizhu-invite.png"');
    res.send(png);
  });
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.get('/api/rooms', (_req, res) => {
    const available: RoomSummary[] = [...rooms.values()]
      .filter(
        ({ game }) =>
          game.phase === 'waiting' &&
          game.players.length < MODES[game.mode].players &&
          game.players.some((player) => player.online),
      )
      .sort((a, b) => b.touchedAt - a.touchedAt)
      .map(({ id, hostId, game }) => ({
        roomId: id,
        hostName: game.players.find((player) => player.id === hostId)?.name ?? '家人',
        mode: game.mode,
        profile: game.profile,
        playerCount: game.players.length,
        maxPlayers: MODES[game.mode].players,
      }));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ rooms: available });
  });
  const staticPath = options.staticPath ?? resolve('dist/client');
  for (const version of ['classic-v1', 'classic-v2'])
    app.use(
      `/audio/${version}`,
      express.static(resolve(staticPath, `audio/${version}`), {
        maxAge: '30d',
        immutable: true,
      }),
    );
  app.use(express.static(staticPath));
  app.get('/', (_req, res) =>
    res.sendFile(resolve(options.staticPath ?? 'dist/client', 'index.html')),
  );

  function view(room: Room, playerId: string): RoomView {
    const g = room.game;
    const showBottom = g.landlordId !== null && (g.mode !== 'four' || g.landlordId === playerId);
    return {
      roomId: room.id,
      instanceId,
      stateVersion: ++stateVersion,
      hostId: room.hostId,
      youId: playerId,
      mode: g.mode,
      profile: g.profile,
      phase: g.phase,
      players: g.players.map((p) => ({ ...p, cardCount: g.hands[p.id]?.length ?? 0 })),
      hand: g.hands[playerId] ?? [],
      bottom: showBottom ? g.bottom : [],
      turnId: g.turnId,
      serverTime: Date.now(),
      turnDeadline: room.clock.deadline,
      landlordId: g.landlordId,
      highestBid: g.highestBid,
      round: g.round,
      lastPlay: g.lastPlay,
      multiplier: g.multiplier,
      settlement: g.settlement,
      spring: g.spring,
      winner: g.winner,
      event: g.event,
      allowance: g.allowance,
      robCount: g.robCount,
      bombLimits: Object.fromEntries(
        g.players.map((p) => [p.id, { used: g.bombsPlayed[p.id] ?? 0, limit: bombLimit(g, p.id) }]),
      ),
    };
  }
  function broadcast(room: Room) {
    room.clock.sync(room.game);
    room.touchedAt = Date.now();
    for (const [playerId, session] of room.sessions) {
      if (session.link) sendState(session.link, room, playerId);
    }
  }
  function removeSeat(room: Room, playerId: string, changingTables = false) {
    const name = room.game.players.find((p) => p.id === playerId)!.name;
    const activeRound = !['waiting', 'finished'].includes(room.game.phase);
    const previous = room.sessions.get(playerId)?.link;
    if (previous) {
      bindings.delete(previous);
      dropDirect(previous, true);
      if (changingTables) {
        revoke(previous);
      }
    }
    if (activeRound || room.game.phase === 'finished') cancelRound(room.game);
    room.game.players = room.game.players.filter((p) => p.id !== playerId);
    room.game.players.forEach((p) => {
      p.ready = false;
    });
    room.sessions.delete(playerId);
    delete room.game.hands[playerId];
    if (!room.game.players.length) {
      room.clock.stop();
      rooms.delete(room.id);
    } else {
      if (room.hostId === playerId) room.hostId = room.game.players[0].id;
      announce(
        room.game,
        activeRound
          ? `${name}换桌了，本局结束不计分，请重新准备`
          : `${name}${changingTables ? '换桌' : '离开'}了，等待家人入座`,
        activeRound ? ['next-round'] : [],
      );
      broadcast(room);
    }
  }
  function expireTurn(room: Room) {
    if (
      !rooms.has(room.id) ||
      room.game.phase !== 'playing' ||
      !room.game.turnId ||
      room.game.players.some((p) => !p.online)
    )
      return;
    const playerId = room.game.turnId;
    if (room.game.lastPlay) {
      pass(room.game, playerId);
      room.game.event.text += '（超时自动不出）';
    } else {
      const smallest = room.game.hands[playerId].reduce((a, b) => (a.rank <= b.rank ? a : b));
      playCards(room.game, playerId, [smallest.id]);
      room.game.event.text += '（超时自动出牌）';
    }
    broadcast(room);
  }
  function getBinding(link: PlayerLink): Binding {
    const binding = bindings.get(link);
    if (!binding || !rooms.has(binding.room.id)) throw new Error('请先加入房间');
    return binding;
  }
  function nameFrom(data: unknown): string {
    if (
      typeof data !== 'string' ||
      data.trim().length < 1 ||
      [...data.trim()].length > 10 ||
      /[\x00-\x1f\x7f]/.test(data)
    )
      throw new Error('请填写称呼，最多10个字');
    return data.trim();
  }
  function attach(link: PlayerLink, room: Room, playerId: string): Session {
    const session = room.sessions.get(playerId)!;
    if (session.link && session.link !== link) {
      bindings.delete(session.link);
      revoke(session.link);
    }
    session.link = link;
    bindings.set(link, { room, playerId });
    room.game.players.find((p) => p.id === playerId)!.online = true;
    return { roomId: room.id, playerId, token: session.token };
  }
  function checkRevision(game: GameState, data: unknown) {
    if (
      !data ||
      typeof data !== 'object' ||
      (data as { revision?: unknown }).revision !== game.event.id
    )
      throw new Error('牌局已更新，请按当前画面操作');
  }
  function sendState(link: PlayerLink, room: Room, playerId: string) {
    if (link.revoked || closing) return;
    const state = view(room, playerId);
    // Mirror the identical snapshot over the warm route. A stalled direct route
    // cannot freeze the table; the browser accepts only the first/newest version.
    link.direct?.ready && link.direct.send({ type: 'state', state });
    link.socket?.emit('room-state', state);
  }
  function presence(link: PlayerLink) {
    const binding = bindings.get(link);
    if (!binding || !rooms.has(binding.room.id) || closing) return;
    const { room, playerId } = binding;
    if (room.sessions.get(playerId)?.link !== link) return;
    const player = room.game.players.find((p) => p.id === playerId);
    const online = !link.revoked && (!!link.socket?.connected || !!link.direct?.ready);
    if (!player || player.online === online) return;
    player.online = online;
    if (!online && room.game.phase === 'waiting') player.ready = false;
    announce(room.game, online ? `${player.name}回来了` : `${player.name}暂时离线，回来后继续`);
    broadcast(room);
  }
  function dropDirect(link: PlayerLink, notify = false) {
    const direct = link.direct;
    link.direct = null;
    if (direct) void direct.close().finally(() => directPeers.delete(direct));
    if (notify) link.socket?.emit('rtc-reset');
    presence(link);
  }
  function revoke(link: PlayerLink) {
    if (link.revoked) return;
    link.revoked = true;
    link.direct?.send({ type: 'session-replaced' });
    link.socket?.emit('session-replaced');
    bindings.delete(link);
    dropDirect(link);
    link.socket?.disconnect(true);
    link.socket = null;
    links.delete(link.id);
  }
  function rateLimit(link: PlayerLink) {
    link.touchedAt = Date.now();
    let counter = requestCounts.get(link.ip);
    if (!counter || counter.resetAt < link.touchedAt) {
      counter = { count: 0, resetAt: link.touchedAt + 60_000 };
      requestCounts.set(link.ip, counter);
    }
    if (++counter.count > 600) throw new Error('操作太快了，请稍等');
  }
  function execute(
    link: PlayerLink,
    event: string,
    data: unknown,
    envelope?: CommandEnvelope,
  ): Ack<unknown> {
    try {
      if (closing || link.revoked) throw new Error('连接已结束，请重新入座');
      if (envelope && !ENTRY_EVENTS.has(event)) {
        const { room, playerId } = getBinding(link);
        if (envelope.seat?.roomId !== room.id || envelope.seat?.playerId !== playerId)
          throw new Error('原座位已失效，请按当前画面操作');
      }
      const handler = handlers.get(event);
      if (!handler) throw new Error('操作不正确');
      const result = handler(link, data);
      const binding = bindings.get(link);
      if (binding) broadcast(binding.room);
      return { ok: true, data: result };
    } catch (error) {
      const binding = bindings.get(link);
      if (binding) sendState(link, binding.room, binding.playerId);
      return {
        ok: false,
        error: error instanceof Error ? error.message : '操作没有成功，请再试一次',
      };
    }
  }
  function command(link: PlayerLink, raw: unknown) {
    try {
      rateLimit(link);
      return link.ledger.execute(raw, (c) => execute(link, c.event, c.data, c));
    } catch (error) {
      const c = raw as Partial<CommandEnvelope> | null;
      return {
        type: 'ack' as const,
        id: typeof c?.id === 'string' ? c.id : '',
        seq: c?.seq ?? 0,
        reply: { ok: false, error: error instanceof Error ? error.message : '操作没有成功' },
      };
    }
  }
  io.on('connection', (socket) => {
    if (closing) {
      socket.disconnect(true);
      return;
    }
    const credential = socket.handshake.auth?.linkToken;
    const id =
      typeof credential === 'string' && /^[a-zA-Z0-9_-]{40,80}$/.test(credential)
        ? credential
        : randomBytes(32).toString('base64url');
    let link = links.get(id);
    if (!link) {
      if (links.size >= 2000) {
        socket.disconnect(true);
        return;
      }
      const forwarded = socket.handshake.headers['cf-connecting-ip'];
      const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(socket.handshake.address);
      const ip =
        options.temporaryPublic && loopback && typeof forwarded === 'string' && isIP(forwarded)
          ? forwarded
          : socket.handshake.address;
      link = {
        id,
        socket: null,
        direct: null,
        ledger: new CommandLedger(instanceId),
        ip,
        touchedAt: Date.now(),
        lastNegotiation: 0,
        revoked: false,
      };
      links.set(id, link);
    }
    const current = link;
    const previousSocket = current.socket;
    current.socket = socket;
    current.touchedAt = Date.now();
    previousSocket?.disconnect(true);
    presence(current);
    socket.emit('link-ready', {
      protocol: TRANSPORT_PROTOCOL,
      instanceId,
      rtc: options.rtc !== false,
    });
    const bound = bindings.get(current);
    if (bound) sendState(current, bound.room, bound.playerId);
    for (const event of GAME_EVENTS)
      socket.on(event, (data: unknown, ack: unknown) => {
        if (typeof ack !== 'function' || current.socket !== socket) return;
        try {
          rateLimit(current);
          ack(execute(current, event, data));
        } catch (error) {
          ack({ ok: false, error: (error as Error).message });
        }
      });
    socket.on('game-command', (data: unknown, ack: unknown) => {
      if (typeof ack === 'function' && current.socket === socket) ack(command(current, data));
    });
    socket.on('rtc-offer', async (data: DirectOffer, ack: unknown) => {
      if (typeof ack !== 'function' || current.socket !== socket) return;
      let peer: DirectPeer | undefined;
      try {
        rateLimit(current);
        if (options.rtc === false || current.revoked) throw new Error('当前连接使用公网');
        const { room, playerId } = getBinding(current);
        if (
          data?.session?.roomId !== room.id ||
          data.session.playerId !== playerId ||
          data.session.token !== room.sessions.get(playerId)?.token
        )
          throw new Error('直连身份已失效');
        if (
          typeof data?.id !== 'string' ||
          !/^[a-zA-Z0-9-]{16,80}$/.test(data.id) ||
          data.description?.type !== 'offer' ||
          typeof data.description.sdp !== 'string' ||
          data.description.sdp.length > 12_000 ||
          /\nm=(?:audio|video)\s/.test(data.description.sdp) ||
          (data.description.sdp.match(/a=candidate:/g)?.length ?? 0) > 32
        )
          throw new Error('直连请求不正确');
        if (Date.now() - current.lastNegotiation < 10_000) throw new Error('请稍后重试直连');
        current.lastNegotiation = Date.now();
        dropDirect(current);
        peer = new DirectPeer(data.id, instanceId, {
          ready: () => {
            if (current.direct !== peer || current.revoked) return;
            presence(current);
            const binding = bindings.get(current);
            if (binding) sendState(current, binding.room, binding.playerId);
          },
          message: (packet) => {
            if (current.direct !== peer || current.revoked) return;
            const receipt = command(current, packet);
            peer!.send(receipt);
            current.socket?.emit('command-ack', receipt);
          },
          closed: () => {
            if (current.direct !== peer) return;
            current.direct = null;
            current.socket?.emit('rtc-unavailable', { id: peer!.id });
            presence(current);
          },
          disposed: () => {
            directPeers.delete(peer!);
          },
        });
        current.direct = peer;
        directPeers.add(peer);
        const answer = await peer.answer(data);
        if (current.direct !== peer || current.socket !== socket || current.revoked)
          throw new Error('直连请求已失效');
        ack({ ok: true, data: answer });
      } catch (error) {
        if (peer) {
          if (current.direct === peer) dropDirect(current);
          else void peer.close().finally(() => directPeers.delete(peer!));
        }
        ack({ ok: false, error: error instanceof Error ? error.message : '直连暂不可用' });
      }
    });
    socket.on('rtc-close', (data) => {
      if (current.socket === socket && current.direct?.id === data?.id) dropDirect(current);
    });
    socket.on('disconnect', () => {
      if (current.socket !== socket) return;
      current.socket = null;
      current.touchedAt = Date.now();
      presence(current);
    });
  });
  const expiry = setInterval(() => {
    const now = Date.now();
    for (const [key, room] of rooms) {
      if (room.game.players.every((p) => !p.online) && now - room.touchedAt > 12 * 60 * 60 * 1000) {
        room.clock.stop();
        for (const session of room.sessions.values()) if (session.link) revoke(session.link);
        rooms.delete(key);
      }
    }
    for (const [key, counter] of requestCounts)
      if (counter.resetAt < now) requestCounts.delete(key);
    for (const [key, entry] of entries) if (entry.expiresAt < now) entries.delete(key);
    for (const [key, link] of links) {
      link.ledger.prune(now);
      if (!bindings.has(link) && !link.socket && !link.direct && now - link.touchedAt > 60_000)
        links.delete(key);
    }
  }, 60_000);
  expiry.unref();

  function on(event: string, handler: (link: PlayerLink, data: any) => unknown) {
    handlers.set(event, handler);
  }
  on('create-room', (link, data) => {
    if (bindings.has(link)) throw new Error('您已在房间里，请先离开');
    const name = nameFrom(data?.name);
    const mode = data?.mode as GameMode;
    if (!Object.hasOwn(MODES, mode)) throw new Error('请选择游戏人数');
    const profile = (data?.profile ?? DEFAULT_PROFILE[mode]) as RuleProfile;
    if (!Object.hasOwn(PROFILES, profile) || PROFILES[profile].mode !== mode)
      throw new Error('请选择对应的玩法');
    if (rooms.size >= 200) throw new Error('房间暂时已满，请稍后创建');
    let id: string;
    do {
      id = String(randomInt(100000, 1000000));
    } while (rooms.has(id));
    const playerId = randomUUID();
    const room: Room = {
      id,
      hostId: playerId,
      game: createGame(mode, profile),
      sessions: new Map(),
      touchedAt: Date.now(),
      clock: new TurnClock(turnDuration, () => expireTurn(room)),
    };
    addPlayer(room.game, playerId, name);
    room.sessions.set(playerId, { token: randomBytes(32).toString('base64url'), link: null });
    rooms.set(id, room);
    return attach(link, room, playerId);
  });
  on('join-room', (link, data) => {
    if (bindings.has(link)) throw new Error('您已在房间里，请先离开');
    if (typeof data?.roomId !== 'string' || !/^\d{6}$/.test(data.roomId))
      throw new Error('请输入6位房间号');
    const room = rooms.get(data.roomId);
    if (!room) throw new Error('没有找到这桌，请让房主重新展示二维码');
    const name = nameFrom(data.name);
    if (room.game.players.some((p) => p.name === name))
      throw new Error('这个称呼已有人使用，请加个字区分');
    const playerId = randomUUID();
    addPlayer(room.game, playerId, name);
    room.sessions.set(playerId, { token: randomBytes(32).toString('base64url'), link: null });
    return attach(link, room, playerId);
  });
  on('enter-room', (link, data) => {
    if (typeof data?.roomId !== 'string' || !/^\d{6}$/.test(data.roomId))
      throw new Error('请输入6位房间号');
    if (typeof data?.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(data.requestId))
      throw new Error('入座请求不正确，请重新扫码');
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          roomId: data.roomId,
          name: data.name,
          previous: data.previousSession,
        }),
      )
      .digest('hex');
    const cached = entries.get(data.requestId);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.fingerprint !== fingerprint) throw new Error('入座请求已经变更，请重新扫码');
      const destination = rooms.get(cached.session.roomId);
      if (destination?.sessions.get(cached.session.playerId)?.token === cached.session.token) {
        const bound = bindings.get(link);
        if (bound && (bound.room !== destination || bound.playerId !== cached.session.playerId))
          throw new Error('您已在另一桌，请重新扫码');
        return attach(link, destination, cached.session.playerId);
      }
      throw new Error('这次入座已失效，请重新扫码');
    }
    const previous = data.previousSession as Session | undefined;
    const oldRoom = previous && rooms.get(previous.roomId);
    const oldSeat = oldRoom?.sessions.get(previous!.playerId);
    if (oldSeat && (typeof previous?.token !== 'string' || oldSeat.token !== previous.token))
      throw new Error('原座位身份不正确，请回原页面重新入座');
    const bound = bindings.get(link);
    if (bound && (!oldSeat || bound.room !== oldRoom || bound.playerId !== previous?.playerId))
      throw new Error('您已在另一桌，请重新扫码');
    const destination = rooms.get(data.roomId);
    if (!destination) throw new Error('没有找到这桌，请让房主重新展示二维码');
    let result: Session;
    if (oldSeat && oldRoom === destination) {
      result = attach(link, destination, previous!.playerId);
      announce(
        destination.game,
        `${destination.game.players.find((p) => p.id === result.playerId)!.name}回来了`,
      );
    } else {
      const name = nameFrom(
        data.name ?? oldRoom?.game.players.find((p) => p.id === previous?.playerId)?.name,
      );
      if (!['waiting', 'finished'].includes(destination.game.phase))
        throw new Error('已经开局，请等这一局结束');
      if (destination.game.players.length >= MODES[destination.game.mode].players)
        throw new Error('这桌已坐满，请另开一桌');
      if (destination.game.players.some((p) => p.name === name))
        throw new Error('这个称呼已有人使用，请加个字区分');
      // Validate the destination before changing the old round or identity.
      const playerId = randomUUID();
      if (oldSeat && oldRoom) {
        // A same-link switch must keep the transport open.
        if (oldSeat.link === link) {
          bindings.delete(link);
          oldSeat.link = null;
          dropDirect(link, true);
        }
        removeSeat(oldRoom, previous!.playerId, true);
      }
      addPlayer(destination.game, playerId, name);
      destination.sessions.set(playerId, {
        token: randomBytes(32).toString('base64url'),
        link: null,
      });
      result = attach(link, destination, playerId);
    }
    entries.set(data.requestId, {
      fingerprint,
      session: result,
      expiresAt: Date.now() + 120_000,
    });
    return result;
  });
  on('resume-room', (link, data) => {
    const room = rooms.get(data?.roomId);
    const session = room?.sessions.get(data?.playerId);
    if (!room || !session || typeof data?.token !== 'string' || session.token !== data.token)
      throw new Error('原来的房间已失效，请重新入座');
    const bound = bindings.get(link);
    if (bound) {
      if (bound.room !== room || bound.playerId !== data.playerId)
        throw new Error('已经在另一桌入座');
      return { roomId: room.id, playerId: data.playerId, token: session.token };
    }
    const result = attach(link, room, data.playerId);
    announce(room.game, `${room.game.players.find((p) => p.id === data.playerId)!.name}回来了`);
    return result;
  });
  on('ready', (link, data) => {
    const { room, playerId } = getBinding(link);
    checkRevision(room.game, data);
    if (typeof data?.ready !== 'boolean') throw new Error('准备状态不正确');
    setReady(room.game, playerId, data.ready, randomInt);
  });
  on('bid', (link, data) => {
    const { room, playerId } = getBinding(link);
    checkRevision(room.game, data);
    bid(room.game, playerId, data?.value, randomInt);
  });
  on('rob', (link, data) => {
    const { room, playerId } = getBinding(link);
    checkRevision(room.game, data);
    if (typeof data?.yes !== 'boolean') throw new Error('请选择叫地主或不叫');
    rob(room.game, playerId, data.yes, randomInt);
  });
  on('play', (link, data) => {
    const { room, playerId } = getBinding(link);
    checkRevision(room.game, data);
    playCards(room.game, playerId, data?.ids);
  });
  on('pass', (link, data) => {
    const { room, playerId } = getBinding(link);
    checkRevision(room.game, data);
    pass(room.game, playerId);
  });
  on('next-round', (link, data) => {
    const { room, playerId } = getBinding(link);
    checkRevision(room.game, data);
    if (room.hostId !== playerId) throw new Error('请让房主开始下一局');
    resetRound(room.game);
  });
  on('leave-room', (link, data) => {
    const { room, playerId } = getBinding(link);
    checkRevision(room.game, data);
    if (!['waiting', 'finished'].includes(room.game.phase))
      throw new Error('这一局还没结束，请打完再离开');
    bindings.delete(link);
    removeSeat(room, playerId);
  });
  return {
    app,
    http,
    io,
    transportStats: () => ({ links: links.size, directPeers: directPeers.size }),
    setPublicEntry: (entry: PublicEntry) => {
      if (!options.temporaryPublic) throw new Error('当前主机没有启用临时公网入口');
      if (!['connecting', 'ready', 'unavailable'].includes(entry.status))
        throw new Error('公网入口状态不正确');
      if (entry.status === 'ready') {
        if (
          typeof entry.url !== 'string' ||
          !/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(entry.url)
        )
          throw new Error('临时公网地址不正确');
        publicEntry = { status: 'ready', url: entry.url };
      } else publicEntry = { status: entry.status };
    },
    close: async () => {
      closing = true;
      clearInterval(expiry);
      for (const room of rooms.values()) room.clock.stop();
      await Promise.all([...directPeers].map((peer) => peer.close()));
      directPeers.clear();
      links.clear();
      await new Promise<void>((done) => io.close(() => done()));
    },
  };
}
