export type GameMode = 'two' | 'three' | 'four';
export type RuleProfile =
  'two-simple' | 'two-rob' | 'three-classic' | 'four-classic' | 'four-jiangsu';
export type Suit = 'spades' | 'hearts' | 'clubs' | 'diamonds' | 'joker';
export interface Card {
  id: string;
  rank: number;
  suit: Suit;
}
export type ComboType =
  | 'single'
  | 'pair'
  | 'triple'
  | 'triple-single'
  | 'triple-pair'
  | 'straight'
  | 'pair-straight'
  | 'airplane'
  | 'airplane-single'
  | 'airplane-pair'
  | 'four-two-single'
  | 'four-two-pair'
  | 'bomb'
  | 'rocket';
export interface Combo {
  type: ComboType;
  rank: number;
  size: number;
  chain: number;
}
export interface Player {
  id: string;
  name: string;
  seat: number;
  ready: boolean;
  online: boolean;
  score: number;
}
export interface Play {
  playerId: string;
  cards: Card[];
  combo: Combo;
}
export interface GameAnnouncement {
  kind: 'ready' | 'deal' | 'bid' | 'landlord' | 'play' | 'pass' | 'finish' | 'info';
  text: string;
  audio: string[];
  actorId?: string;
}
export interface GameEvent extends GameAnnouncement {
  id: number;
  /** Ordered announcements from one action; each retains its own speaker. */
  announcements?: GameAnnouncement[];
}
export interface Settlement {
  playerId: string;
  delta: number;
}
export interface GameState {
  mode: GameMode;
  profile: RuleProfile;
  phase: 'waiting' | 'bidding' | 'calling' | 'robbing' | 'playing' | 'finished';
  players: Player[];
  hands: Record<string, Card[]>;
  bottom: Card[];
  turnId: string | null;
  landlordId: string | null;
  highestBid: number;
  highestBidder: string | null;
  bids: Record<string, number>;
  bombsPlayed: Record<string, number>;
  robCount: number;
  allowance: number;
  bidsTaken: number;
  startingSeat: number;
  round: number;
  lastPlay: Play | null;
  passCount: number;
  multiplier: number;
  playCounts: Record<string, number>;
  settlement: Settlement[];
  spring: boolean;
  winner: 'landlord' | 'farmers' | null;
  event: GameEvent;
}
export interface RoomView {
  /** Transport order, independent of the game's announcement/revision ID. */
  instanceId?: string;
  stateVersion?: number;
  roomId: string;
  hostId: string;
  youId: string;
  mode: GameMode;
  profile: RuleProfile;
  phase: GameState['phase'];
  players: (Player & { cardCount: number })[];
  hand: Card[];
  bottom: Card[];
  turnId: string | null;
  landlordId: string | null;
  highestBid: number;
  round: number;
  /** Server time and deadline; absent on hosts from earlier releases. */
  serverTime?: number;
  turnDeadline?: number | null;
  lastPlay: Play | null;
  multiplier: number;
  settlement: Settlement[];
  spring: boolean;
  winner: GameState['winner'];
  event: GameEvent;
  allowance: number;
  robCount: number;
  bombLimits: Record<string, { used: number; limit: number | null }>;
}
/** Public lobby metadata; private seat identities and cards are never included. */
export interface RoomSummary {
  roomId: string;
  hostName: string;
  mode: GameMode;
  profile: RuleProfile;
  playerCount: number;
  maxPlayers: number;
}
export interface Session {
  roomId: string;
  playerId: string;
  token: string;
}
export interface Ack<T = undefined> {
  ok: boolean;
  error?: string;
  data?: T;
}
export interface ClientCommand {
  revision: number;
}
export const MODES = {
  two: { name: '二人斗地主', players: 2, decks: 1, hand: 17, bottom: 3 },
  three: { name: '三人斗地主', players: 3, decks: 1, hand: 17, bottom: 3 },
  four: { name: '四人斗地主', players: 4, decks: 2, hand: 25, bottom: 8 },
} as const;
export const PROFILES: Record<RuleProfile, { name: string; mode: GameMode; summary: string }> = {
  'two-simple': {
    name: '二人简化',
    mode: 'two',
    summary: '54张，每人17张，3张底牌，20张不用；叫分，不让牌。',
  },
  'two-rob': {
    name: '双人抢地主',
    mode: 'two',
    summary: '去掉3和4，每人17张，3张底牌、9张不用；最多抢4次，农民可留对应张数获胜。',
  },
  'three-classic': {
    name: '经典三人',
    mode: 'three',
    summary: '一副54张，每人17张，3张底牌；叫1至3分，地主对两农民。',
  },
  'four-classic': {
    name: '江浙四人',
    mode: 'four',
    summary: '两副108张，每人25张，8张暗底牌；只带对子，四王最大，炸弹按张数比。',
  },
  'four-jiangsu': {
    name: '江苏废炸',
    mode: 'four',
    summary: '两副牌；叫过1/2分的农民限1/2次炸弹；A和2可下放，飞机带两对连对，八炸大于四王。',
  },
};
export const DEFAULT_PROFILE: Record<GameMode, RuleProfile> = {
  two: 'two-rob',
  three: 'three-classic',
  four: 'four-classic',
};
