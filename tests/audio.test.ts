import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { comboAudio } from '../packages/game/src/index.js';
import { AUDIO_BASE, VOICES, VOICE_KEYS } from '../apps/web/src/audio-catalog.js';
import { createHash } from 'node:crypto';

test('历史PCM原件完整保留，当前文案覆盖全部合法报牌键', () => {
  const originalManifest: Record<string, string> = JSON.parse(
    readFileSync(resolve('apps/web/audio-source/neural-v1/voice-lines.json'), 'utf8'),
  );
  const manifest: Record<string, string> = JSON.parse(
    readFileSync(resolve('scripts/voice-lines.json'), 'utf8'),
  );
  for (const key of Object.keys(originalManifest)) {
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

test('新版四套配音覆盖全部78句并保留原件，各座报牌素材不同，包含身份与短音', () => {
  for (const voice of VOICES) {
    for (const key of VOICE_KEYS) {
      const original = readFileSync(
        resolve('apps/web/audio-source/neural-v2', voice.id, `${key}.mp3`),
      );
      const published = readFileSync(
        resolve(`apps/web/public${AUDIO_BASE}/voices`, voice.id, `${key}.mp3`),
      );
      assert.ok(original.length > 1000, `${voice.id}/${key}原件缺失`);
      assert.ok(published.length > 1000, `${voice.id}/${key}成品为空`);
      assert.ok(
        published.subarray(0, 200).some((byte) => byte === 0xff),
        `${voice.id}/${key}不是MP3帧`,
      );
    }
  }
  for (const key of ['pair-3', 'single-17', 'bomb', 'four-rocket']) {
    const hashes = VOICES.map((voice) =>
      createHash('sha256')
        .update(
          readFileSync(resolve(`apps/web/public${AUDIO_BASE}/voices`, voice.id, `${key}.mp3`)),
        )
        .digest('hex'),
    );
    assert.equal(new Set(hashes).size, 4, `${key}不能把同一声音当作四种音色`);
  }
  const music = readFileSync(resolve('apps/web/public/audio/classic-v1/music/family-table.mp3'));
  assert.ok(music.length > 100_000);
  const originalMusic = readFileSync(resolve('apps/web/audio-source/family-table.wav'));
  assert.equal(originalMusic.toString('ascii', 0, 4), 'RIFF');
  assert.equal(VOICE_KEYS.length, 78);
  assert.ok(VOICE_KEYS.includes('own-landlord') && VOICE_KEYS.includes('own-farmer'));
  assert.ok(!VOICE_KEYS.includes('your-turn'));
  assert.ok(readFileSync(resolve(`apps/web/public${AUDIO_BASE}/turn.mp3`)).length > 1000);
  assert.equal(
    readFileSync(resolve('apps/web/audio-source/turn-cue.wav')).toString('ascii', 0, 4),
    'RIFF',
  );
});

test('已确认家庭叫法对应单张、对子和三张，不混入旧圈尖叫法', () => {
  const manifest = JSON.parse(readFileSync(resolve('scripts/voice-lines.json'), 'utf8'));
  for (const [rank, name] of [
    [11, '勾'],
    [12, '皮蛋'],
    [13, '凯'],
    [14, 'ace'],
  ]) {
    assert.equal(manifest[`single-${rank}`], `${name}。`);
    assert.equal(manifest[`pair-${rank}`], `对${name}。`);
    assert.equal(manifest[`triple-${rank}`], `三个${name}。`);
  }
});
