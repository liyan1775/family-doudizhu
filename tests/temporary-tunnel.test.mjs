import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import {
  downloadVerified,
  publicHealthMatches,
  verifyRealtimeEntry,
} from '../scripts/temporary-tunnel.mjs';
import { makeServer } from '../apps/server/src/server.ts';

test(
  '公网就绪检查接受有效的备用连接，WebSocket受限仍可上线且不占玩家座位',
  { timeout: 10_000 },
  async (t) => {
    const server = makeServer({ temporaryPublic: true });
    server.io.engine.opts.transports = ['polling'];
    await new Promise((done) => server.http.listen(0, '127.0.0.1', done));
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.http.address().port}`;
    assert.equal(await verifyRealtimeEntry(url, { timeout: 1000 }), true);
    assert.deepEqual(await (await fetch(url + '/api/rooms')).json(), { rooms: [] });
  },
);

test('联网组件只在完整校验后替换缓存，校验失败和过大下载都保留原文件并清理临时文件', async (t) => {
  const root = resolve('tmp/tunnel-tests');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(resolve(root, 'download-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(root + sep));
    await rm(directory, { recursive: true, force: true });
  });
  const target = resolve(directory, 'connector.exe');
  await writeFile(target, 'original');
  const body = Buffer.from('verified official bytes');
  const digest = createHash('sha256').update(body).digest('hex');
  const fetcher = async () => new Response(body);
  await assert.rejects(
    downloadVerified('https://github.com/example', target, '0'.repeat(64), { fetcher }),
    /校验失败/,
  );
  assert.equal(await readFile(target, 'utf8'), 'original');
  await assert.rejects(
    downloadVerified('https://github.com/example', target, digest, { fetcher, maxBytes: 3 }),
    /大小异常/,
  );
  assert.equal(await readFile(target, 'utf8'), 'original');
  assert.deepEqual(await readdir(directory), ['connector.exe']);
  await downloadVerified('https://github.com/example', target, digest, { fetcher });
  assert.deepEqual(await readFile(target), body);
});

test('公网健康检查核对当前实例，不接受同项目旧服务、错误页面或重定向', async (t) => {
  let body = {
    ok: true,
    service: 'family-doudizhu',
    projectId: 'project',
    instanceId: 'old',
    entryMode: 'temporary',
  };
  let redirect = false;
  const server = createServer((_req, res) => {
    if (redirect) {
      res.writeHead(302, { Location: 'https://example.com' });
      res.end();
    } else res.end(JSON.stringify(body));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const identity = { projectId: 'project', instanceId: 'current' };
  assert.equal(await publicHealthMatches(base, identity), false);
  body.instanceId = 'current';
  assert.equal(await publicHealthMatches(base, identity), true);
  body.entryMode = 'lan';
  assert.equal(await publicHealthMatches(base, identity), false);
  body.entryMode = 'temporary';
  redirect = true;
  assert.equal(await publicHealthMatches(base, identity), false);
});
