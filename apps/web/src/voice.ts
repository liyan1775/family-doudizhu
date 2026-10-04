import { AudioLoader, type AudioLoadStatus } from './audio-loader.js';
import {
  eventClips,
  PREVIEW_KEYS,
  seatVoice,
  SYSTEM_VOICE,
  VOICE_KEYS,
  VOICES,
  voiceUrl,
  type VoiceId,
} from './audio-catalog.js';
import type { GameEvent, Player } from '../../../packages/game/src/index.js';

export interface VoiceStatus {
  enabled: boolean;
  unlocked: boolean;
  error: boolean;
  loading: AudioLoadStatus;
}
interface Clip {
  key: string;
  voice: VoiceId;
  important?: boolean;
}

export class VoicePlayer {
  private audio = new Audio();
  private loader = new AudioLoader();
  private queue: Clip[] = [];
  private busy = false;
  private generation = 0;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private error = false;
  private voices = new Set<VoiceId>([SYSTEM_VOICE]);
  enabled = localStorage.getItem('family-voice') !== 'off';
  unlocked = false;
  onStatus: (status: VoiceStatus) => void = () => {};
  onSpeaking: (speaking: boolean) => void = () => {};

  constructor() {
    this.audio.preload = 'auto';
    this.loader.onStatus = () => this.publish();
  }
  get status(): VoiceStatus {
    return {
      enabled: this.enabled,
      unlocked: this.unlocked,
      error: this.error,
      loading: this.loader.status,
    };
  }
  private publish(error = this.error): void {
    this.error = error;
    this.onStatus(this.status);
  }
  prepareSamples(): void {
    if (!this.enabled) return;
    this.loader.prepare(
      VOICES.flatMap((voice) => PREVIEW_KEYS.map((clip) => voiceUrl(clip, voice.id)!)).concat(
        voiceUrl('test', SYSTEM_VOICE)!,
      ),
    );
  }
  prepare(seats: number[], retry = false): void {
    seats.forEach((seat) => this.voices.add(seatVoice(seat).id));
    if (this.enabled)
      this.loader.prepare(
        [...this.voices].flatMap((voice) => VOICE_KEYS.map((clip) => voiceUrl(clip, voice)!)),
        retry,
      );
  }
  // play() 必须在点击处理器内同步调用；预加载不能推迟浏览器的声音授权。
  unlock(voice: VoiceId = SYSTEM_VOICE, clips: string[] = ['test']): void {
    if (this.disposed) return;
    this.enabled = true;
    this.error = false;
    localStorage.setItem('family-voice', 'on');
    this.clear();
    const valid = clips.filter((clip) => voiceUrl(clip, voice));
    if (!valid.length) return;
    this.queue = valid.slice(1).map((key) => ({ key, voice }));
    this.start({ key: valid[0], voice }, true);
    this.loader.prepare(
      [...this.voices].flatMap((v) => VOICE_KEYS.map((clip) => voiceUrl(clip, v)!)),
      true,
    );
  }
  preview(seat: number): void {
    this.unlock(seatVoice(seat).id, PREVIEW_KEYS);
  }
  mute(): void {
    this.enabled = false;
    this.error = false;
    localStorage.setItem('family-voice', 'off');
    this.clear();
    this.publish();
  }
  playEvent(event: GameEvent, players: Pick<Player, 'id' | 'seat'>[], youId?: string): void {
    // 阶段已结束：移除尚未播出的旧阶段提示，尽快听到末次叫分和本人身份。
    if (event.kind === 'landlord' || event.kind === 'deal') this.queue = [];
    this.enqueue(eventClips(event, players, youId));
  }
  play(clips: string[], voice: VoiceId = SYSTEM_VOICE): void {
    this.enqueue(clips.map((key) => ({ key, voice })));
  }
  private enqueue(clips: Clip[]): void {
    if (!this.enabled || !this.unlocked || this.disposed) return;
    // 保留队列中的音色，后面的玩家出牌不会改变前一条播报。
    const recentOrdinary = this.queue.filter((clip) => !clip.important).slice(-2);
    this.queue = [
      ...this.queue.filter((clip) => clip.important || recentOrdinary.includes(clip)),
      ...clips.filter((clip) => voiceUrl(clip.key, clip.voice)),
    ];
    this.next();
  }
  clear(): void {
    this.generation++;
    this.queue = [];
    this.audio.pause();
    this.audio.onended = null;
    this.audio.onerror = null;
    clearTimeout(this.timer);
    this.busy = false;
    this.onSpeaking(false);
  }
  private next(): void {
    if (this.busy || !this.enabled || !this.unlocked || !this.queue.length) return;
    this.start(this.queue.shift()!);
  }
  private start(clip: Clip, unlocking = false, retrying = false): void {
    const url = voiceUrl(clip.key, clip.voice)!;
    const generation = this.generation;
    const attempt = ++this.attempt;
    const current = () =>
      generation === this.generation && attempt === this.attempt && !this.disposed;
    this.busy = true;
    this.onSpeaking(true);
    // 预取失败时直接重试当前音色，保留真人感；不回退到旧机械音。
    this.audio.src = retrying ? url : this.loader.source(url);
    const failed = (error?: unknown) => {
      if (!current()) return;
      clearTimeout(this.timer);
      this.audio.pause();
      if (!retrying && !(error instanceof Error && error.name === 'NotAllowedError'))
        this.start(clip, unlocking, true);
      else {
        this.clear();
        this.unlocked = false;
        this.publish(true);
      }
    };
    this.audio.onerror = () => failed();
    this.audio.onended = () => {
      if (!current()) return;
      clearTimeout(this.timer);
      this.busy = false;
      if (this.queue.length) this.next();
      else this.onSpeaking(false);
    };
    this.timer = setTimeout(() => failed(), 8000);
    this.audio
      .play()
      .then(() => {
        if (!current()) return;
        if (unlocking) this.unlocked = true;
        this.publish(false);
      })
      .catch(failed);
  }
  dispose(): void {
    this.clear();
    this.disposed = true;
    this.loader.dispose();
    this.onStatus = () => {};
    this.onSpeaking = () => {};
  }
}
