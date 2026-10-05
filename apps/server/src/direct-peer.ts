import { randomBytes } from 'node:crypto';
import { RTCPeerConnection, type RTCDataChannel } from 'werift';
import {
  MESSAGE_LIMIT,
  type DirectAnswer,
  type DirectOffer,
} from '../../../packages/game/src/transport.js';

/** One data-only peer in the existing server process. No STUN/TURN or media permission. */
export class DirectPeer {
  readonly pc = new RTCPeerConnection({ iceServers: [], iceUseIpv6: false });
  readonly ticket = randomBytes(32).toString('base64url');
  ready = false;
  closed = false;
  private channel?: RTCDataChannel;
  private lastPing = Date.now();
  private readonly expires: ReturnType<typeof setTimeout>;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private closePromise?: Promise<void>;

  constructor(
    readonly id: string,
    private readonly instanceId: string,
    private readonly callbacks: {
      ready: () => void;
      message: (packet: unknown) => void;
      closed: () => void;
      disposed: () => void;
    },
  ) {
    this.expires = setTimeout(() => {
      void this.close();
    }, 15_000);
    this.expires.unref();
    this.heartbeat = setInterval(() => {
      if (this.ready && Date.now() - this.lastPing > 5500) void this.close();
    }, 1000);
    this.heartbeat.unref();
    this.pc.connectionStateChange.subscribe((state) => {
      if (['failed', 'closed', 'disconnected'].includes(state)) void this.close();
    });
    this.pc.onDataChannel.subscribe((channel) => {
      if (
        this.closed ||
        this.channel ||
        channel.label !== 'family-doudizhu-v1' ||
        !channel.ordered ||
        channel.maxRetransmits !== null ||
        channel.maxPacketLifeTime !== null
      ) {
        channel.close();
        return;
      }
      this.channel = channel;
      channel.onMessage.subscribe((raw) => {
        if (this.closed || typeof raw !== 'string' || Buffer.byteLength(raw) > MESSAGE_LIMIT) {
          void this.close();
          return;
        }
        let packet: any;
        try {
          packet = JSON.parse(raw);
        } catch {
          void this.close();
          return;
        }
        if (!this.ready) {
          if (packet?.type !== 'hello' || packet.ticket !== this.ticket) {
            void this.close();
            return;
          }
          this.ready = true;
          this.lastPing = Date.now();
          clearTimeout(this.expires);
          this.send({ type: 'welcome', instanceId });
          this.callbacks.ready();
          return;
        }
        if (packet?.type === 'ping' && typeof packet.id === 'string' && packet.id.length <= 80) {
          // Bound keepalives too; a valid peer must not fill the process with pongs.
          if (Date.now() - this.lastPing < 100) return;
          this.lastPing = Date.now();
          this.send({ type: 'pong', id: packet.id });
        } else if (packet?.type === 'command') this.callbacks.message(packet.command);
      });
      channel.stateChange.subscribe((state) => {
        if (state === 'closed') void this.close();
      });
      channel.error.subscribe(() => {
        void this.close();
      });
    });
  }
  async answer(offer: DirectOffer): Promise<DirectAnswer> {
    await this.pc.setRemoteDescription(offer.description);
    if (this.closed) throw new Error('直连协商已结束');
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    if (this.closed) throw new Error('直连协商已结束');
    const description = this.pc.localDescription!;
    return {
      id: this.id,
      ticket: this.ticket,
      description: { type: 'answer', sdp: description.sdp },
    };
  }
  send(packet: unknown): boolean {
    if (this.closed || !this.channel || this.channel.readyState !== 'open') return false;
    const data = JSON.stringify(packet);
    if (Buffer.byteLength(data) > MESSAGE_LIMIT || this.channel.bufferedAmount > 256_000)
      return false;
    try {
      this.channel.send(data);
      return true;
    } catch {
      void this.close();
      return false;
    }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.ready = false;
    clearTimeout(this.expires);
    clearInterval(this.heartbeat);
    // Defer disposal so reentrant state callbacks see closePromise already assigned.
    this.closePromise = Promise.resolve()
      .then(async () => {
        this.callbacks.closed();
        this.channel?.close();
        await this.pc.close();
      })
      .finally(this.callbacks.disposed);
    return this.closePromise;
  }
}
