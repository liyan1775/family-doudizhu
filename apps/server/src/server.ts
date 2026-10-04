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
import {
  addPlayer,
  announce,
  bid,
  bombLimit,
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
  socketId: string | null;
}
interface Room {
  id: string;
  hostId: string;
  game: GameState;
  sessions: Map<string, SeatSession>;
  touchedAt: number;
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
  const bindings = new WeakMap<Socket, Binding>();
  const requestCounts = new Map<string, { count: number; resetAt: number }>();
  const instanceId = randomUUID();
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
  app.get('/api/config', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (options.temporaryPublic) {
      res.json({
        entryMode,
        publicStatus: publicEntry.status,
        publicBaseUrl: publicEntry.status === 'ready' ? publicEntry.url : null,
        localUrls: [],
      });
      return;
    }
    const address = http.address();
    const port = address && typeof address !== 'string' ? address.port : 3000;
    const localUrls = [
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
    res.json({
      entryMode,
      publicBaseUrl: options.publicBaseUrl?.replace(/\/$/, '') || null,
      localUrls,
    });
  });
  app.get('/api/invite.png', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!options.temporaryPublic || publicEntry.status !== 'ready' || !publicEntry.url) {
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
    const target = `${publicEntry.url}${roomId ? `/?room=${roomId}` : ''}`;
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
      hostId: room.hostId,
      youId: playerId,
      mode: g.mode,
      profile: g.profile,
      phase: g.phase,
      players: g.players.map((p) => ({ ...p, cardCount: g.hands[p.id]?.length ?? 0 })),
      hand: g.hands[playerId] ?? [],
      bottom: showBottom ? g.bottom : [],
      turnId: g.turnId,
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
    room.touchedAt = Date.now();
    for (const [playerId, session] of room.sessions) {
      if (session.socketId) io.to(session.socketId).emit('room-state', view(room, playerId));
    }
  }
  function getBinding(socket: Socket): Binding {
    const binding = bindings.get(socket);
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
  function attach(socket: Socket, room: Room, playerId: string): Session {
    const session = room.sessions.get(playerId)!;
    if (session.socketId && session.socketId !== socket.id) {
      const previous = io.sockets.sockets.get(session.socketId);
      if (previous) {
        bindings.delete(previous);
        previous.emit('session-replaced');
        previous.disconnect(true);
      }
    }
    session.socketId = socket.id;
    bindings.set(socket, { room, playerId });
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
  const expiry = setInterval(() => {
    const now = Date.now();
    for (const [key, room] of rooms) {
      if (room.game.players.every((p) => !p.online) && now - room.touchedAt > 12 * 60 * 60 * 1000)
        rooms.delete(key);
    }
    for (const [key, counter] of requestCounts)
      if (counter.resetAt < now) requestCounts.delete(key);
  }, 60_000);
  expiry.unref();

  io.on('connection', (socket) => {
    function on(event: string, handler: (data: any) => unknown) {
      socket.on(event, (data: unknown, ack: unknown) => {
        if (typeof ack !== 'function') return;
        const respond = ack as (reply: Ack<unknown>) => void;
        try {
          // Only the loopback-only temporary host trusts Cloudflare's visitor
          // address. Do not trust arbitrary forwarded headers on a LAN host.
          const forwarded = socket.handshake.headers['cf-connecting-ip'];
          const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
            socket.handshake.address,
          );
          const ip =
            options.temporaryPublic && loopback && typeof forwarded === 'string' && isIP(forwarded)
              ? forwarded
              : socket.handshake.address;
          const now = Date.now();
          let counter = requestCounts.get(ip);
          if (!counter || counter.resetAt < now) {
            counter = { count: 0, resetAt: now + 60_000 };
            requestCounts.set(ip, counter);
          }
          if (++counter.count > 600) throw new Error('操作太快了，请稍等');
          const result = handler(data);
          respond({ ok: true, data: result });
          const binding = bindings.get(socket);
          if (binding) broadcast(binding.room);
        } catch (error) {
          respond({
            ok: false,
            error: error instanceof Error ? error.message : '操作没有成功，请再试一次',
          });
          const binding = bindings.get(socket);
          if (binding) socket.emit('room-state', view(binding.room, binding.playerId));
        }
      });
    }
    on('create-room', (data) => {
      if (bindings.has(socket)) throw new Error('您已在房间里，请先离开');
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
      };
      addPlayer(room.game, playerId, name);
      room.sessions.set(playerId, { token: randomBytes(32).toString('base64url'), socketId: null });
      rooms.set(id, room);
      return attach(socket, room, playerId);
    });
    on('join-room', (data) => {
      if (bindings.has(socket)) throw new Error('您已在房间里，请先离开');
      if (typeof data?.roomId !== 'string' || !/^\d{6}$/.test(data.roomId))
        throw new Error('请输入6位房间号');
      const room = rooms.get(data.roomId);
      if (!room) throw new Error('没有找到这桌，请让房主重新展示二维码');
      const name = nameFrom(data.name);
      if (room.game.players.some((p) => p.name === name))
        throw new Error('这个称呼已有人使用，请加个字区分');
      const playerId = randomUUID();
      addPlayer(room.game, playerId, name);
      room.sessions.set(playerId, { token: randomBytes(32).toString('base64url'), socketId: null });
      return attach(socket, room, playerId);
    });
    on('resume-room', (data) => {
      if (bindings.has(socket)) throw new Error('已经入座');
      const room = rooms.get(data?.roomId);
      const session = room?.sessions.get(data?.playerId);
      if (!room || !session || typeof data?.token !== 'string' || session.token !== data.token)
        throw new Error('原来的房间已失效，请重新入座');
      const result = attach(socket, room, data.playerId);
      announce(room.game, `${room.game.players.find((p) => p.id === data.playerId)!.name}回来了`);
      return result;
    });
    on('ready', (data) => {
      const { room, playerId } = getBinding(socket);
      checkRevision(room.game, data);
      if (typeof data?.ready !== 'boolean') throw new Error('准备状态不正确');
      setReady(room.game, playerId, data.ready, randomInt);
    });
    on('bid', (data) => {
      const { room, playerId } = getBinding(socket);
      checkRevision(room.game, data);
      bid(room.game, playerId, data?.value, randomInt);
    });
    on('rob', (data) => {
      const { room, playerId } = getBinding(socket);
      checkRevision(room.game, data);
      if (typeof data?.yes !== 'boolean') throw new Error('请选择叫地主或不叫');
      rob(room.game, playerId, data.yes, randomInt);
    });
    on('play', (data) => {
      const { room, playerId } = getBinding(socket);
      checkRevision(room.game, data);
      playCards(room.game, playerId, data?.ids);
    });
    on('pass', (data) => {
      const { room, playerId } = getBinding(socket);
      checkRevision(room.game, data);
      pass(room.game, playerId);
    });
    on('next-round', (data) => {
      const { room, playerId } = getBinding(socket);
      checkRevision(room.game, data);
      if (room.hostId !== playerId) throw new Error('请让房主开始下一局');
      resetRound(room.game);
    });
    on('leave-room', (data) => {
      const { room, playerId } = getBinding(socket);
      checkRevision(room.game, data);
      if (!['waiting', 'finished'].includes(room.game.phase))
        throw new Error('这一局还没结束，请打完再离开');
      if (room.game.phase === 'finished') resetRound(room.game);
      const name = room.game.players.find((p) => p.id === playerId)!.name;
      room.game.players = room.game.players.filter((p) => p.id !== playerId);
      room.game.players.forEach((p) => {
        p.ready = false;
      });
      room.sessions.delete(playerId);
      delete room.game.hands[playerId];
      bindings.delete(socket);
      if (!room.game.players.length) rooms.delete(room.id);
      else {
        if (room.hostId === playerId) room.hostId = room.game.players[0].id;
        announce(room.game, `${name}离开了，等待家人入座`);
        broadcast(room);
      }
    });
    socket.on('disconnect', () => {
      const binding = bindings.get(socket);
      if (!binding) return;
      const { room, playerId } = binding;
      const session = room.sessions.get(playerId);
      if (session?.socketId !== socket.id) return;
      session.socketId = null;
      const p = room.game.players.find((p) => p.id === playerId);
      if (p) {
        p.online = false;
        if (room.game.phase === 'waiting') p.ready = false;
        announce(room.game, `${p.name}暂时离线，回来后继续`);
        broadcast(room);
      }
      bindings.delete(socket);
    });
  });
  return {
    app,
    http,
    io,
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
      clearInterval(expiry);
      await new Promise<void>((done) => io.close(() => done()));
    },
  };
}
