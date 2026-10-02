import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addPlayer,
  bid,
  bombLimit,
  createDeck,
  createGame,
  MODES,
  pass,
  playCards,
  PROFILES,
  resetRound,
  rob,
  setReady,
  suggestPlay,
} from '../packages/game/src/index.js';
import type { GameState, RuleProfile } from '../packages/game/src/index.js';

function prepared(profile: RuleProfile): GameState {
  const mode = PROFILES[profile].mode;
  const game = createGame(mode, profile);
  for (let i = 0; i < MODES[mode].players; i++) addPlayer(game, `p${i}`, `家人${i + 1}`);
  for (const p of game.players) setReady(game, p.id, true);
  return game;
}
function landlord(game: GameState) {
  if (game.phase === 'calling') {
    rob(game, game.turnId!, true);
    rob(game, game.turnId!, false);
  } else bid(game, game.turnId!, 3);
}
test('五种规则配置发牌数量正确，二人短牌库去掉3和4；底牌与手牌不重复', () => {
  for (const profile of Object.keys(PROFILES) as RuleProfile[]) {
    const game = prepared(profile);
    const dealt = [...Object.values(game.hands).flat(), ...game.bottom];
    assert.equal(new Set(dealt.map((c) => c.id)).size, dealt.length);
    assert.equal(game.bottom.length, MODES[game.mode].bottom);
    for (const p of game.players) assert.equal(game.hands[p.id].length, MODES[game.mode].hand);
    if (profile === 'two-rob') assert.ok(dealt.every((c) => c.rank >= 5));
    landlord(game);
    assert.equal(
      game.hands[game.landlordId!].length,
      MODES[game.mode].hand + MODES[game.mode].bottom,
    );
    assert.equal(game.turnId, game.landlordId);
  }
});
test('轮次、首出不允许过牌；不可重复出牌或出别人的牌', () => {
  const game = prepared('three-classic');
  landlord(game);
  assert.throws(() => pass(game, game.turnId!), /不能不出/);
  assert.throws(() => playCards(game, 'p1', [game.hands.p0[0].id]), /还没轮到/);
  assert.throws(() => playCards(game, 'p0', [game.hands.p1[0].id]), /已不在/);
  const id = game.hands.p0[0].id;
  assert.throws(() => playCards(game, 'p0', [id, id]), /选好/);
  playCards(game, 'p0', [id]);
  pass(game, 'p1');
  pass(game, 'p2');
  assert.equal(game.turnId, 'p0');
  assert.equal(game.lastPlay, null);
});
test('全员不叫会重新发牌并轮换首叫玩家，离线会暂停动作', () => {
  const game = prepared('four-classic');
  for (let i = 0; i < 4; i++) bid(game, game.turnId!, 0);
  assert.equal(game.round, 2);
  assert.equal(game.turnId, 'p1');
  game.players[2].online = false;
  assert.throws(() => bid(game, 'p1', 3), /暂时离线/);
});
test('二人抢地主最多4次，农民按让牌数获胜', () => {
  const game = prepared('two-rob');
  for (let i = 0; i < 4; i++) rob(game, game.turnId!, true);
  assert.equal(game.phase, 'playing');
  assert.equal(game.allowance, 4);
  assert.equal(game.robCount, 4);
  const farmer = game.players.find((p) => p.id !== game.landlordId)!.id;
  const deck = createDeck();
  game.hands[farmer] = deck.filter((c) => c.rank === 5).concat(deck.find((c) => c.rank === 6)!);
  game.turnId = farmer;
  playCards(game, farmer, [game.hands[farmer].at(-1)!.id]);
  assert.equal(game.phase, 'finished');
  assert.equal(game.winner, 'farmers');
});
test('江苏废炸：叫1/2分的农民受到次数限制，地主和不叫的农民不限', () => {
  const game = prepared('four-jiangsu');
  bid(game, 'p0', 1);
  bid(game, 'p1', 2);
  bid(game, 'p2', 3);
  assert.equal(bombLimit(game, 'p0'), 1);
  assert.equal(bombLimit(game, 'p1'), 2);
  assert.equal(bombLimit(game, 'p2'), null);
  assert.equal(bombLimit(game, 'p3'), null);
  game.turnId = 'p0';
  game.hands.p0 = createDeck().filter((c) => c.rank === 3);
  game.bombsPlayed.p0 = 1;
  assert.throws(
    () =>
      playCards(
        game,
        'p0',
        game.hands.p0.map((c) => c.id),
      ),
    /次数已用完/,
  );
});
test('五种玩法各完成多局，积分零和，结算后可开始下一局', () => {
  for (const profile of Object.keys(PROFILES) as RuleProfile[]) {
    for (let round = 0; round < 6; round++) {
      const game = prepared(profile);
      landlord(game);
      let actions = 0;
      while (game.phase === 'playing' && actions++ < 600) {
        const id = game.turnId!;
        const limit = bombLimit(game, id);
        const ids = suggestPlay(
          game.hands[id],
          game.lastPlay?.combo ?? null,
          game.mode,
          game.profile,
          limit === null || game.bombsPlayed[id] < limit,
        );
        if (ids.length) playCards(game, id, ids);
        else pass(game, id);
      }
      assert.equal(game.phase, 'finished', `${profile}第${round}局未结束`);
      assert.equal(
        game.players.reduce((sum, p) => sum + p.score, 0),
        0,
      );
      assert.equal(
        game.settlement.reduce((sum, p) => sum + p.delta, 0),
        0,
      );
      resetRound(game);
      assert.equal(game.phase, 'waiting');
      assert.equal(game.lastPlay, null);
    }
  }
});
