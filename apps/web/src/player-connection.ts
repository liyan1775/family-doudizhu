import type { ManagerOptions, SocketOptions } from 'socket.io-client';
import { createGameConnection } from './connection.js';
import { entryRequestId } from './entry-session.js';
import type { Ack, RoomView, Session } from '../../../packages/game/src/types.js';
import {
  ENTRY_EVENTS,
  MESSAGE_LIMIT,
  TRANSPORT_PROTOCOL,
  type CommandEnvelope,
  type CommandReceipt,
  type DirectAnswer,
  type LinkHello,
} from '../../../packages/game/src/transport.js';

type Listener = (...args: any[]) => void;
type Reply = (error: Error | null, reply: Ack<any>) => void;
interface Pending {
  command: CommandEnvelope;
  reply: Reply;
  deadline: number;
  timeout: ReturnType<typeof setTimeout>;
  retry?: ReturnType<typeof setTimeout>;
}
export interface TransportStatus {
  route: 'direct' | 'public' | 'offline';
  publicConnected: boolean;
  directConnected: boolean;
  sequence: number;
  rttMs?: number;
  candidatePair?: {
    localType: string;
    remoteType: string;
    protocol: string;
    localAddress?: string;
    remoteAddress?: string;
  };
}
export interface PlayerConnectionOptions {
  socket?: Partial<ManagerOptions & SocketOptions>;
  rtcFactory?: (configuration: RTCConfiguration) => RTCPeerConnection;
  directRetryMs?: number;
  fallbackMs?: number;
}
function linkToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
    n.toString(16).padStart(2, '0'),
  ).join('');
}

/** A player has one identity, one command sequence and two replaceable routes. */
export class PlayerConnection {
  readonly publicSocket;
  connected = false;
  private listeners = new Map<string, Set<Listener>>();
  private pending = new Map<string, Pending>();
  private hello?: LinkHello;
  private session?: Session;
  private seat?: CommandEnvelope['seat'];
  private seq = 0;
  private stateVersion = 0;
  private stopped = false;
  private peer?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private negotiationId?: string;
  private directReady = false;
  private lastPong = 0;
  private pings = new Map<string, number>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private negotiationTimeout?: ReturnType<typeof setTimeout>;
  private directRetry?: ReturnType<typeof setTimeout>;
  private status: TransportStatus = {
    route: 'offline',
    publicConnected: false,
    directConnected: false,
    sequence: 0,
  };

  constructor(
    url?: string,
    private readonly options: PlayerConnectionOptions = {},
  ) {
    this.publicSocket = createGameConnection(url, {
      ...options.socket,
      auth: { ...options.socket?.auth, linkToken: linkToken() },
    });
    this.publicSocket.on('link-ready', (hello: LinkHello) => {
      if (hello?.protocol !== TRANSPORT_PROTOCOL || typeof hello.instanceId !== 'string') return;
      if (this.hello && this.hello.instanceId !== hello.instanceId) {
        // A new host can answer the warm route before the old RTC heartbeat
        // expires. Treat that as a real reconnect so the UI checks its saved seat.
        this.hello = undefined;
        this.stateVersion = 0;
        this.session = undefined;
        this.seat = undefined;
        for (const p of [...this.pending.values()])
          this.finish(p, new Error('主机已重新启动，请重新入座'));
        this.closeDirect(false);
      }
      this.hello = hello;
      this.updateAvailability();
      this.retryPending();
      this.scheduleDirect(0);
    });
    this.publicSocket.on('disconnect', () => {
      this.updateAvailability();
      this.retryPending();
    });
    this.publicSocket.on('connect_error', (error) => {
      // A failed warm route must not disable a healthy direct connection.
      if (!this.connected) this.emitLocal('connect_error', error);
    });
    this.publicSocket.on('room-state', (state: RoomView) => this.acceptState(state));
    this.publicSocket.on('command-ack', (receipt: CommandReceipt) => this.acceptReceipt(receipt));
    this.publicSocket.on('session-replaced', () => this.replaced());
    this.publicSocket.on('rtc-reset', () => {
      this.closeDirect(false);
      this.scheduleDirect(this.options.directRetryMs ?? 20_000);
    });
    this.publicSocket.on('rtc-unavailable', (data) => {
      if (data?.id === this.negotiationId) this.closeDirect();
    });
  }
  on(event: string, listener: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return this;
  }
  off(event: string, listener: Listener) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  private emitLocal(event: string, ...args: any[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  diagnostics(): TransportStatus {
    return { ...this.status };
  }
  private updateAvailability() {
    const publicConnected = !this.stopped && this.publicSocket.connected && !!this.hello;
    const directConnected = !this.stopped && this.directReady;
    const connected = publicConnected || directConnected;
    this.status = {
      ...this.status,
      sequence: this.seq,
      publicConnected,
      directConnected,
      route: directConnected ? 'direct' : publicConnected ? 'public' : 'offline',
    };
    this.emitLocal('transport-status', this.diagnostics());
    if (this.connected === connected) return;
    this.connected = connected;
    this.emitLocal(connected ? 'connect' : 'disconnect');
  }
  timeout(ms: number) {
    return {
      volatile: {
        emit: (event: string, data: unknown, reply: Reply) =>
          this.sendCommand(event, data, ms, reply),
      },
    };
  }
  private sendCommand(event: string, data: unknown, ms: number, reply: Reply) {
    if (!this.connected || !this.hello) {
      reply(new Error('正在重新连接'), { ok: false });
      return;
    }
    const command: CommandEnvelope = {
      protocol: TRANSPORT_PROTOCOL,
      instanceId: this.hello.instanceId,
      id: entryRequestId(),
      seq: ++this.seq,
      event: event as CommandEnvelope['event'],
      ...(!ENTRY_EVENTS.has(event) ? { seat: this.seat } : {}),
      data,
    };
    if (new TextEncoder().encode(JSON.stringify(command)).length > MESSAGE_LIMIT) {
      reply(new Error('消息过长'), { ok: false });
      return;
    }
    const p: Pending = {
      command,
      reply,
      deadline: Date.now() + ms,
      timeout: setTimeout(() => this.finish(p, new Error('操作回复超时')), ms),
    };
    this.pending.set(command.id, p);
    this.sendPending(p);
    this.updateAvailability();
  }
  private sendPending(p: Pending, publicOnly = false) {
    clearTimeout(p.retry);
    if (this.stopped || !this.pending.has(p.command.id)) return;
    let sentDirect = false;
    if (!publicOnly && this.directReady)
      sentDirect = this.sendDirect({ type: 'command', command: p.command });
    if (!sentDirect && this.publicSocket.connected) {
      this.publicSocket
        .timeout(Math.max(1, p.deadline - Date.now()))
        .emit('game-command', p.command, (error: Error | null, receipt: CommandReceipt) => {
          if (!error) this.acceptReceipt(receipt);
        });
    }
    // Retry the SAME envelope. Never turn an uncertain execution into a new command.
    p.retry = setTimeout(
      () => this.sendPending(p, true),
      sentDirect ? (this.options.fallbackMs ?? 350) : 1200,
    );
  }
  private retryPending() {
    for (const p of this.pending.values()) this.sendPending(p);
  }
  private acceptReceipt(receipt: CommandReceipt) {
    if (receipt?.type !== 'ack') return;
    const p = this.pending.get(receipt.id);
    if (!p || p.command.seq !== receipt.seq || typeof receipt.reply?.ok !== 'boolean') return;
    // ACK order is independent of snapshot order, including an ACK after a newer state.
    if (receipt.reply.ok && ENTRY_EVENTS.has(p.command.event) && receipt.reply.data) {
      this.session = receipt.reply.data as Session;
      this.seat = { roomId: this.session.roomId, playerId: this.session.playerId };
      this.scheduleDirect(0);
    } else if (receipt.reply.ok && p.command.event === 'leave-room') {
      this.session = undefined;
      this.seat = undefined;
      this.closeDirect(false);
    }
    this.finish(p, null, receipt.reply);
  }
  private finish(p: Pending, error: Error | null, reply?: Ack<unknown>) {
    if (!this.pending.delete(p.command.id)) return;
    clearTimeout(p.timeout);
    clearTimeout(p.retry);
    p.reply(error, reply ?? { ok: false, error: error?.message });
  }
  private acceptState(state: RoomView) {
    if (
      state?.instanceId !== this.hello?.instanceId ||
      !Number.isSafeInteger(state.stateVersion) ||
      state.stateVersion! <= this.stateVersion
    )
      return;
    this.stateVersion = state.stateVersion!;
    this.seat = { roomId: state.roomId, playerId: state.youId };
    this.emitLocal('room-state', state);
  }
  private scheduleDirect(delay: number) {
    if (
      this.stopped ||
      !this.hello?.rtc ||
      !this.session ||
      this.peer ||
      !this.publicSocket.connected
    )
      return;
    clearTimeout(this.directRetry);
    this.directRetry = setTimeout(() => {
      void this.startDirect();
    }, delay);
  }
  private async startDirect() {
    if (this.stopped || this.peer || !this.session || !this.publicSocket.connected) return;
    const factory =
      this.options.rtcFactory ?? ((config: RTCConfiguration) => new RTCPeerConnection(config));
    if (!this.options.rtcFactory && typeof RTCPeerConnection === 'undefined') return;
    const id = entryRequestId();
    let peer: RTCPeerConnection;
    let ticket: string | undefined;
    try {
      peer = factory({ iceServers: [] });
      this.peer = peer;
      this.negotiationId = id;
      const channel = peer.createDataChannel('family-doudizhu-v1', { ordered: true });
      this.channel = channel;
      const authenticate = () => {
        if (ticket && channel.readyState === 'open' && this.peer === peer)
          this.sendDirect({ type: 'hello', ticket });
      };
      channel.onopen = authenticate;
      channel.onclose = () => {
        if (this.peer === peer) this.closeDirect();
      };
      channel.onerror = () => {
        if (this.peer === peer) this.closeDirect();
      };
      channel.onmessage = (event) => {
        if (
          this.peer !== peer ||
          typeof event.data !== 'string' ||
          event.data.length > MESSAGE_LIMIT
        )
          return;
        let packet: any;
        try {
          packet = JSON.parse(event.data);
        } catch {
          this.closeDirect();
          return;
        }
        if (packet?.type === 'welcome' && packet.instanceId === this.hello?.instanceId) {
          this.directReady = true;
          this.lastPong = Date.now();
          clearTimeout(this.negotiationTimeout);
          this.heartbeat = setInterval(() => this.ping(), 1500);
          this.updateAvailability();
          this.retryPending();
          void this.readCandidatePair(peer);
        } else if (packet?.type === 'pong' && this.pings.has(packet.id)) {
          this.status.rttMs = Math.round(performance.now() - this.pings.get(packet.id)!);
          this.pings.delete(packet.id);
          this.lastPong = Date.now();
          this.updateAvailability();
        } else if (packet?.type === 'ack') this.acceptReceipt(packet);
        else if (packet?.type === 'state') this.acceptState(packet.state);
        else if (packet?.type === 'session-replaced') this.replaced();
      };
      peer.onconnectionstatechange = () => {
        if (
          this.peer === peer &&
          ['failed', 'closed', 'disconnected'].includes(peer.connectionState)
        )
          this.closeDirect();
      };
      this.negotiationTimeout = setTimeout(() => {
        if (this.peer === peer) this.closeDirect();
      }, 12_000);
      await peer.setLocalDescription(await peer.createOffer());
      await this.gather(peer);
      if (this.peer !== peer) return;
      if (!this.publicSocket.connected) {
        this.closeDirect();
        return;
      }
      const session = { ...this.session };
      this.publicSocket.timeout(8000).emit(
        'rtc-offer',
        {
          id,
          session,
          description: { type: 'offer', sdp: peer.localDescription!.sdp },
        },
        async (error: Error | null, reply: Ack<DirectAnswer>) => {
          if (this.peer !== peer) return;
          if (error || !reply?.ok || reply.data?.id !== id) {
            this.closeDirect();
            return;
          }
          try {
            ticket = reply.data.ticket;
            await peer.setRemoteDescription(reply.data.description);
            if (this.peer === peer) authenticate();
          } catch {
            if (this.peer === peer) this.closeDirect();
          }
        },
      );
    } catch {
      this.closeDirect();
    }
  }
  private gather(peer: RTCPeerConnection): Promise<void> {
    if (peer.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        peer.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => {
        if (peer.iceGatheringState === 'complete' || this.peer !== peer) finish();
      };
      const timer = setTimeout(finish, 2000);
      peer.addEventListener('icegatheringstatechange', check);
      check();
    });
  }
  private sendDirect(packet: unknown) {
    if (this.channel?.readyState !== 'open' || this.channel.bufferedAmount > 256_000) return false;
    try {
      this.channel.send(JSON.stringify(packet));
      return true;
    } catch {
      return false;
    }
  }
  private ping() {
    if (!this.directReady) return;
    if (Date.now() - this.lastPong > 4500) {
      this.closeDirect();
      return;
    }
    const id = entryRequestId();
    this.pings.set(id, performance.now());
    this.sendDirect({ type: 'ping', id });
  }
  private async readCandidatePair(peer: RTCPeerConnection) {
    try {
      const stats = await peer.getStats();
      let pair: any;
      stats.forEach((s: any) => {
        if (s.type === 'transport' && s.selectedCandidatePairId)
          pair = stats.get(s.selectedCandidatePairId);
      });
      if (!pair)
        stats.forEach((s: any) => {
          if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
        });
      const local = stats.get(pair?.localCandidateId);
      const remote = stats.get(pair?.remoteCandidateId);
      if (this.peer !== peer || !local || !remote) return;
      this.status.candidatePair = {
        localType: local.candidateType,
        remoteType: remote.candidateType,
        protocol: local.protocol,
        localAddress: local.address ?? local.ip,
        remoteAddress: remote.address ?? remote.ip,
      };
      this.updateAvailability();
    } catch {
      /* Diagnostics are optional; a working data channel remains usable. */
    }
  }
  private closeDirect(retry = true) {
    const peer = this.peer;
    const id = this.negotiationId;
    this.peer = undefined;
    this.channel = undefined;
    this.negotiationId = undefined;
    this.directReady = false;
    clearTimeout(this.negotiationTimeout);
    clearInterval(this.heartbeat);
    clearTimeout(this.directRetry);
    this.pings.clear();
    this.status.rttMs = undefined;
    this.status.candidatePair = undefined;
    if (id && this.publicSocket.connected) this.publicSocket.volatile.emit('rtc-close', { id });
    if (peer) void peer.close();
    this.updateAvailability();
    this.retryPending();
    if (retry) this.scheduleDirect(this.options.directRetryMs ?? 20_000);
  }
  private replaced() {
    if (this.stopped) return;
    this.emitLocal('session-replaced');
    this.disconnect();
  }
  connect() {
    this.stopped = false;
    this.publicSocket.connect();
    return this;
  }
  disconnect() {
    this.stopped = true;
    this.closeDirect(false);
    this.publicSocket.disconnect();
    for (const p of [...this.pending.values()]) this.finish(p, new Error('连接已结束'));
    this.updateAvailability();
    return this;
  }
}

export function createPlayerConnection(url?: string, options?: PlayerConnectionOptions) {
  return new PlayerConnection(url, options);
}
