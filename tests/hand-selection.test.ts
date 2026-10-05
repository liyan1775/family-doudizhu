import test from 'node:test';
import assert from 'node:assert/strict';
import { cardAtPoint, handPoint, HandSwipe } from '../apps/web/src/hand-selection.js';

const ids = ['7', '6', '5', '4', '3'];

test('轻点和手指轻微抖动交给原有click，不提前选牌或重复切换', () => {
  const swipe = new HandSwipe(ids, [], '3', { x: 110, y: 20 });
  assert.equal(swipe.move({ x: 106, y: 22 }, '3'), null);
  assert.equal(swipe.status, 'pending');
});

test('快速从3划到7，未收到中间牌的move也完整选中五张', () => {
  const swipe = new HandSwipe(ids, [], '3', { x: 110, y: 20 });
  assert.deepEqual(swipe.move({ x: 10, y: 20 }, '7'), ids);
  assert.equal(swipe.status, 'selecting');
  // 同一终点重复事件保持选择，不会像逐次toggle那样翻转。
  assert.deepEqual(swipe.move({ x: 10, y: 20 }, '7'), ids);
});

test('向两边选牌及回划缩短范围，保留手势开始前范围外的选择', () => {
  const swipe = new HandSwipe(ids, ['7'], '5', { x: 60, y: 20 });
  assert.deepEqual(swipe.move({ x: 110, y: 20 }, '3'), ['7', '5', '4', '3']);
  assert.deepEqual(swipe.move({ x: 85, y: 20 }, '4'), ['7', '5', '4']);
  assert.deepEqual(swipe.move({ x: 35, y: 20 }, '6'), ['7', '6', '5']);
  assert.deepEqual(swipe.move({ x: 60, y: 20 }, '5'), ['7', '5']);
});

test('从已选牌起划统一取消，回划还原缩出范围的牌', () => {
  const swipe = new HandSwipe(ids, ['7', '5', '4', '3'], '3', { x: 110, y: 20 });
  assert.deepEqual(swipe.move({ x: 10, y: 20 }, '7'), []);
  assert.deepEqual(swipe.move({ x: 85, y: 20 }, '4'), ['7', '5']);
  assert.deepEqual(swipe.initial, ['7', '5', '4', '3']);
});

test('沿手牌上下滚动不选牌，滚动意图确定后转向也不变成滑选', () => {
  const swipe = new HandSwipe(ids, ['7'], '3', { x: 110, y: 20 });
  assert.equal(swipe.move({ x: 111, y: 34 }, '3'), null);
  assert.equal(swipe.status, 'scrolling');
  assert.equal(swipe.move({ x: 10, y: 34 }, '7'), null);
  assert.deepEqual(swipe.initial, ['7']);
});

test('先沿行滑动再跨到第二行，选择手牌顺序中的连续范围，移出区域不改动选择', () => {
  const swipe = new HandSwipe(['a', 'b', 'c', 'd', 'e', 'f'], [], 'b', { x: 35, y: 20 });
  assert.deepEqual(swipe.move({ x: 60, y: 20 }, 'c'), ['b', 'c']);
  assert.deepEqual(swipe.move({ x: 35, y: 70 }, 'e'), ['b', 'c', 'd', 'e']);
  assert.equal(swipe.move({ x: 200, y: 70 }, null), null);
});

test('普通横屏、竖屏旋转及内部滚动使用同一手牌坐标，区域外不会命中', () => {
  const normal = handPoint(
    { x: 150, y: 240 },
    { left: 100, top: 200, width: 300, height: 100 },
    { width: 300, height: 100 },
    false,
    15,
  );
  const rotated = handPoint(
    { x: 160, y: 250 },
    { left: 100, top: 200, width: 100, height: 300 },
    { width: 300, height: 100 },
    true,
    15,
  );
  assert.deepEqual(normal, { x: 50, y: 55 });
  assert.deepEqual(rotated, normal);
  assert.equal(
    handPoint(
      { x: 99, y: 240 },
      { left: 100, top: 200, width: 100, height: 300 },
      { width: 300, height: 100 },
      true,
      0,
    ),
    null,
  );
});

test('使用独立牌角的稳定区域，支持抬起的上边缘，不命中超出牌角的空隙', () => {
  const areas = [
    { id: 'a', left: 0, top: 8, width: 24, height: 42 },
    { id: 'b', left: 24, top: 8, width: 54, height: 42 },
    { id: 'c', left: 0, top: 54, width: 54, height: 42 },
  ];
  assert.equal(cardAtPoint(areas, { x: 23, y: 40 }), 'a');
  assert.equal(cardAtPoint(areas, { x: 24, y: 40 }), 'b');
  assert.equal(cardAtPoint(areas, { x: 25, y: 2 }), 'b');
  assert.equal(cardAtPoint(areas, { x: 25, y: 60 }), 'c');
  assert.equal(cardAtPoint(areas, { x: 77, y: 52 }), null);
  assert.equal(cardAtPoint(areas, { x: 78, y: 20 }), null);
});
