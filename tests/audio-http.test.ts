import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { makeServer } from '../apps/server/src/server.js';
import { voiceUrl, SYSTEM_VOICE, MUSIC_URL, TURN_CUE_URL } from '../apps/web/src/audio-catalog.js';

test('声音随项目托管，有版本缓存，支持手机媒体Range请求，缺素材返回404', async () => {
  const server = makeServer({ staticPath: resolve('apps/web/public') });
  await new Promise<void>((done) => server.http.listen(0, '127.0.0.1', done));
  const address = server.http.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const voice = await fetch(base + voiceUrl('pair-3', SYSTEM_VOICE));
    assert.equal(voice.status, 200);
    assert.match(voice.headers.get('content-type')!, /^audio\/mpeg/);
    assert.match(voice.headers.get('cache-control')!, /max-age=2592000, immutable/);
    assert.ok((await voice.arrayBuffer()).byteLength > 1000);
    const music = await fetch(base + MUSIC_URL, { headers: { Range: 'bytes=0-127' } });
    assert.equal(music.status, 206);
    assert.equal((await music.arrayBuffer()).byteLength, 128);
    for (const url of [
      voiceUrl('own-landlord', SYSTEM_VOICE)!,
      voiceUrl('own-farmer', SYSTEM_VOICE)!,
      TURN_CUE_URL,
    ]) {
      const response = await fetch(base + url, { headers: { Range: 'bytes=0-127' } });
      assert.equal(response.status, 206);
      assert.match(response.headers.get('cache-control')!, /max-age=2592000, immutable/);
      assert.equal((await response.arrayBuffer()).byteLength, 128);
    }
    const missing = await fetch(base + '/audio/classic-v1/voices/warm-female/no-such-clip.mp3');
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});
