import test from 'node:test';
import assert from 'node:assert/strict';
import { handLayout } from '../apps/web/src/hand-layout.js';

test('小竖屏的33张牌分成三行，使用可用高度而不是固定82px', () => {
  const layout = handLayout(33, 280, 170);
  assert.deepEqual(layout.columns, [11, 11, 11]);
  assert.ok(layout.cardHeight * 3 + 8 <= 170);
  assert.ok(layout.fontSize >= 20);
});

test('各种手牌数量均保留全部牌，分行均匀，每张牌都有可读的独立牌角', () => {
  for (const count of [1, 2, 17, 20, 25, 33]) {
    for (const width of [270, 280, 335, 390, 800]) {
      const layout = handLayout(count, width, 250);
      assert.equal(
        layout.columns.reduce((sum, columns) => sum + columns, 0),
        count,
      );
      assert.ok(Math.max(...layout.columns) - Math.min(...layout.columns) <= 1);
      for (const columns of layout.columns) {
        if (columns > 1) assert.ok((width - layout.cardWidth) / (columns - 1) >= 23);
      }
    }
  }
});

test('极短的可用区不把牌压成不可辨认的高度，保留内部滚动所需的牌尺寸', () => {
  const layout = handLayout(33, 280, 80);
  assert.equal(layout.cardHeight, 50);
  assert.ok(layout.cardHeight * layout.columns.length > 80);
  assert.ok(layout.fontSize >= 18);
});
