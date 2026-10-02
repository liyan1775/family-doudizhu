import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { comboAudio } from '../packages/game/src/index.js';

test('每段语音都有实际PCM音频，全部报牌键均有文件', () => {
  const manifest: Record<string, string> = JSON.parse(
    readFileSync(resolve('scripts/voice-lines.json'), 'utf8'),
  );
  for (const key of Object.keys(manifest)) {
    const wav = readFileSync(resolve('apps/web/public/audio', `${key}.wav`));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.ok(wav.length > 1000, `${key}音频太短`);
    assert.ok(
      wav.subarray(100).some((byte) => byte !== 0),
      `${key}是空音频`,
    );
  }
  for (let rank = 3; rank <= 17; rank++) {
    for (const type of ['single', 'pair'] as const)
      assert.ok(manifest[comboAudio({ type, rank, size: type === 'single' ? 1 : 2, chain: 1 })]);
    if (rank <= 15) assert.ok(manifest[comboAudio({ type: 'triple', rank, size: 3, chain: 1 })]);
  }
  for (let size = 4; size <= 8; size++)
    assert.ok(manifest[comboAudio({ type: 'bomb', rank: 3, size, chain: 1 }, 'four')]);
  assert.ok(manifest[comboAudio({ type: 'rocket', rank: 17, size: 4, chain: 1 }, 'four')]);
});
