import { makeServer } from './server.js';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT 必须是1到65535之间的整数');
const host = process.env.HOST || '0.0.0.0';
const server = makeServer({ publicBaseUrl: process.env.PUBLIC_BASE_URL });
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
  console.log('手机请连接同一 Wi-Fi，房间二维码使用电脑的局域网地址。');
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
  process.on('message', (message: { type?: string } | null) => {
    if (message?.type === 'shutdown') void shutdown();
  });
  process.on('disconnect', shutdown);
}
