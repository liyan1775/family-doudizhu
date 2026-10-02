export interface VoiceStatus {
  enabled: boolean;
  unlocked: boolean;
  error: boolean;
}

export class VoicePlayer {
  private audio = new Audio();
  private queue: string[] = [];
  private busy = false;
  private generation = 0;
  enabled = localStorage.getItem('family-voice') !== 'off';
  unlocked = false;
  onStatus: (status: VoiceStatus) => void = () => {};

  constructor() {
    this.audio.preload = 'auto';
    this.audio.onended = () => {
      this.busy = false;
      this.next();
    };
    this.audio.onerror = () => this.failed();
  }
  private publish(error = false) {
    this.onStatus({ enabled: this.enabled, unlocked: this.unlocked, error });
  }
  // 必须由用户点击直接调用，使用同一个音频元素保留播放许可。
  unlock(): void {
    this.enabled = true;
    localStorage.setItem('family-voice', 'on');
    this.queue = [];
    this.generation++;
    const generation = this.generation;
    this.audio.pause();
    this.audio.src = '/audio/test.wav';
    this.busy = true;
    this.audio
      .play()
      .then(() => {
        if (generation !== this.generation) return;
        this.unlocked = true;
        this.publish();
      })
      .catch(() => {
        if (generation === this.generation) this.failed();
      });
  }
  mute(): void {
    this.enabled = false;
    localStorage.setItem('family-voice', 'off');
    this.generation++;
    this.queue = [];
    this.audio.pause();
    this.busy = false;
    this.publish();
  }
  play(clips: string[]): void {
    if (!this.enabled || !this.unlocked) return;
    // 网络恢复后优先播报新消息，不累积过时牌局。
    this.queue = [...this.queue.slice(-2), ...clips];
    this.next();
  }
  private next(): void {
    if (this.busy || !this.enabled || !this.queue.length) return;
    const clip = this.queue.shift()!;
    if (!/^[a-z0-9-]+$/.test(clip)) return;
    this.busy = true;
    this.audio.src = `/audio/${clip}.wav`;
    const generation = this.generation;
    this.audio.play().catch(() => {
      if (generation === this.generation) this.failed();
    });
  }
  private failed(): void {
    this.busy = false;
    this.queue = [];
    this.unlocked = false;
    this.publish(true);
  }
  dispose(): void {
    this.generation++;
    this.audio.pause();
    this.queue = [];
    this.audio.onended = null;
    this.audio.onerror = null;
  }
}
