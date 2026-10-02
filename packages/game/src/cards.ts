import type { Card, Suit } from './types.js';

export const SUITS: Suit[] = ['spades', 'hearts', 'clubs', 'diamonds'];
export function createDeck(decks = 1): Card[] {
  const result: Card[] = [];
  for (let deck = 0; deck < decks; deck++) {
    for (const suit of SUITS) {
      for (let rank = 3; rank <= 15; rank++) {
        result.push({ id: `${deck}-${suit}-${rank}`, rank, suit });
      }
    }
    for (const rank of [16, 17]) result.push({ id: `${deck}-joker-${rank}`, rank, suit: 'joker' });
  }
  return result;
}
export function shuffle(
  cards: Card[],
  randomInt = (max: number) => Math.floor(Math.random() * max),
): Card[] {
  const result = [...cards];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
export function sortCards(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
}
export function rankLabel(rank: number): string {
  return (
    (
      { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王' } as Record<
        number,
        string
      >
    )[rank] ?? String(rank)
  );
}
