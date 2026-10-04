import { createDeck, shuffle, sortCards } from './cards.js';
import { analyze, beats, comboAudio, describeCombo } from './rules.js';
import { DEFAULT_PROFILE, MODES, PROFILES } from './types.js';
import type { GameAnnouncement, GameMode, GameState, Player, RuleProfile } from './types.js';

export function createGame(
  mode: GameMode,
  profile: RuleProfile = DEFAULT_PROFILE[mode],
): GameState {
  if (PROFILES[profile]?.mode !== mode) throw new Error('人数与玩法不一致');
  return {
    mode,
    profile,
    phase: 'waiting',
    players: [],
    hands: {},
    bottom: [],
    turnId: null,
    landlordId: null,
    highestBid: 0,
    highestBidder: null,
    bidsTaken: 0,
    bids: {},
    bombsPlayed: {},
    robCount: 0,
    allowance: 0,
    startingSeat: 0,
    round: 0,
    lastPlay: null,
    passCount: 0,
    multiplier: 1,
    playCounts: {},
    settlement: [],
    spring: false,
    winner: null,
    event: { id: 0, kind: 'info', text: '等待家人入座', audio: [] },
  };
}
export function announce(
  game: GameState,
  text: string,
  audio: string[] = [],
  kind: GameState['event']['kind'] = 'info',
  actorId?: string,
  before: GameAnnouncement[] = [],
): void {
  const final = { text, audio, kind, actorId };
  game.event = {
    ...final,
    id: game.event.id + 1,
    ...(before.length
      ? {
          audio: [...before.flatMap((part) => part.audio), ...audio],
          announcements: [...before, final],
        }
      : {}),
  };
}
export function addPlayer(game: GameState, id: string, name: string): Player {
  if (game.phase !== 'waiting' && game.phase !== 'finished')
    throw new Error('已经开局，请等这一局结束');
  if (game.players.length >= MODES[game.mode].players) throw new Error('这桌已坐满，请另开一桌');
  const seat = Array.from({ length: MODES[game.mode].players }, (_, i) => i).find(
    (i) => !game.players.some((p) => p.seat === i),
  )!;
  const player = { id, name, seat, ready: false, online: true, score: 0 };
  game.players.push(player);
  game.players.sort((a, b) => a.seat - b.seat);
  announce(game, `${name}已入座`);
  return player;
}
function nextPlayer(game: GameState, id: string): string {
  return game.players[(game.players.findIndex((p) => p.id === id) + 1) % game.players.length].id;
}
function player(game: GameState, id: string): Player {
  const result = game.players.find((p) => p.id === id);
  if (!result) throw new Error('请先入座');
  return result;
}
function requireTurn(game: GameState, id: string, phase: GameState['phase'][]): Player {
  if (!phase.includes(game.phase)) throw new Error('当前不能进行这个操作');
  if (game.turnId !== id) throw new Error('还没轮到您，请稍等');
  if (game.players.some((p) => !p.online)) throw new Error('有家人暂时离线，等回来后继续');
  return player(game, id);
}
export function resetRound(game: GameState): void {
  if (game.phase !== 'finished') throw new Error('这一局还没结束');
  game.phase = 'waiting';
  game.turnId = null;
  game.hands = {};
  game.bottom = [];
  game.landlordId = null;
  game.lastPlay = null;
  game.players.forEach((p) => {
    p.ready = false;
  });
  announce(game, '下一局，点准备后开始', ['next-round']);
}
/** A player changing tables cancels only the unfinished round, preserving scores. */
export function cancelRound(game: GameState): void {
  const { players, round, startingSeat, event } = game;
  Object.assign(game, createGame(game.mode, game.profile), { players, round, startingSeat, event });
  players.forEach((p) => {
    p.ready = false;
  });
}
export function setReady(
  game: GameState,
  id: string,
  ready: boolean,
  randomInt?: (max: number) => number,
): void {
  if (game.phase !== 'waiting') throw new Error('现在不能准备');
  const p = player(game, id);
  p.ready = ready;
  announce(game, `${p.name}${ready ? '已准备' : '取消准备'}`, ready ? ['ready'] : [], 'ready', id);
  if (
    game.players.length === MODES[game.mode].players &&
    game.players.every((p) => p.ready && p.online)
  )
    deal(game, randomInt);
}
export function deal(game: GameState, randomInt?: (max: number) => number): void {
  const config = MODES[game.mode];
  let deck = createDeck(config.decks);
  if (game.profile === 'two-rob') deck = deck.filter((c) => c.rank !== 3 && c.rank !== 4);
  const cards = shuffle(deck, randomInt);
  game.hands = {};
  game.playCounts = {};
  game.bids = {};
  game.bombsPlayed = {};
  game.players.forEach((p, i) => {
    game.hands[p.id] = sortCards(cards.slice(i * config.hand, (i + 1) * config.hand));
    game.playCounts[p.id] = 0;
    game.bombsPlayed[p.id] = 0;
    p.ready = false;
  });
  game.bottom = cards.slice(
    config.hand * config.players,
    config.hand * config.players + config.bottom,
  );
  game.phase = game.profile === 'two-rob' ? 'calling' : 'bidding';
  game.turnId = game.players[game.startingSeat % config.players].id;
  game.landlordId = null;
  game.highestBid = 0;
  game.highestBidder = null;
  game.bidsTaken = 0;
  game.robCount = 0;
  game.allowance = 0;
  game.lastPlay = null;
  game.passCount = 0;
  game.multiplier = 1;
  game.settlement = [];
  game.winner = null;
  game.spring = false;
  game.round++;
  announce(game, '发牌完成，开始叫地主', ['deal'], 'deal');
}
function chooseLandlord(game: GameState, id: string, call: GameAnnouncement): void {
  game.landlordId = id;
  game.hands[id] = sortCards([...game.hands[id], ...game.bottom]);
  game.turnId = id;
  game.phase = 'playing';
  announce(
    game,
    `${player(game, id).name}当地主${game.allowance ? `，让${game.allowance}张牌` : ''}`,
    ['landlord'],
    'landlord',
    id,
    [call],
  );
}
export function bid(
  game: GameState,
  id: string,
  value: number,
  randomInt?: (max: number) => number,
): void {
  const p = requireTurn(game, id, ['bidding']);
  if (![0, 1, 2, 3].includes(value) || (value !== 0 && value <= game.highestBid))
    throw new Error('请叫更高的分，或选择不叫');
  game.bids[id] = value;
  game.bidsTaken++;
  if (value > game.highestBid) {
    game.highestBid = value;
    game.highestBidder = id;
  }
  const call: GameAnnouncement = {
    text: `${p.name}${value ? `叫${value}分` : '不叫'}`,
    audio: [value ? `bid-${value}` : 'no-bid'],
    kind: 'bid',
    actorId: id,
  };
  if (value === 3 || game.bidsTaken === game.players.length) {
    if (game.highestBidder) chooseLandlord(game, game.highestBidder, call);
    else {
      game.startingSeat = (game.startingSeat + 1) % game.players.length;
      deal(game, randomInt);
      announce(game, '大家都不叫，重新发牌', ['redeal'], 'deal', undefined, [call]);
    }
  } else {
    game.turnId = nextPlayer(game, id);
    announce(game, call.text, call.audio, 'bid', id);
  }
}
export function rob(
  game: GameState,
  id: string,
  yes: boolean,
  randomInt?: (max: number) => number,
): void {
  const p = requireTurn(game, id, ['calling', 'robbing']);
  const wasCalling = game.phase === 'calling';
  const call: GameAnnouncement = {
    text: `${p.name}${yes ? (wasCalling ? '叫地主' : '抢地主') : wasCalling ? '不叫' : '不抢'}`,
    audio: [
      yes ? (wasCalling ? 'call-landlord' : 'rob-landlord') : wasCalling ? 'no-bid' : 'no-rob',
    ],
    kind: 'bid',
    actorId: id,
  };
  if (yes) {
    game.highestBidder = id;
    game.robCount++;
    game.allowance = game.robCount;
    game.highestBid = [1, 2, 4, 5, 6][game.robCount];
    if (game.robCount === 4) {
      chooseLandlord(game, id, call);
      return;
    }
    game.phase = 'robbing';
    game.turnId = nextPlayer(game, id);
    announce(
      game,
      `${p.name}${wasCalling ? '叫地主' : '抢地主'}，让${game.allowance}张`,
      [wasCalling ? 'call-landlord' : 'rob-landlord'],
      'bid',
      id,
    );
  } else if (wasCalling) {
    game.bidsTaken++;
    if (game.bidsTaken >= game.players.length) {
      game.startingSeat = (game.startingSeat + 1) % game.players.length;
      deal(game, randomInt);
      announce(game, '大家都不叫，重新发牌', ['redeal'], 'deal', undefined, [call]);
    } else {
      game.turnId = nextPlayer(game, id);
      announce(game, `${p.name}不叫`, ['no-bid'], 'bid', id);
    }
  } else chooseLandlord(game, game.highestBidder!, call);
}
export function bombLimit(game: GameState, id: string): number | null {
  if (game.profile !== 'four-jiangsu' || id === game.landlordId) return null;
  const value = game.bids[id] ?? 0;
  return value > 0 ? value : null;
}
export function playCards(game: GameState, id: string, ids: string[]): void {
  const p = requireTurn(game, id, ['playing']);
  if (!Array.isArray(ids) || !ids.length || ids.length > 33 || new Set(ids).size !== ids.length)
    throw new Error('请先选好要出的牌');
  const hand = game.hands[id];
  const cards = ids.map((cardId) => hand.find((c) => c.id === cardId));
  if (cards.some((c) => !c)) throw new Error('选中的牌已不在手里，请重新选牌');
  const combo = analyze(cards as NonNullable<(typeof cards)[number]>[], game.mode, game.profile);
  if (!combo)
    throw new Error(
      game.mode === 'four'
        ? '这组牌不符合四人规则；三张和飞机只能带对子'
        : '这组牌不能这样出，请重新选牌',
    );
  if (!beats(combo, game.lastPlay?.combo ?? null, game.mode, game.profile))
    throw new Error('这组牌还不够大，请换牌或点不出');
  const isBomb = combo.type === 'bomb' || combo.type === 'rocket';
  const limit = bombLimit(game, id);
  if (isBomb && limit !== null && game.bombsPlayed[id] >= limit)
    throw new Error('本局的炸弹次数已用完，请拆成普通牌型');
  const selected = new Set(ids);
  game.hands[id] = hand.filter((c) => !selected.has(c.id));
  game.lastPlay = {
    playerId: id,
    cards: sortCards(cards as NonNullable<(typeof cards)[number]>[]),
    combo,
  };
  game.passCount = 0;
  game.playCounts[id]++;
  if (isBomb) {
    game.bombsPlayed[id]++;
    game.multiplier *=
      game.mode === 'four'
        ? combo.type === 'rocket' || combo.size === 8
          ? 3
          : combo.size >= 6
            ? 2
            : 1
        : 2;
  }
  const remaining = game.hands[id].length;
  if (
    remaining === 0 ||
    (game.profile === 'two-rob' && id !== game.landlordId && remaining <= game.allowance)
  ) {
    finish(game, id, comboAudio(combo, game.mode));
  } else {
    game.turnId = nextPlayer(game, id);
    announce(
      game,
      `${p.name}出了${describeCombo(combo)}`,
      [comboAudio(combo, game.mode)],
      'play',
      id,
    );
  }
}
export function pass(game: GameState, id: string): void {
  const p = requireTurn(game, id, ['playing']);
  if (!game.lastPlay) throw new Error('这一轮由您先出，不能不出');
  game.passCount++;
  game.turnId = nextPlayer(game, id);
  if (game.passCount === game.players.length - 1) {
    game.turnId = game.lastPlay.playerId;
    game.lastPlay = null;
    game.passCount = 0;
  }
  announce(game, `${p.name}不出`, ['pass'], 'pass', id);
}
function finish(game: GameState, winnerId: string, lastAudio: string): void {
  const landlordWon = winnerId === game.landlordId;
  game.winner = landlordWon ? 'landlord' : 'farmers';
  game.spring = landlordWon
    ? game.players.filter((p) => p.id !== game.landlordId).every((p) => game.playCounts[p.id] === 0)
    : game.playCounts[game.landlordId!] === 1;
  if (game.spring) game.multiplier *= 2;
  const unit = Math.max(1, game.highestBid) * game.multiplier;
  game.settlement = game.players.map((p) => ({
    playerId: p.id,
    delta:
      p.id === game.landlordId
        ? unit * (game.players.length - 1) * (landlordWon ? 1 : -1)
        : unit * (landlordWon ? -1 : 1),
  }));
  game.players.forEach((p) => {
    p.score += game.settlement.find((s) => s.playerId === p.id)!.delta;
  });
  game.phase = 'finished';
  game.turnId = null;
  game.startingSeat = (game.startingSeat + 1) % game.players.length;
  announce(
    game,
    `${landlordWon ? '地主' : '农民'}赢了${game.spring ? '，春天翻倍' : ''}`,
    [lastAudio, ...(game.spring ? ['spring'] : []), landlordWon ? 'landlord-win' : 'farmers-win'],
    'finish',
    winnerId,
  );
}
