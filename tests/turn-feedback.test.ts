import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { RoomFeedback, isActionTurn } from '../apps/web/src/room-feedback.js';
import { TurnCue } from '../apps/web/src/turn-cue.js';
import { TURN_CUE_URL } from '../apps/web/src/audio-catalog.js';
import { createGame, addPlayer } from '../packages/game/src/index.js';
import type { RoomView } from '../packages/game/src/index.js';

function view(id: number, change: Partial<RoomView> = {}): RoomView {
  const game = createGame('three');
  for (let i = 0; i < 3; i++) addPlayer(game, `p${i}`, `家人${i}`);
  return {
    ...game,
    roomId: '123456',
    hostId: 'p0',
    youId: 'p0',
    hand: [],
    players: game.players.map((p) => ({ ...p, cardCount: 17 })),
    bombLimits: {},
    phase: 'playing',
    round: 1,
    landlordId: 'p1',
    turnId: 'p1',
    event: { id, kind: 'info', text: '牌局消息', audio: [] },
    ...change,
  };
}
const silent = { announce: false, reveal: false, cue: false };

test('首次入座、刷新重连和后台返回只建基线，重复及过期消息不会重复提醒', () => {
  const feedback = new RoomFeedback();
  const own = view(1, { turnId: 'p0' });
  assert.deepEqual(feedback.observe(own), silent);
  assert.deepEqual(feedback.observe(own), silent);
  assert.deepEqual(feedback.observe(view(2)), { announce: true, reveal: false, cue: false });
  assert.deepEqual(feedback.observe(view(3, { turnId: 'p0' })), {
    announce: true,
    reveal: false,
    cue: true,
  });
  assert.deepEqual(feedback.observe(view(2)), silent);
  assert.deepEqual(feedback.observe(view(3, { turnId: 'p0' })), silent);
  feedback.suspend();
  assert.deepEqual(feedback.observe(view(9, { turnId: 'p0' })), silent);
  assert.deepEqual(feedback.observe(view(10), false), silent);
  assert.deepEqual(feedback.observe(view(11, { turnId: 'p0' }), false), silent);
  feedback.suspend();
  assert.deepEqual(feedback.observe(view(11, { turnId: 'p0' })), silent);
});

test('叫分结束后先展示地主身份，同一人继续先手也能识别；他人手机不响本人提示', () => {
  const feedback = new RoomFeedback();
  feedback.observe(view(1, { phase: 'bidding', turnId: 'p0', landlordId: null }));
  assert.deepEqual(feedback.observe(view(2, { turnId: 'p0', landlordId: 'p0' })), {
    announce: true,
    reveal: true,
    cue: false,
  });
  assert.deepEqual(feedback.observe(view(2, { turnId: 'p0', landlordId: 'p0' })), silent);
  assert.equal(isActionTurn(view(2, { turnId: 'p0' })), true);
  assert.equal(isActionTurn(view(2, { turnId: 'p0', youId: 'p2' })), false);
  assert.equal(isActionTurn(view(2, { phase: 'finished', turnId: 'p0' })), false);
  assert.deepEqual(feedback.observe(view(3, { roomId: '654321', turnId: 'p0' })), silent);
});

test('有人离线时暂停本人行动和提示，回到同一桌后新轮次只提醒一次', () => {
  const feedback = new RoomFeedback();
  const offline = view(2, { turnId: 'p0' });
  offline.players[1].online = false;
  feedback.observe(view(1));
  assert.equal(isActionTurn(offline), false);
  assert.equal(feedback.observe(offline).cue, false);
  assert.equal(feedback.observe(view(3, { turnId: 'p0' })).cue, true);
  assert.equal(feedback.observe(view(3, { turnId: 'p0' })).cue, false);
});

class CueOscillator {
  type = '';
  frequency = { value: 0 };
  onended: (() => void) | null = null;
  starts = 0;
  stops: (number | undefined)[] = [];
  disconnected = false;
  connect() {}
  start() {
    this.starts++;
  }
  stop(time?: number) {
    this.stops.push(time);
  }
  disconnect() {
    this.disconnected = true;
  }
}
class CueContext {
  static all: CueContext[] = [];
  state = 'running';
  currentTime = 10;
  destination = {};
  oscillators: CueOscillator[] = [];
  resumeResult = () => Promise.resolve();
  constructor() {
    CueContext.all.push(this);
  }
  resume() {
    return this.resumeResult();
  }
  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
  createOscillator() {
    const o = new CueOscillator();
    this.oscillators.push(o);
    return o;
  }
  createGain() {
    return {
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {},
      disconnect() {},
    };
  }
}
class CueAudio {
  static all: CueAudio[] = [];
  preload = '';
  currentTime = 0;
  paused = true;
  plays = 0;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  result = () => Promise.resolve();
  constructor(public src: string) {
    CueAudio.all.push(this);
  }
  play() {
    this.plays++;
    this.paused = false;
    return this.result();
  }
  pause() {
    this.paused = true;
  }
}
function cueEnvironment(t: TestContext, webAudio = true) {
  CueContext.all = [];
  CueAudio.all = [];
  for (const [key, value] of Object.entries({
    window: { AudioContext: webAudio ? CueContext : undefined },
    Audio: CueAudio,
  })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => {
      if (old) Object.defineProperty(globalThis, key, old);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('短提示音独立于语音队列，220毫秒结束；关闭、换轮和离开立即停止', async (t) => {
  cueEnvironment(t);
  const cue = new TurnCue();
  t.after(() => cue.dispose());
  cue.unlock();
  await flush();
  const context = CueContext.all[0];
  cue.play();
  const oscillator = context.oscillators[0];
  assert.equal(oscillator.frequency.value, 880);
  assert.equal(oscillator.starts, 1);
  assert.equal(oscillator.stops[0], 10.22);
  cue.clear();
  assert.equal(oscillator.disconnected, true);
  assert.equal(oscillator.onended, null);
  cue.play(false);
  assert.equal(context.oscillators.length, 1);
  context.state = 'suspended';
  let failed = false;
  cue.onError = (error) => {
    failed = error;
  };
  cue.play();
  assert.equal(failed, true);
  assert.equal(context.oscillators.length, 1);
});

test('迟到的播放授权只准备后续声音，不补播旧回合；销毁后不恢复授权', async (t) => {
  cueEnvironment(t);
  const cue = new TurnCue();
  t.after(() => cue.dispose());
  cue.unlock();
  await flush();
  const context = CueContext.all[0];
  let finish!: () => void;
  context.resumeResult = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  cue.unlocked = false;
  cue.unlock();
  cue.play();
  cue.clear();
  finish();
  await flush();
  assert.equal(cue.unlocked, true);
  assert.equal(context.oscillators.length, 0);
  cue.unlock();
  cue.dispose();
  finish();
  await flush();
  assert.equal(cue.unlocked, false);
});

test('无Web Audio时用项目内短音，重播从开头开始并可立即取消', async (t) => {
  cueEnvironment(t, false);
  const cue = new TurnCue();
  t.after(() => cue.dispose());
  cue.unlock();
  const audio = CueAudio.all[0];
  assert.equal(audio.src, TURN_CUE_URL);
  assert.equal(audio.plays, 1, '点击中同步取得独立音频元素的许可');
  await flush();
  audio.currentTime = 0.1;
  cue.play();
  assert.equal(audio.currentTime, 0);
  assert.equal(audio.plays, 2);
  cue.clear();
  assert.equal(audio.paused, true);
  assert.equal(audio.onended, null);
  let finish!: () => void;
  audio.result = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  cue.unlock();
  cue.clear();
  finish();
  await flush();
  assert.equal(audio.paused, true, '迟到的媒体许可不能补播已取消的短音');
});
