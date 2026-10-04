import type { Session } from '../../../packages/game/src/index.js';

export function entryIntent(invitation: string, session: Session | null, name: string) {
  const roomId = /^\d{6}$/.test(invitation) ? invitation : '';
  if (session && (!roomId || session.roomId === roomId))
    return { event: 'resume-room', payload: session };
  if (roomId && (session || name.trim()))
    return {
      event: 'enter-room',
      payload: { roomId, name: name.trim() || undefined, previousSession: session ?? undefined },
    };
  return null;
}

// getRandomValues also works on the HTTP LAN page; randomUUID requires HTTPS.
export function entryRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) =>
    value.toString(16).padStart(8, '0'),
  ).join('-');
}

export function tableSeat(seat: number, ownSeat: number, players: number): string {
  const offset = (seat - ownSeat + players) % players;
  if (!offset) return 'seat-self';
  if (players === 2 || (players === 4 && offset === 2)) return 'seat-top';
  return offset === 1 ? 'seat-right' : 'seat-left';
}
