import { TURN_CUE_URL } from './audio-catalog.js';

/** A local, disposable cue; never sits behind the speech queue. */
export class TurnCue {
  private context: AudioContext | null = null;
  private oscillator: OscillatorNode | null = null;
  private gain: GainNode | null = null;
  private fallback: HTMLAudioElement | null = null;
  private generation = 0;
  private permissionAttempt = 0;
  private disposed = false;
  unlocked = false;
  onError: (error: boolean) => void = () => {};
  onPlaying: (playing: boolean) => void = () => {};

  // Called synchronously inside the same click that unlocks ordinary speech.
  unlock(): void {
    if (this.disposed) return;
    this.clear();
    const permissionAttempt = ++this.permissionAttempt;
    const playbackGeneration = this.generation;
    if (!this.context && !this.fallback) {
      const Context =
        window.AudioContext ??
        (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      try {
        if (Context) this.context = new Context();
      } catch {
        /* Use the bundled short sound when Web Audio is unavailable. */
      }
      if (!this.context) {
        this.fallback = new Audio(TURN_CUE_URL);
        this.fallback.preload = 'auto';
      }
    }
    const ready = () => {
      if (permissionAttempt !== this.permissionAttempt || this.disposed) return;
      if (this.fallback && playbackGeneration !== this.generation) {
        this.fallback.pause();
        this.onPlaying(false);
      }
      this.unlocked = true;
      this.onError(false);
    };
    const failed = () => {
      if (
        permissionAttempt !== this.permissionAttempt ||
        this.disposed ||
        playbackGeneration !== this.generation
      )
        return;
      this.unlocked = false;
      this.onError(true);
    };
    if (this.context) {
      void this.context.resume().then(ready).catch(failed);
    } else if (this.fallback) {
      // A real click authorizes this separate element on older mobile engines.
      this.fallback.onended = () => this.onPlaying(false);
      this.fallback.onerror = failed;
      this.onPlaying(true);
      void this.fallback.play().then(ready).catch(failed);
    }
  }

  play(allowed = true): void {
    this.clear();
    if (!allowed || !this.unlocked || this.disposed) return;
    const generation = this.generation;
    const finished = () => {
      if (generation !== this.generation || this.disposed) return;
      this.onPlaying(false);
    };
    const failed = () => {
      if (generation !== this.generation || this.disposed) return;
      this.unlocked = false;
      this.onPlaying(false);
      this.onError(true);
    };
    if (this.context) {
      // Do not resume asynchronously here: a late resume must not ring for an old turn.
      if (this.context.state !== 'running') {
        failed();
        return;
      }
      try {
        const now = this.context.currentTime;
        this.oscillator = this.context.createOscillator();
        this.gain = this.context.createGain();
        this.oscillator.type = 'sine';
        this.oscillator.frequency.value = 880;
        this.gain.gain.setValueAtTime(0.0001, now);
        this.gain.gain.exponentialRampToValueAtTime(0.13, now + 0.015);
        this.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
        this.oscillator.connect(this.gain);
        this.gain.connect(this.context.destination);
        this.oscillator.onended = finished;
        this.onPlaying(true);
        this.oscillator.start();
        this.oscillator.stop(now + 0.22);
      } catch {
        failed();
      }
    } else if (this.fallback) {
      this.fallback.currentTime = 0;
      this.fallback.onended = finished;
      this.fallback.onerror = failed;
      this.onPlaying(true);
      void this.fallback.play().catch(failed);
    }
  }

  clear(): void {
    this.generation++;
    if (this.oscillator) {
      this.oscillator.onended = null;
      try {
        this.oscillator.stop();
      } catch {
        /* Already stopped. */
      }
      this.oscillator.disconnect();
      this.oscillator = null;
    }
    this.gain?.disconnect();
    this.gain = null;
    if (this.fallback) {
      this.fallback.pause();
      this.fallback.onended = null;
      this.fallback.onerror = null;
    }
    this.onPlaying(false);
  }

  dispose(): void {
    this.clear();
    this.disposed = true;
    this.permissionAttempt++;
    this.unlocked = false;
    if (this.context) void this.context.close().catch(() => {});
    this.onError = () => {};
    this.onPlaying = () => {};
  }
}
