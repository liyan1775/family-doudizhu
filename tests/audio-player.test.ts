import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { AudioLoader } from '../apps/web/src/audio-loader.js';
import {
  eventVoice,
  eventClips,
  seatVoice,
  SYSTEM_VOICE,
  voiceUrl,
  VOICES,
} from '../apps/web/src/audio-catalog.js';
import { VoicePlayer } from '../apps/web/src/voice.js';
import { MusicPlayer } from '../apps/web/src/music.js';
import type { GameEvent } from '../packages/game/src/index.js';

class FakeAudio {
  static all: FakeAudio[] = [];
  src = '';
  paused = true;
  volume = 1;
  loop = false;
  preload = '';
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  plays: string[] = [];
  result: () => Promise<void> = () => Promise.resolve();
  constructor() {
    FakeAudio.all.push(this);
  }
  play() {
    this.plays.push(this.src);
    this.paused = false;
    return this.result();
  }
  pause() {
    this.paused = true;
  }
  end() {
    this.paused = true;
    this.onended?.();
  }
}
class FakeContext {
  static all: FakeContext[] = [];
  state = 'running';
  currentTime = 0;
  destination = {};
  onstatechange: (() => void) | null = null;
  gain = {
    gain: {
      value: 1,
      setTargetAtTime: (value: number) => {
        this.gain.gain.value = value;
      },
    },
    connect() {},
  };
  constructor() {
    FakeContext.all.push(this);
  }
  createGain() {
    return this.gain;
  }
  createMediaElementSource() {
    return { connect() {} };
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function environment(t: TestContext, values: Record<string, string> = {}, webAudio = true) {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const storage = new Map(Object.entries(values));
  const globals = {
    Audio: FakeAudio,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    window: { AudioContext: webAudio ? FakeContext : undefined },
  };
  FakeAudio.all = [];
  FakeContext.all = [];
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  t.after(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return storage;
}

test('按服务端座位和事件操作者选择音色，四座不同，流程提示固定女声', () => {
  const players = [
    { id: '奶奶', seat: 3 },
    { id: '爷爷', seat: 0 },
    { id: '爸爸', seat: 2 },
    { id: '妈妈', seat: 1 },
  ];
  assert.equal(new Set(VOICES.map((voice) => voice.id)).size, 4);
  for (const p of players) {
    const event: GameEvent = {
      id: 1,
      kind: 'play',
      text: '对三',
      audio: ['pair-3'],
      actorId: p.id,
    };
    assert.equal(eventVoice(event, players), seatVoice(p.seat).id);
    assert.equal(eventVoice(event, [...players].reverse()), seatVoice(p.seat).id);
  }
  assert.equal(
    eventVoice({ id: 2, kind: 'deal', text: '发牌', audio: ['deal'] }, players),
    SYSTEM_VOICE,
  );
  assert.equal(
    eventVoice(
      { id: 3, kind: 'landlord', text: '地主确定', audio: ['landlord'], actorId: '爷爷' },
      players,
    ),
    SYSTEM_VOICE,
  );
  assert.equal(voiceUrl('../token', SYSTEM_VOICE), null);
  assert.equal(voiceUrl('toString', SYSTEM_VOICE), null);
});

test('点击同步播放、队列保留各玩家音色，同一音频元素完成所有播报', async (t) => {
  environment(t);
  const voice = new VoicePlayer();
  t.after(() => voice.dispose());
  voice.unlock();
  const audio = FakeAudio.all[0];
  assert.equal(audio.plays.length, 1, '点击中同步调用play');
  await flush();
  audio.end();
  const players = [
    { id: '爷爷', seat: 0 },
    { id: '奶奶', seat: 1 },
  ];
  voice.playEvent(
    { id: 1, kind: 'play', text: '对三', audio: ['pair-3'], actorId: '爷爷' },
    players,
  );
  voice.playEvent(
    { id: 2, kind: 'play', text: '大王', audio: ['single-17'], actorId: '奶奶' },
    players,
  );
  voice.play(['bomb']);
  audio.end();
  audio.end();
  audio.end();
  assert.deepEqual(audio.plays.slice(1), [
    voiceUrl('pair-3', 'lively-male'),
    voiceUrl('single-17', 'warm-female'),
    voiceUrl('bomb', SYSTEM_VOICE),
  ]);
  assert.equal(FakeAudio.all.length, 1);
  voice.playEvent(
    {
      id: 3,
      kind: 'finish',
      text: '地主赢了',
      audio: ['single-17', 'spring', 'landlord-win'],
      actorId: '爷爷',
    },
    players,
  );
  audio.end();
  audio.end();
  audio.end();
  assert.deepEqual(audio.plays.slice(-3), [
    voiceUrl('single-17', 'lively-male'),
    voiceUrl('spring', SYSTEM_VOICE),
    voiceUrl('landlord-win', SYSTEM_VOICE),
  ]);
});

test('关闭声音后，迟到的播放授权不会重新打开或继续播报', async (t) => {
  const storage = environment(t);
  const voice = new VoicePlayer();
  t.after(() => voice.dispose());
  const audio = FakeAudio.all[0];
  let finish!: () => void;
  audio.result = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  voice.unlock();
  voice.mute();
  finish();
  await flush();
  assert.equal(voice.status.enabled, false);
  assert.equal(voice.status.unlocked, false);
  assert.equal(audio.paused, true);
  assert.equal(storage.get('family-voice'), 'off');
  voice.play(['bomb']);
  assert.equal(audio.plays.length, 1);
});

test('音频缺失只重试对应自然音色，提示恢复，预加载不会抹去错误', async (t) => {
  environment(t);
  const voice = new VoicePlayer();
  t.after(() => voice.dispose());
  const audio = FakeAudio.all[0];
  audio.result = () => Promise.reject(new Error('missing'));
  voice.preview(2);
  await flush();
  assert.equal(audio.plays.length, 2);
  assert.ok(audio.plays.every((url) => url.endsWith('/deep-male/pair-12.mp3')));
  assert.equal(voice.status.error, true);
  assert.equal(voice.status.unlocked, false);
  voice.prepare([0, 1, 2]);
  await flush();
  assert.equal(voice.status.error, true);
  audio.result = () => Promise.resolve();
  voice.unlock();
  await flush();
  assert.equal(voice.status.error, false);
  assert.equal(voice.status.unlocked, true);
});

test('自动播放被阻止不循环重试，刷新保留关闭偏好，清理时丢弃旧队列', async (t) => {
  environment(t, { 'family-voice': 'off' });
  const voice = new VoicePlayer();
  t.after(() => voice.dispose());
  voice.prepare([0, 1]);
  assert.equal(voice.status.loading.total, 0);
  const audio = FakeAudio.all[0];
  audio.result = () => Promise.reject(new DOMException('blocked', 'NotAllowedError'));
  voice.unlock();
  await flush();
  assert.equal(audio.plays.length, 1);
  audio.result = () => Promise.resolve();
  voice.unlock();
  await flush();
  audio.end();
  voice.play(['pair-3', 'single-17']);
  voice.clear();
  voice.play(['bomb']);
  audio.end();
  assert.ok(!audio.plays.some((url) => url.endsWith('single-17.mp3')));
  assert.ok(audio.plays.at(-1)?.endsWith('bomb.mp3'));
});

test('末次叫分保持操作者音色，随后每人听到自己的地主或农民身份', () => {
  const players = [
    { id: 'p0', seat: 0 },
    { id: 'p1', seat: 1 },
    { id: 'p2', seat: 2 },
  ];
  const event: GameEvent = {
    id: 8,
    kind: 'landlord',
    actorId: 'p0',
    text: '爷爷当地主',
    audio: ['no-bid', 'landlord'],
    announcements: [
      { kind: 'bid', actorId: 'p2', text: '爸爸不叫', audio: ['no-bid'] },
      { kind: 'landlord', actorId: 'p0', text: '爷爷当地主', audio: ['landlord'] },
    ],
  };
  assert.deepEqual(eventClips(event, players, 'p0'), [
    { key: 'no-bid', voice: 'deep-male', important: true },
    { key: 'own-landlord', voice: SYSTEM_VOICE, important: true },
  ]);
  assert.equal(eventClips(event, players, 'p2')[1].key, 'own-farmer');
});

test('连续出牌不会从待播队列挤掉三分和本人身份；关闭声音仍清空全部', async (t) => {
  environment(t);
  const voice = new VoicePlayer();
  t.after(() => voice.dispose());
  voice.unlock();
  await flush();
  const audio = FakeAudio.all[0];
  const players = [{ id: 'p0', seat: 0 }];
  voice.playEvent(
    { id: 8, kind: 'bid', actorId: 'p0', text: '一分', audio: ['bid-1'] },
    players,
    'p0',
  );
  voice.playEvent(
    {
      id: 9,
      kind: 'landlord',
      actorId: 'p0',
      text: '爷爷当地主',
      audio: ['bid-3', 'landlord'],
      announcements: [
        { kind: 'bid', actorId: 'p0', text: '爷爷叫三分', audio: ['bid-3'] },
        { kind: 'landlord', actorId: 'p0', text: '爷爷当地主', audio: ['landlord'] },
      ],
    },
    players,
    'p0',
  );
  for (let rank = 3; rank < 10; rank++) voice.play([`single-${rank}`]);
  audio.end();
  audio.end();
  assert.deepEqual(audio.plays.slice(1, 3), [
    voiceUrl('bid-3', 'lively-male'),
    voiceUrl('own-landlord', SYSTEM_VOICE),
  ]);
  assert.ok(!audio.plays.some((url) => url.endsWith('bid-1.mp3')), '地主确定后不积压旧叫分');
  voice.mute();
  audio.end();
  assert.equal(audio.plays.length, 3);
});

test('预取合并重复请求，复用Blob，销毁释放缓存', async (t) => {
  environment(t);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return new Response(new Uint8Array(256), { headers: { 'content-type': 'audio/mpeg' } });
  });
  const loader = new AudioLoader();
  t.after(() => loader.dispose());
  const url = voiceUrl('pair-3', SYSTEM_VOICE)!;
  loader.prepare([url, url]);
  loader.prepare([url]);
  await flush();
  assert.equal(requests, 1);
  assert.equal(loader.status.phase, 'ready');
  const blob = loader.source(url);
  assert.ok(blob.startsWith('blob:'));
  loader.prepare([url], true);
  await flush();
  assert.equal(requests, 1);
  const revoked: string[] = [];
  t.mock.method(URL, 'revokeObjectURL', (url: string) => {
    revoked.push(url);
  });
  loader.dispose();
  assert.deepEqual(revoked, [blob]);
});

test('慢网有并发上限和总时间预算，结束后可显式重试恢复', async (t) => {
  environment(t);
  let active = 0;
  let peak = 0;
  t.mock.method(
    globalThis,
    'fetch',
    (_url: unknown, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        active++;
        peak = Math.max(peak, active);
        options.signal!.addEventListener(
          'abort',
          () => {
            active--;
            reject(new DOMException('timeout', 'AbortError'));
          },
          { once: true },
        );
      }),
  );
  const loader = new AudioLoader(40, 2, 65);
  t.after(() => loader.dispose());
  const urls = ['pair-3', 'pair-4', 'pair-5', 'single-3', 'single-4', 'single-5'].map((clip) =>
    voiceUrl(clip, SYSTEM_VOICE)!,
  );
  const done = new Promise<void>((resolve) => {
    loader.onStatus = (status) => {
      if (status.phase === 'partial') resolve();
    };
  });
  loader.prepare(urls);
  await done;
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.equal(loader.status.failed, urls.length);
  assert.equal(loader.source(urls[0]), urls[0]);
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(new Uint8Array(256), { headers: { 'content-type': 'audio/mpeg' } }),
  );
  loader.prepare(urls, true);
  await flush();
  assert.equal(loader.status.phase, 'ready');
  assert.equal(loader.status.failed, 0);
});

test('失败预取不悄悄循环请求，HTML错误页不能当作声音缓存', async (t) => {
  environment(t);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return new Response('error'.repeat(60), { headers: { 'content-type': 'text/html' } });
  });
  const loader = new AudioLoader();
  t.after(() => loader.dispose());
  const url = voiceUrl('test', SYSTEM_VOICE)!;
  loader.prepare([url]);
  await flush();
  loader.prepare([url]);
  await flush();
  assert.equal(loader.status.phase, 'partial');
  assert.equal(requests, 1);
  assert.equal(loader.source(url), url);
});

test('报牌与配乐独立开关，GainNode让声后恢复用户音量', async (t) => {
  const storage = environment(t);
  const music = new MusicPlayer();
  const voice = new VoicePlayer();
  t.after(() => {
    voice.dispose();
    music.dispose();
  });
  voice.onSpeaking = (speaking) => music.duck(speaking);
  assert.equal(music.enabled, false);
  music.start();
  await flush();
  music.setVolume(40);
  const context = FakeContext.all[0];
  assert.equal(context.gain.gain.value, 0.4);
  voice.unlock();
  await flush();
  assert.ok(context.gain.gain.value < 0.1);
  FakeAudio.all[1].end();
  assert.equal(context.gain.gain.value, 0.4);
  voice.mute();
  assert.equal(music.status.playing, true);
  assert.equal(storage.get('family-music'), 'on');
  music.stop();
  assert.equal(voice.enabled, false);
});

test('配乐关闭或切到后台后，迟到的play结果不会恢复音乐', async (t) => {
  environment(t);
  const music = new MusicPlayer();
  t.after(() => music.dispose());
  const audio = FakeAudio.all[0];
  let finish!: () => void;
  audio.result = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  music.start();
  music.stop();
  finish();
  await flush();
  assert.equal(music.status.playing, false);
  assert.equal(audio.paused, true);
  audio.result = () => Promise.resolve();
  music.start();
  await flush();
  music.setActive(false);
  assert.equal(music.status.playing, false);
  assert.equal(music.enabled, true);
  music.setActive(true);
  await flush();
  assert.equal(music.status.playing, true);
  music.setActive(false);
  music.start();
  await flush();
  assert.equal(music.status.playing, true, '离开牌桌后仍可在首页点击试听配乐');
  music.stop();
  audio.onerror?.();
  assert.equal(music.status.error, false, '关闭后迟到的媒体错误不显示恢复提示');
});

test('缺少Web Audio时，播报期间暂停配乐，失败可单独恢复', async (t) => {
  environment(t, {}, false);
  const music = new MusicPlayer();
  t.after(() => music.dispose());
  const audio = FakeAudio.all[0];
  music.start();
  await flush();
  music.duck(true);
  assert.equal(audio.paused, true);
  music.duck(false);
  await flush();
  assert.equal(audio.paused, false);
  audio.result = () => Promise.reject(new DOMException('blocked', 'NotAllowedError'));
  music.start();
  await flush();
  assert.equal(music.status.error, true);
  audio.result = () => Promise.resolve();
  music.start();
  await flush();
  assert.equal(music.status.error, false);
});
