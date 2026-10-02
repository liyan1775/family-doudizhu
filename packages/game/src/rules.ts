import { rankLabel } from './cards.js';
import type { Card, Combo, ComboType, GameMode, RuleProfile } from './types.js';

function grouped(cards: Card[]): Map<number, Card[]> {
  const result = new Map<number, Card[]>();
  for (const card of cards) result.set(card.rank, [...(result.get(card.rank) ?? []), card]);
  return result;
}
function consecutive(ranks: number[]): boolean {
  return ranks.every((rank, i) => rank <= 14 && (i === 0 || rank === ranks[i - 1] + 1));
}
export function analyze(
  cards: Card[],
  mode: GameMode = 'three',
  profile?: RuleProfile,
): Combo | null {
  if (!cards.length || new Set(cards.map((c) => c.id)).size !== cards.length) return null;
  const groups = grouped(cards);
  const ranks = [...groups.keys()].sort((a, b) => a - b);
  if (ranks.some((r) => !Number.isInteger(r) || r < 3 || r > 17)) return null;
  const n = cards.length;
  const combo = (type: ComboType, rank: number, chain = 1): Combo => ({
    type,
    rank,
    size: n,
    chain,
  });
  const count = (rank: number) => groups.get(rank)?.length ?? 0;
  const rocketSize = mode === 'four' ? 4 : 2;
  if (
    n === rocketSize &&
    ranks.length === 2 &&
    count(16) === rocketSize / 2 &&
    count(17) === rocketSize / 2
  ) {
    return combo('rocket', 17);
  }
  if (ranks.length === 1) {
    if (n === 1) return combo('single', ranks[0]);
    if (n === 2) return combo('pair', ranks[0]);
    if (n === 3 && ranks[0] <= 15) return combo('triple', ranks[0]);
    if (n >= 4 && n <= (mode === 'four' ? 8 : 4) && ranks[0] <= 15) return combo('bomb', ranks[0]);
  }
  const triple = ranks.find((r) => count(r) === 3);
  if (triple !== undefined && ranks.length === 2) {
    if (n === 4 && mode !== 'four') return combo('triple-single', triple);
    if (n === 5 && ranks.some((r) => count(r) === 2)) return combo('triple-pair', triple);
  }
  if (consecutive(ranks)) {
    if (n >= 5 && ranks.every((r) => count(r) === 1))
      return combo('straight', ranks.at(-1)!, ranks.length);
    if (ranks.length >= 3 && ranks.every((r) => count(r) === 2))
      return combo('pair-straight', ranks.at(-1)!, ranks.length);
    if (ranks.length >= 2 && ranks.every((r) => count(r) === 3))
      return combo('airplane', ranks.at(-1)!, ranks.length);
  }
  if (profile === 'four-jiangsu') {
    const low = ranks.map((r) => (r === 14 ? 1 : r === 15 ? 2 : r)).sort((a, b) => a - b);
    if (low.some((r) => r < 3) && consecutive(low)) {
      const original = (r: number) => (r === 1 ? 14 : r === 2 ? 15 : r);
      if (n >= 5 && low.every((r) => count(original(r)) === 1))
        return combo('straight', low.at(-1)!, low.length);
      if (low.length >= 3 && low.every((r) => count(original(r)) === 2))
        return combo('pair-straight', low.at(-1)!, low.length);
      if (low.length >= 2 && low.every((r) => count(original(r)) === 3))
        return combo('airplane', low.at(-1)!, low.length);
    }
  }
  for (const wingSize of [1, 2] as const) {
    if (mode === 'four' && wingSize === 1) continue;
    const length = n / (3 + wingSize);
    if (!Number.isInteger(length) || length < 2) continue;
    if (profile === 'four-jiangsu' && length !== 2) continue;
    for (let start = profile === 'four-jiangsu' ? 1 : 3; start + length - 1 <= 14; start++) {
      const coreOrder = Array.from({ length }, (_, i) => start + i);
      const core = coreOrder.map((r) => (r === 1 ? 14 : r === 2 ? 15 : r));
      if (!core.every((r) => count(r) === 3)) continue;
      const wings = ranks.filter((r) => !core.includes(r));
      const valid =
        wingSize === 1
          ? wings.reduce((sum, r) => sum + count(r), 0) === length &&
            wings.every((r) => count(r) <= 2)
          : wings.length === length && wings.every((r) => count(r) === 2);
      if (valid) {
        if (
          profile === 'four-jiangsu' &&
          !consecutive(wings) &&
          !consecutive(wings.map((r) => (r === 14 ? 1 : r === 15 ? 2 : r)).sort((a, b) => a - b))
        )
          continue;
        return combo(
          wingSize === 1 ? 'airplane-single' : 'airplane-pair',
          coreOrder.at(-1)!,
          length,
        );
      }
    }
  }
  const quad = ranks.find((r) => count(r) === 4 && r <= 15);
  if (quad !== undefined && mode !== 'four') {
    if (n === 6) return combo('four-two-single', quad);
    if (
      n === 8 &&
      ranks.length === 3 &&
      ranks.filter((r) => r !== quad).every((r) => count(r) === 2)
    ) {
      return combo('four-two-pair', quad);
    }
  }
  return null;
}
export function beats(
  next: Combo,
  previous: Combo | null,
  mode: GameMode = 'three',
  profile?: RuleProfile,
): boolean {
  if (!previous) return true;
  if (
    profile === 'four-jiangsu' &&
    (next.type === 'rocket' || next.type === 'bomb') &&
    (previous.type === 'rocket' || previous.type === 'bomb')
  ) {
    const weight = (c: Combo) => (c.type === 'rocket' ? 7.5 : c.size);
    return (
      weight(next) > weight(previous) ||
      (weight(next) === weight(previous) && next.rank > previous.rank)
    );
  }
  if (previous.type === 'rocket') return false;
  if (next.type === 'rocket') return true;
  if (next.type === 'bomb') {
    if (previous.type !== 'bomb') return true;
    if (mode === 'four' && next.size !== previous.size) return next.size > previous.size;
    return next.rank > previous.rank;
  }
  return (
    next.type === previous.type &&
    next.size === previous.size &&
    next.chain === previous.chain &&
    next.rank > previous.rank
  );
}
const LABELS: Record<ComboType, string> = {
  single: '单张',
  pair: '对子',
  triple: '三张',
  'triple-single': '三带一',
  'triple-pair': '三带二',
  straight: '顺子',
  'pair-straight': '连对',
  airplane: '飞机',
  'airplane-single': '飞机带单牌',
  'airplane-pair': '飞机带对子',
  'four-two-single': '四带二',
  'four-two-pair': '四带两对',
  bomb: '炸弹',
  rocket: '王炸',
};
export function describeCombo(combo: Combo): string {
  if (combo.type === 'single') return rankLabel(combo.rank);
  if (combo.type === 'pair') return `对${rankLabel(combo.rank)}`;
  if (combo.type === 'triple') return `三个${rankLabel(combo.rank)}`;
  if (combo.type === 'bomb' && combo.size > 4) return `${combo.size}张炸弹`;
  return LABELS[combo.type];
}
export function comboAudio(combo: Combo, mode?: GameMode): string {
  if (mode === 'four' && combo.type === 'rocket') return 'four-rocket';
  if (['single', 'pair', 'triple'].includes(combo.type)) return `${combo.type}-${combo.rank}`;
  if (combo.type === 'bomb' && combo.size > 4) return `bomb-${combo.size}`;
  return combo.type;
}

// 按牌型生成候选，避免在四人手牌上枚举全部子集。
export function suggestPlay(
  hand: Card[],
  previous: Combo | null,
  mode: GameMode = 'three',
  profile?: RuleProfile,
  allowBomb = true,
): string[] {
  const groups = grouped(hand);
  const ranks = [...groups.keys()].sort((a, b) => a - b);
  const get = (rank: number, count: number) => (groups.get(rank) ?? []).slice(0, count);
  const candidates: { cards: Card[]; combo: Combo }[] = [];
  const add = (cards: Card[]) => {
    const combo = analyze(cards, mode, profile);
    if (
      combo &&
      (!['bomb', 'rocket'].includes(combo.type) || allowBomb) &&
      beats(combo, previous, mode, profile)
    )
      candidates.push({ cards, combo });
  };
  const wings = (excluded: number[], count: number, pairs: boolean) => {
    const available = ranks.filter((r) => !excluded.includes(r));
    if (pairs)
      return available
        .filter((r) => get(r, 2).length === 2)
        .slice(0, count)
        .flatMap((r) => get(r, 2));
    return available.flatMap((r) => get(r, 2)).slice(0, count);
  };
  for (const rank of ranks) {
    const group = groups.get(rank)!;
    for (let size = 1; size <= group.length; size++) add(group.slice(0, size));
    if (group.length >= 3 && rank <= 15) {
      for (const other of ranks.filter((r) => r !== rank)) {
        add([...get(rank, 3), ...get(other, 1)]);
        if (get(other, 2).length === 2) add([...get(rank, 3), ...get(other, 2)]);
      }
    }
    if (group.length >= 4 && rank <= 15) {
      const singles = wings([rank], 2, false);
      const pairs = wings([rank], 2, true);
      if (singles.length === 2) add([...get(rank, 4), ...singles]);
      if (pairs.length === 4) add([...get(rank, 4), ...pairs]);
    }
  }
  for (const order of profile === 'four-jiangsu' ? ['normal', 'low'] : ['normal']) {
    const sequenceGet = (rank: number, copies: number) =>
      get(order === 'low' && rank <= 2 ? (rank === 1 ? 14 : 15) : rank, copies);
    for (const copies of [1, 2, 3]) {
      const minimum = copies === 1 ? 5 : copies === 2 ? 3 : 2;
      for (let start = order === 'low' ? 1 : 3; start <= (order === 'low' ? 13 : 14); start++) {
        for (let end = start; end <= (order === 'low' ? 13 : 14); end++) {
          if (sequenceGet(end, copies).length < copies) break;
          const length = end - start + 1;
          if (length < minimum) continue;
          const coreRanks = Array.from({ length }, (_, i) => start + i).map((r) =>
            order === 'low' && r <= 2 ? (r === 1 ? 14 : 15) : r,
          );
          const core = coreRanks.flatMap((r) => get(r, copies));
          add(core);
          if (copies === 3) {
            const singles = wings(coreRanks, length, false);
            const pairs = wings(coreRanks, length, true);
            if (singles.length === length) add([...core, ...singles]);
            if (pairs.length === length * 2) add([...core, ...pairs]);
            if (profile === 'four-jiangsu' && length === 2) {
              for (let wing = order === 'low' ? 1 : 3; wing < (order === 'low' ? 13 : 14); wing++) {
                const first = order === 'low' && wing <= 2 ? (wing === 1 ? 14 : 15) : wing;
                const second =
                  order === 'low' && wing + 1 <= 2 ? (wing + 1 === 1 ? 14 : 15) : wing + 1;
                if (
                  !coreRanks.includes(first) &&
                  !coreRanks.includes(second) &&
                  get(first, 2).length === 2 &&
                  get(second, 2).length === 2
                )
                  add([...core, ...get(first, 2), ...get(second, 2)]);
              }
            }
          }
        }
      }
    }
  }
  add([...get(16, mode === 'four' ? 2 : 1), ...get(17, mode === 'four' ? 2 : 1)]);
  const cost = (c: Combo) => (c.type === 'rocket' ? 2 : c.type === 'bomb' ? 1 : 0);
  candidates.sort(
    (a, b) =>
      cost(a.combo) - cost(b.combo) ||
      (previous ? a.combo.size - b.combo.size : b.combo.size - a.combo.size) ||
      a.combo.rank - b.combo.rank,
  );
  return candidates[0]?.cards.map((c) => c.id) ?? [];
}
