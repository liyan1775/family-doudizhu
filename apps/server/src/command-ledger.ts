import { createHash } from 'node:crypto';
import {
  GAME_EVENTS,
  MESSAGE_LIMIT,
  TRANSPORT_PROTOCOL,
  type CommandEnvelope,
  type CommandReceipt,
} from '../../../packages/game/src/transport.js';
import type { Ack } from '../../../packages/game/src/types.js';

/** Bounded receipts plus a permanent high-water mark: evicted commands cannot execute again. */
export class CommandLedger {
  private receipts = new Map<
    string,
    { fingerprint: string; receipt: CommandReceipt; at: number }
  >();
  private highest = 0;
  constructor(
    private readonly instanceId: string,
    private readonly limit = 256,
  ) {}

  execute(raw: unknown, run: (command: CommandEnvelope) => Ack<unknown>): CommandReceipt {
    const c = raw as CommandEnvelope | null;
    const fail = (error: string): CommandReceipt => ({
      type: 'ack',
      id: typeof c?.id === 'string' ? c.id : '',
      seq: Number.isSafeInteger(c?.seq) ? c!.seq : 0,
      reply: { ok: false, error },
    });
    if (
      !c ||
      c.protocol !== TRANSPORT_PROTOCOL ||
      c.instanceId !== this.instanceId ||
      typeof c.id !== 'string' ||
      !/^[a-zA-Z0-9-]{16,80}$/.test(c.id) ||
      !Number.isSafeInteger(c.seq) ||
      c.seq < 1 ||
      !GAME_EVENTS.includes(c.event)
    )
      return fail('消息身份已失效，请重新连接');
    const serialized = JSON.stringify(c);
    if (Buffer.byteLength(serialized) > MESSAGE_LIMIT) return fail('消息过长');
    const fingerprint = createHash('sha256').update(serialized).digest('hex');
    const saved = this.receipts.get(c.id);
    // Check receipts BEFORE scope/revision checks. The action may have advanced the game.
    if (saved)
      return saved.fingerprint === fingerprint ? saved.receipt : fail('同一消息的内容不能变更');
    if (c.seq <= this.highest) return fail('消息已经过期，请按当前画面操作');
    this.highest = c.seq;
    const receipt: CommandReceipt = { type: 'ack', id: c.id, seq: c.seq, reply: run(c) };
    this.receipts.set(c.id, { fingerprint, receipt, at: Date.now() });
    this.prune();
    return receipt;
  }
  prune(now = Date.now()) {
    for (const [id, saved] of this.receipts) {
      if (saved.at < now - 120_000 || this.receipts.size > this.limit) this.receipts.delete(id);
      else break;
    }
  }
}
