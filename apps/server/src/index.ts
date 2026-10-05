import { makeServer } from './server.js';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT 必须是1到65535之间的整数');
const host = process.env.HOST || '0.0.0.0';
const temporaryPublic = process.env.FAMILY_DDZ_ENTRY_MODE === 'temporary';
if (temporaryPublic && host !== '0.0.0.0') throw new Error('自动直连主机需监听本机和局域网地址');
const server = makeServer({
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  temporaryPublic,
  ...(process.env.FAMILY_DDZ_BUILD_MODE === 'public' ? { staticPath: 'dist/public/client' } : {}),
});
server.http.once('error', (error: NodeJS.ErrnoException) => {
  process.exitCode = 1;
  const exit = () => {
    void server.close().finally(() => process.exit(1));
  };
  if (process.send) process.send({ type: 'startup-error', code: error.code }, exit);
  else {
    console.error(
      error.code === 'EADDRINUSE'
        ? `端口${port}正在使用。Windows 家庭试玩请双击“启动游戏.cmd”，它会自动打开已有游戏或选择空闲端口。`
        : '游戏没有启动成功，请检查 HOST 配置和网络权限。',
    );
    exit();
  }
});
server.http.listen(port, host, () => {
  console.log(`聚会斗地主已启动：http://localhost:${port}`);
  if (!temporaryPublic) console.log('手机请连接同一 Wi-Fi，房间二维码使用电脑的局域网地址。');
  if (process.send) process.send({ type: 'ready', port });
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await server.close();
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);
// Only forked launcher children have IPC. Losing the launcher should not leave
// an invisible server behind; an already-running manual server is untouched.
if (process.send) {
  process.on(
    'message',
    (message: { type?: string; requestId?: string; status?: unknown; url?: unknown } | null) => {
      if (message?.type === 'shutdown') void shutdown();
      if (message?.type === 'public-entry') {
        try {
          server.setPublicEntry({
            status: message.status as 'connecting' | 'ready' | 'unavailable',
            url: message.url as string | undefined,
          });
          process.send?.({ type: 'public-entry-updated', requestId: message.requestId });
        } catch {
          process.send?.({ type: 'public-entry-error', requestId: message.requestId });
        }
      }
    },
  );
  process.on('disconnect', shutdown);
}
