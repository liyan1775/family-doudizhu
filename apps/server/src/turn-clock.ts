import type { GameState } from '../../../packages/game/src/index.js';

/** One server-owned deadline per playing turn; reconnects retain the remaining time. */
export class TurnClock {
  deadline: number | null = null;
  private key: string | null = null;
  private remaining: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;

  constructor(
    private duration: number,
    private expire: () => void,
  ) {
    this.remaining = duration;
  }

  sync(game: GameState): void {
    const key = game.phase === 'playing' && game.turnId ? `${game.round}:${game.turnId}` : null;
    if (key !== this.key) {
      this.stop();
      this.key = key;
      this.remaining = this.duration;
    }
    if (!key) return;
    if (game.players.some((player) => !player.online)) {
      if (this.deadline !== null) this.remaining = Math.max(0, this.deadline - Date.now());
      this.stop();
      return;
    }
    if (this.deadline !== null) return;
    this.deadline = Date.now() + this.remaining;
    const generation = this.generation;
    this.timer = setTimeout(() => {
      if (generation !== this.generation) return;
      this.stop();
      this.key = null;
      this.expire();
    }, this.remaining);
    this.timer.unref();
  }

  stop(): void {
    clearTimeout(this.timer);
    this.generation++;
    this.deadline = null;
  }
}
