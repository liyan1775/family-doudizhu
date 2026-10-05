import type { Ack } from './types.js';

export const TRANSPORT_PROTOCOL = 1;
export const MESSAGE_LIMIT = 16_384;
export const GAME_EVENTS = [
  'create-room',
  'join-room',
  'enter-room',
  'resume-room',
  'ready',
  'bid',
  'rob',
  'play',
  'pass',
  'next-round',
  'leave-room',
] as const;
export type GameCommandEvent = (typeof GAME_EVENTS)[number];
export const ENTRY_EVENTS = new Set<string>(GAME_EVENTS.slice(0, 4));

/** One immutable command is reused on both routes, including after an ACK is lost. */
export interface CommandEnvelope {
  protocol: typeof TRANSPORT_PROTOCOL;
  instanceId: string;
  id: string;
  seq: number;
  event: GameCommandEvent;
  seat?: { roomId: string; playerId: string };
  data: unknown;
}
export interface CommandReceipt {
  type: 'ack';
  id: string;
  seq: number;
  reply: Ack<unknown>;
}
export interface LinkHello {
  protocol: typeof TRANSPORT_PROTOCOL;
  instanceId: string;
  rtc: boolean;
}
export interface DirectOffer {
  id: string;
  session: { roomId: string; playerId: string; token: string };
  description: { type: 'offer'; sdp: string };
}
export interface DirectAnswer {
  id: string;
  ticket: string;
  description: { type: 'answer'; sdp: string };
}
