import { MUSIC_URL } from './audio-catalog.js';

export interface MusicStatus {
  enabled: boolean;
  playing: boolean;
  error: boolean;
  volume: number;
}

export class MusicPlayer {
  private audio = new Audio();
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private generation = 0;
  private speaking = false;
  private active = true;
  private disposed = false;
  private playing = false;
  private error = false;
  // 多部手机围桌时，配乐默认关闭；开启后记住这部手机的偏好。
  enabled = localStorage.getItem('family-music') === 'on';
  volume = Number(localStorage.getItem('family-music-volume') ?? 25);
  onStatus: (status: MusicStatus) => void = () => {};

  constructor() {
    if (!Number.isFinite(this.volume)) this.volume = 25;
    this.volume = Math.min(60, Math.max(0, this.volume));
    this.audio.preload = 'none';
    this.audio.loop = true;
    this.audio.src = MUSIC_URL;
    this.audio.onerror = () => {
      if (this.enabled && this.active && !this.disposed) this.failed();
    };
  }
  get status(): MusicStatus {
    return { enabled: this.enabled, playing: this.playing, error: this.error, volume: this.volume };
  }
  private publish(): void {
    this.onStatus(this.status);
  }
  // 在点击中创建/恢复 Web Audio；GainNode 可控制 iPhone 的音乐音量。
  private unlockGain(): void {
    if (!this.context) {
      try {
        const AudioContextClass =
          window.AudioContext ??
          (window as typeof window & { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        if (!AudioContextClass) return;
        this.context = new AudioContextClass();
        this.gain = this.context.createGain();
        this.context.createMediaElementSource(this.audio).connect(this.gain);
        this.gain.connect(this.context.destination);
        this.context.onstatechange = () => {
          this.playing =
            this.context?.state === 'running' && !this.audio.paused && this.active && this.enabled;
          this.publish();
        };
      } catch {
        this.gain = null;
        void this.context?.close().catch(() => {});
        this.context = null;
      }
    }
    const generation = this.generation;
    void this.context?.resume().catch(() => {
      if (generation === this.generation && this.enabled) this.failed();
    });
  }
  start(): void {
    if (this.disposed) return;
    this.enabled = true;
    this.active = true;
    this.error = false;
    localStorage.setItem('family-music', 'on');
    this.generation++;
    this.unlockGain();
    this.applyVolume();
    this.resume();
  }
  stop(): void {
    this.enabled = false;
    localStorage.setItem('family-music', 'off');
    this.generation++;
    this.audio.pause();
    this.playing = false;
    this.error = false;
    this.publish();
  }
  setVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    this.volume = Math.min(60, Math.max(0, volume));
    localStorage.setItem('family-music-volume', String(this.volume));
    this.applyVolume();
    this.publish();
  }
  duck(speaking: boolean): void {
    this.speaking = speaking;
    this.applyVolume();
    if (!this.gain && this.enabled && this.active) {
      // 缺少 Web Audio 时，播报期间暂停音乐，仍让报牌清楚。
      if (speaking) {
        this.generation++;
        this.audio.pause();
        this.playing = false;
        this.publish();
      } else this.resume();
    }
  }
  setActive(active: boolean): void {
    this.active = active;
    this.generation++;
    if (!active) {
      this.audio.pause();
      this.playing = false;
      this.publish();
    } else if (this.enabled) this.resume();
  }
  private applyVolume(): void {
    const level = (this.volume / 100) * (this.speaking ? 0.18 : 1);
    if (this.gain && this.context) {
      this.gain.gain.setTargetAtTime(level, this.context.currentTime, 0.07);
    } else this.audio.volume = this.volume / 100;
  }
  private resume(): void {
    if (!this.enabled || !this.active || this.disposed || (this.speaking && !this.gain)) return;
    const generation = this.generation;
    this.audio
      .play()
      .then(() => {
        if (generation !== this.generation || this.disposed || this.error) return;
        this.playing = !this.context || this.context.state === 'running';
        this.publish();
      })
      .catch(() => {
        if (generation === this.generation && !this.disposed) this.failed();
      });
  }
  private failed(): void {
    this.audio.pause();
    this.playing = false;
    this.error = true;
    this.publish();
  }
  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.audio.pause();
    this.audio.onerror = null;
    if (this.context) {
      this.context.onstatechange = null;
      void this.context.close().catch(() => {});
    }
    this.onStatus = () => {};
  }
}
