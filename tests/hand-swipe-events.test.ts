import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { bindHandSwipe } from '../apps/web/src/use-hand-swipe.js';

// 用实际事件监听器重现触摸／指针事件、取消和迟到click；几何仅用固定牌角替身。
class Surface extends EventTarget {
  constructor(
    readonly id = '',
    readonly offsetLeft = 0,
  ) {
    super();
  }
  offsetTop = 8;
  offsetWidth = 50;
  offsetHeight = 50;
  clientHeight = 60;
  scrollHeight = 60;
  scrollTop = 0;
  bounds = { left: 0, top: 0, width: 250, height: 60 };
  cards: Surface[] = [];
  captured = false;
  implicitOwner: Surface | null = null;
  get dataset() {
    return { cardId: this.id };
  }
  closest() {
    return this.id ? this : null;
  }
  contains(card: Surface) {
    return this.cards.includes(card);
  }
  getAttribute() {
    return this.id;
  }
  querySelectorAll() {
    return this.cards;
  }
  getBoundingClientRect() {
    return this.bounds;
  }
  hasPointerCapture() {
    return this.captured;
  }
  setPointerCapture(id: number) {
    this.captured = true;
    if (this.implicitOwner) {
      const previous = this.implicitOwner;
      this.implicitOwner = null;
      emit(this, 'lostpointercapture', { pointerId: id }, previous);
    }
  }
  releasePointerCapture(id: number) {
    this.captured = false;
    emit(this, 'lostpointercapture', { pointerId: id });
  }
}

function emit(target: EventTarget, type: string, fields: object = {}, origin = target) {
  const event = new Event(type, { cancelable: true, bubbles: true });
  Object.assign(event, fields);
  Object.defineProperty(event, 'target', { value: origin });
  target.dispatchEvent(event);
  return event;
}

function fixture(t: TestContext, initial: string[] = []) {
  const win = Object.assign(new EventTarget(), {
    ontouchstart: null,
    portrait: false,
    matchMedia: () => ({ matches: win.portrait }),
  });
  const doc = Object.assign(new EventTarget(), { hidden: false });
  const previousGlobals: [string, PropertyDescriptor | undefined][] = [];
  for (const [key, value] of Object.entries({ window: win, document: doc, Element: Surface })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    previousGlobals.push([key, previous]);
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const hand = new Surface();
  hand.offsetWidth = 250;
  hand.offsetHeight = 60;
  hand.cards = ['7', '6', '5', '4', '3'].map((id, index) => new Surface(id, index * 50));
  const latest = {
    current: {
      selected: initial,
      compact: false,
      resetKey: 'turn1',
      onChange: (ids: string[]) => {
        latest.current.selected = ids;
      },
    },
  };
  const suppressed = { current: false };
  const bind = () => bindHandSwipe(hand as unknown as HTMLDivElement, latest, suppressed);
  let dispose = bind();
  t.after(() => {
    dispose();
    for (const [key, previous] of previousGlobals)
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
  });
  const point = (type: string, x: number, y = 25, origin?: Surface) =>
    emit(
      type === 'pointerdown' ? hand : win,
      type,
      { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, clientX: x, clientY: y },
      origin,
    );
  const touch = (type: string, x: number, y = 25, origin?: Surface) => {
    const finger = { identifier: 12, clientX: x, clientY: y };
    return emit(
      type === 'touchstart' ? hand : win,
      type,
      {
        touches: type === 'touchend' || type === 'touchcancel' ? [] : [finger],
        changedTouches: [finger],
      },
      origin,
    );
  };
  return {
    hand,
    win,
    doc,
    latest,
    suppressed,
    point,
    touch,
    click: (detail = 1) => emit(hand, 'click', { detail }),
    rebind() {
      dispose();
      dispose = bind();
    },
  };
}

test('指针捕获转交手牌区，旧按钮lost不取消滑选；滑后click拦截，新点按和键盘保留', (t) => {
  const f = fixture(t);
  f.hand.implicitOwner = f.hand.cards[4];
  f.point('pointerdown', 225, 25, f.hand.cards[4]);
  f.point('pointermove', 125);
  assert.deepEqual(f.latest.current.selected, ['5', '4', '3']);
  f.point('pointermove', 25);
  assert.deepEqual(f.latest.current.selected, ['7', '6', '5', '4', '3']);
  f.point('pointerup', 25);
  assert.equal(f.click().defaultPrevented, true);
  assert.equal(f.click(0).defaultPrevented, false);
  f.point('pointerdown', 25, 25, f.hand.cards[0]);
  f.point('pointerup', 25);
  assert.equal(f.click().defaultPrevented, false);
});

test('pointercancel或本人捕获丢失撤销预览，取消后迟到click不能再切换牌', (t) => {
  const f = fixture(t, ['7']);
  f.point('pointerdown', 225, 25, f.hand.cards[4]);
  f.point('pointermove', 125);
  assert.deepEqual(f.latest.current.selected, ['7', '5', '4', '3']);
  f.point('pointercancel', 125);
  assert.deepEqual(f.latest.current.selected, ['7']);
  assert.equal(f.click().defaultPrevented, true);
  f.point('pointerdown', 225, 25, f.hand.cards[4]);
  f.point('pointermove', 125);
  emit(f.hand, 'lostpointercapture', { pointerId: 1 });
  assert.deepEqual(f.latest.current.selected, ['7']);
});

test('上下起划保留滚动，已开始滑选遇到滚动、隐藏或第二根手指时撤销预览', (t) => {
  const f = fixture(t, ['7']);
  f.point('pointerdown', 225, 25, f.hand.cards[4]);
  f.point('pointermove', 225, 45);
  f.point('pointerup', 225, 45);
  assert.deepEqual(f.latest.current.selected, ['7']);
  for (const reason of ['scroll', 'visibilitychange', 'second-pointer']) {
    f.point('pointerdown', 225, 25, f.hand.cards[4]);
    f.point('pointermove', 125);
    if (reason === 'scroll') emit(f.hand, 'scroll');
    else if (reason === 'visibilitychange') {
      f.doc.hidden = true;
      emit(f.doc, reason);
    } else emit(f.hand, 'pointerdown', { pointerId: 2, isPrimary: false });
    assert.deepEqual(f.latest.current.selected, ['7']);
  }
});

test('换回合／重排时清理手势，后续move、up和迟到click不能写回旧选择', (t) => {
  const f = fixture(t);
  f.point('pointerdown', 225, 25, f.hand.cards[4]);
  f.point('pointermove', 125);
  f.latest.current.selected = [];
  f.latest.current.resetKey = 'turn2';
  f.rebind();
  f.point('pointermove', 25);
  f.point('pointerup', 25);
  assert.deepEqual(f.latest.current.selected, []);
  assert.equal(f.click().defaultPrevented, true);
});

test('只有Touch Events、没有指针捕获API的内核可以从3快速滑到7并回划缩小范围', (t) => {
  const f = fixture(t);
  for (const key of ['hasPointerCapture', 'setPointerCapture', 'releasePointerCapture'])
    Object.defineProperty(f.hand, key, { value: undefined });
  assert.equal(f.touch('touchstart', 225, 25, f.hand.cards[4]).defaultPrevented, true);
  assert.equal(f.touch('touchmove', 25).defaultPrevented, true);
  assert.deepEqual(f.latest.current.selected, ['7', '6', '5', '4', '3']);
  f.touch('touchmove', 125);
  assert.deepEqual(f.latest.current.selected, ['5', '4', '3']);
  assert.equal(f.touch('touchend', 125).defaultPrevented, true);
  assert.equal(f.click().defaultPrevented, true);
});

test('Touch与Pointer同时发出且Pointer被浏览器取消时，触摸滑选仍继续且不会重复处理', (t) => {
  const f = fixture(t);
  emit(
    f.hand,
    'pointerdown',
    {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 225,
      clientY: 25,
    },
    f.hand.cards[4],
  );
  f.touch('touchstart', 225, 25, f.hand.cards[4]);
  f.touch('touchmove', 125);
  f.point('pointermove', 25);
  assert.deepEqual(f.latest.current.selected, ['5', '4', '3']);
  f.point('pointercancel', 125);
  emit(f.hand, 'lostpointercapture', { pointerId: 1 });
  assert.deepEqual(f.latest.current.selected, ['5', '4', '3']);
  f.touch('touchend', 25);
  f.point('pointerup', 25);
  assert.deepEqual(f.latest.current.selected, ['7', '6', '5', '4', '3']);
  assert.equal(f.click().defaultPrevented, true);
});

test('旧内核无pointerType的起牌被触摸接管，轻点只切换一次，键盘和新鼠标点按仍可用', (t) => {
  const f = fixture(t);
  emit(
    f.hand,
    'pointerdown',
    {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 125,
      clientY: 25,
    },
    f.hand.cards[2],
  );
  f.touch('touchstart', 125, 25, f.hand.cards[2]);
  f.touch('touchend', 126, 26);
  assert.deepEqual(f.latest.current.selected, ['5']);
  assert.equal(f.click().defaultPrevented, true);
  f.touch('touchstart', 125, 25, f.hand.cards[2]);
  f.touch('touchend', 125);
  assert.deepEqual(f.latest.current.selected, []);
  assert.equal(f.click().defaultPrevented, true);
  assert.equal(f.click(0).defaultPrevented, false);
  f.point('pointerdown', 125, 25, f.hand.cards[2]);
  f.point('pointerup', 125);
  assert.equal(f.click().defaultPrevented, false);
});

test('自动旋转90度的触摸坐标与快划终点正确，已有选择可逆向取消', (t) => {
  const f = fixture(t, ['7']);
  f.win.portrait = true;
  f.latest.current.compact = true;
  f.hand.bounds = { left: 10, top: 20, width: 60, height: 250 };
  // 屏幕纵向对应牌行的横向；touchend也必须补算没有move的快划。
  f.touch('touchstart', 45, 245, f.hand.cards[4]);
  f.touch('touchend', 45, 45);
  assert.deepEqual(f.latest.current.selected, ['7', '6', '5', '4', '3']);
  f.touch('touchstart', 45, 45, f.hand.cards[0]);
  f.touch('touchend', 45, 245);
  assert.deepEqual(f.latest.current.selected, []);
});

test('从牌上纵向起划手动滚动，越界继续滚动并限制范围，滚动事件不打断也不选牌', (t) => {
  const f = fixture(t, ['7']);
  f.hand.scrollTop = 20;
  f.hand.scrollHeight = 180;
  f.touch('touchstart', 225, 25, f.hand.cards[4]);
  f.touch('touchmove', 225, 5);
  assert.equal(f.hand.scrollTop, 40);
  emit(f.hand, 'scroll');
  f.touch('touchmove', 225, -200);
  assert.equal(f.hand.scrollTop, 120);
  f.touch('touchmove', 225, 55);
  assert.equal(f.hand.scrollTop, 0);
  f.touch('touchend', 225, 55);
  assert.deepEqual(f.latest.current.selected, ['7']);
  assert.equal(f.click().defaultPrevented, true);
});

test('旋转牌桌横跨牌行时滚动方向正确，空隙起划交给原生滚动', (t) => {
  const f = fixture(t);
  f.win.portrait = true;
  f.latest.current.compact = true;
  f.hand.bounds = { left: 10, top: 20, width: 60, height: 250 };
  f.hand.scrollHeight = 180;
  assert.equal(f.touch('touchstart', 45, 245, f.hand).defaultPrevented, false);
  f.touch('touchend', 45, 245);
  assert.deepEqual(f.latest.current.selected, []);
  f.touch('touchstart', 45, 245, f.hand.cards[4]);
  f.touch('touchmove', 65, 245);
  assert.equal(f.hand.scrollTop, 20);
  emit(f.hand, 'scroll');
  f.touch('touchend', 65, 245);
  assert.deepEqual(f.latest.current.selected, []);
});

test('触摸取消、第二根手指（包括牌区外）、隐藏和尺寸变化均撤销预览并拦截迟到click', (t) => {
  const f = fixture(t, ['7']);
  for (const reason of [
    'touchcancel',
    'second-touch',
    'outside-touch',
    'visibilitychange',
    'resize',
    'blur',
    'scroll',
  ]) {
    f.doc.hidden = false;
    f.touch('touchstart', 225, 25, f.hand.cards[4]);
    f.touch('touchmove', 125);
    assert.deepEqual(f.latest.current.selected, ['7', '5', '4', '3']);
    if (reason === 'touchcancel') f.touch(reason, 125);
    else if (reason === 'second-touch' || reason === 'outside-touch') {
      const fields = {
        touches: [{ identifier: 12 }, { identifier: 13 }],
        changedTouches: [{ identifier: 13 }],
      };
      emit(reason === 'second-touch' ? f.hand : f.win, 'touchstart', fields);
    } else if (reason === 'visibilitychange') {
      f.doc.hidden = true;
      emit(f.doc, reason);
    } else emit(reason === 'scroll' ? f.hand : f.win, reason);
    assert.deepEqual(f.latest.current.selected, ['7']);
    f.touch('touchend', 25);
    assert.deepEqual(f.latest.current.selected, ['7']);
    assert.equal(f.click().defaultPrevented, true);
  }
});

test('触摸滑选中换轮或重排不会写回旧回合，迟到触摸和click均被丢弃', (t) => {
  const f = fixture(t, ['7']);
  f.touch('touchstart', 225, 25, f.hand.cards[4]);
  f.touch('touchmove', 125);
  f.latest.current.selected = [];
  f.latest.current.resetKey = 'turn2';
  f.rebind();
  f.touch('touchmove', 25);
  f.touch('touchend', 25);
  assert.deepEqual(f.latest.current.selected, []);
  assert.equal(f.click().defaultPrevented, true);
  f.touch('touchstart', 25, 25, f.hand.cards[0]);
  f.touch('touchend', 25);
  assert.deepEqual(f.latest.current.selected, ['7']);
});
