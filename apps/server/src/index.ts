import { makeServer } from './server.js';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT 必须是1到65535之间的整数');
const host = process.env.HOST || '0.0.0.0';
const server = makeServer({ publicBaseUrl: process.env.PUBLIC_BASE_URL });
server.http.listen(port, host, () => {
  console.log(`聚会斗地主已启动：http://localhost:${port}`);
  console.log('手机请连接同一 Wi-Fi，房间二维码使用电脑的局域网地址。');
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
