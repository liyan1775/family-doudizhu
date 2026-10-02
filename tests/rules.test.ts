import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, beats, createDeck, suggestPlay } from '../packages/game/src/index.js';
import type { Card, ComboType, GameMode, RuleProfile } from '../packages/game/src/index.js';

function cards(ranks: number[]): Card[] {
  const deck = createDeck(2);
  return ranks.map((rank) => {
    const index = deck.findIndex((c) => c.rank === rank);
    assert.ok(index >= 0);
    return deck.splice(index, 1)[0];
  });
}
test('识别三人常见牌型，拒绝重复牌和不连续顺子', () => {
  const cases: [number[], ComboType][] = [
    [[3], 'single'],
    [[3, 3], 'pair'],
    [[3, 3, 3], 'triple'],
    [[3, 3, 3, 4], 'triple-single'],
    [[3, 3, 3, 4, 4], 'triple-pair'],
    [[3, 4, 5, 6, 7], 'straight'],
    [[3, 3, 4, 4, 5, 5], 'pair-straight'],
    [[3, 3, 3, 4, 4, 4], 'airplane'],
    [[3, 3, 3, 4, 4, 4, 5, 6], 'airplane-single'],
    [[3, 3, 3, 4, 4, 4, 5, 5, 6, 6], 'airplane-pair'],
    [[3, 3, 3, 3, 4, 5], 'four-two-single'],
    [[3, 3, 3, 3, 4, 4, 5, 5], 'four-two-pair'],
    [[3, 3, 3, 3], 'bomb'],
    [[16, 17], 'rocket'],
  ];
  for (const [input, type] of cases)
    assert.equal(analyze(cards(input))?.type, type, input.toString());
  for (const input of [
    [3, 4, 5, 6, 8],
    [11, 12, 13, 14, 15],
    [3, 3, 4, 4],
    [3, 3, 3, 3, 4, 4, 4, 4],
  ])
    assert.equal(analyze(cards(input)), null);
  const one = cards([3])[0];
  assert.equal(analyze([one, one]), null);
});
test('压牌比较牌型、长度、主点数；带牌点数不改变大小', () => {
  const small = analyze(cards([3, 3, 3, 17]))!;
  const large = analyze(cards([4, 4, 4, 5]))!;
  assert.ok(beats(large, small));
  assert.ok(!beats(analyze(cards([3, 3, 3, 4, 4]))!, small));
  assert.ok(!beats(analyze(cards([4, 5, 6, 7, 8, 9]))!, analyze(cards([3, 4, 5, 6, 7]))));
  assert.ok(beats(analyze(cards([3, 3, 3, 3]))!, large));
  assert.ok(beats(analyze(cards([16, 17]))!, analyze(cards([15, 15, 15, 15]))));
});
test('四人牌型不能三带一、飞机带单牌或四带二；王对子不是王炸', () => {
  for (const input of [
    [3, 3, 3, 4],
    [3, 3, 3, 4, 4, 4, 5, 6],
    [3, 3, 3, 3, 4, 5],
    [3, 3, 3, 3, 4, 4, 5, 5],
    [16, 17],
  ])
    assert.equal(analyze(cards(input), 'four'), null);
  assert.equal(analyze(cards([16, 16]), 'four')?.type, 'pair');
  assert.equal(analyze(cards([16, 16, 17, 17]), 'four')?.type, 'rocket');
  assert.equal(analyze(cards([3, 3, 3, 4, 4, 4, 5, 5, 7, 7]), 'four')?.type, 'airplane-pair');
});
test('四人炸弹按张数比较；江苏废炸八炸大于四王，普通版四王最大', () => {
  const five = analyze(cards([3, 3, 3, 3, 3]), 'four')!;
  const four = analyze(cards([15, 15, 15, 15]), 'four')!;
  const eight = analyze(cards(Array(8).fill(3)), 'four')!;
  const kings = analyze(cards([16, 16, 17, 17]), 'four')!;
  assert.ok(beats(five, four, 'four'));
  assert.ok(beats(kings, eight, 'four'));
  assert.ok(!beats(eight, kings, 'four'));
  assert.ok(beats(eight, kings, 'four', 'four-jiangsu'));
  assert.ok(!beats(kings, eight, 'four', 'four-jiangsu'));
});
test('江苏废炸支持A2下放，并限制飞机的翅膀为两对连对', () => {
  const low = cards([14, 15, 3, 4, 5]);
  assert.equal(analyze(low, 'four'), null);
  assert.equal(analyze(low, 'four', 'four-jiangsu')?.rank, 5);
  const normal = analyze(cards([3, 4, 5, 6, 7]), 'four', 'four-jiangsu')!;
  assert.ok(beats(normal, analyze(low, 'four', 'four-jiangsu')!, 'four', 'four-jiangsu'));
  assert.equal(analyze(cards([3, 3, 3, 4, 4, 4, 5, 5, 7, 7]), 'four', 'four-jiangsu'), null);
  assert.equal(
    analyze(cards([3, 3, 3, 4, 4, 4, 5, 5, 6, 6]), 'four', 'four-jiangsu')?.type,
    'airplane-pair',
  );
  assert.equal(
    analyze(cards([11, 11, 11, 12, 12, 12, 14, 14, 15, 15]), 'four', 'four-jiangsu')?.type,
    'airplane-pair',
  );
});
test('提示输出可出手牌，支持A2下放和炸弹次数已用完', () => {
  const cases: [number[], number[] | null, GameMode, RuleProfile?][] = [
    [[4, 4, 5], [3, 3], 'three'],
    [[3, 3, 3, 3], [17], 'three'],
    [[14, 15, 3, 4, 5], null, 'four', 'four-jiangsu'],
    [[6, 6, 6, 7, 7, 7, 9, 9, 10, 10], [3, 3, 3, 4, 4, 4, 5, 5, 6, 6], 'four', 'four-jiangsu'],
  ];
  for (const [input, prev, mode, profile] of cases) {
    const hand = cards(input);
    const previous = prev ? analyze(cards(prev), mode, profile) : null;
    const ids = suggestPlay(hand, previous, mode, profile);
    const combo = analyze(
      hand.filter((c) => ids.includes(c.id)),
      mode,
      profile,
    )!;
    assert.ok(combo && beats(combo, previous, mode, profile));
  }
  assert.deepEqual(
    suggestPlay(cards([3, 3, 3, 3]), analyze(cards([17]))!, 'four', 'four-jiangsu', false),
    [],
  );
});
