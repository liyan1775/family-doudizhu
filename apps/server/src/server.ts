import express from 'express';
import { createServer } from 'node:http';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { Server, type Socket } from 'socket.io';
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
}

export function makeServer(options: ServerOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  const http = createServer(app);
  const io = new Server(http, { maxHttpBufferSize: 16_384, serveClient: false });
  const rooms = new Map<string, Room>();
  const bindings = new WeakMap<Socket, Binding>();
  const requestCounts = new Map<string, { count: number; resetAt: number }>();

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/config', (_req, res) => {
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
    res.json({ publicBaseUrl: options.publicBaseUrl?.replace(/\/$/, '') || null, localUrls });
  });
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.use(express.static(options.staticPath ?? resolve('dist/client')));
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
          const ip = socket.handshake.address;
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
    close: async () => {
      clearInterval(expiry);
      await new Promise<void>((done) => io.close(() => done()));
    },
  };
}
