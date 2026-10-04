import { AUDIO_BASE, MUSIC_URL } from './audio-catalog.js';

export interface AudioLoadStatus {
  phase: 'idle' | 'loading' | 'ready' | 'partial';
  loaded: number;
  total: number;
  failed: number;
}

// 只预取本站素材。加载不参与入座和准备判断，失败后仍可继续游戏。
export class AudioLoader {
  private wanted = new Set<string>();
  private loaded = new Map<string, string>();
  private failed = new Set<string>();
  private pending: string[] = [];
  private active = new Map<string, AbortController>();
  private disposed = false;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  onStatus: (status: AudioLoadStatus) => void = () => {};

  constructor(
    private timeoutMs = 5000,
    private concurrency = 6,
    private budgetMs = 8000,
  ) {}
  get status(): AudioLoadStatus {
    return {
      phase: !this.wanted.size
        ? 'idle'
        : this.pending.length || this.active.size
          ? 'loading'
          : this.failed.size
            ? 'partial'
            : 'ready',
      loaded: this.loaded.size,
      total: this.wanted.size,
      failed: this.failed.size,
    };
  }
  source(url: string): string {
    return this.loaded.get(url) ?? url;
  }
  prepare(urls: string[], retry = false): void {
    if (this.disposed) return;
    for (const url of urls) {
      if (!url.startsWith(`${AUDIO_BASE}/`) && url !== MUSIC_URL) continue;
      this.wanted.add(url);
      if (retry) this.failed.delete(url);
      if (
        !this.loaded.has(url) &&
        !this.failed.has(url) &&
        !this.active.has(url) &&
        !this.pending.includes(url)
      )
        this.pending.push(url);
    }
    this.pump();
  }
  private pump(): void {
    if (!this.deadline && this.pending.length) {
      this.deadline = setTimeout(() => {
        this.pending.forEach((url) => this.failed.add(url));
        this.pending = [];
        this.active.forEach((controller) => controller.abort());
      }, this.budgetMs);
    }
    while (!this.disposed && this.active.size < this.concurrency && this.pending.length) {
      const url = this.pending.shift()!;
      const controller = new AbortController();
      this.active.set(url, controller);
      void this.fetchClip(url, controller);
    }
    if (!this.active.size && !this.pending.length) {
      clearTimeout(this.deadline);
      this.deadline = undefined;
    }
    if (!this.disposed) this.onStatus(this.status);
  }
  private async fetchClip(url: string, controller: AbortController): Promise<void> {
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: 'force-cache' });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('audio/'))
        throw new Error('声音素材未就绪');
      const blob = await response.blob();
      if (blob.size < 128) throw new Error('声音素材为空');
      if (!this.disposed) this.loaded.set(url, URL.createObjectURL(blob));
    } catch {
      if (!this.disposed) this.failed.add(url);
    } finally {
      clearTimeout(timer);
      this.active.delete(url);
      this.pump();
    }
  }
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.deadline);
    this.pending = [];
    this.active.forEach((controller) => controller.abort());
    this.loaded.forEach((url) => URL.revokeObjectURL(url));
    this.loaded.clear();
  }
}
