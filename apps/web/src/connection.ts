import { io, type ManagerOptions, type SocketOptions } from 'socket.io-client';

// Prefer the persistent connection; fall back for networks or browsers that
// cannot establish WebSocket, without asking players to change settings.
export const GAME_CONNECTION_OPTIONS = {
  transports: ['websocket', 'polling'],
  tryAllTransports: true,
  timeout: 8000,
};

export function createGameConnection(
  url?: string,
  options: Partial<ManagerOptions & SocketOptions> = {},
) {
  const config = { ...GAME_CONNECTION_OPTIONS, ...options };
  const socket = url ? io(url, config) : io(config);
  socket.on('connect_error', () => {
    // A silent WebSocket handshake can hit the Manager's timeout before the
    // Engine emits a transport error. tryAllTransports alone cannot catch it.
    // The next automatic attempt must start with HTTP in that case.
    socket.io.opts.transports = ['polling', 'websocket'];
  });
  return socket;
}
