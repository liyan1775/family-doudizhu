import type { RoomView } from '../../../packages/game/src/index.js';

export function isActionTurn(room: RoomView): boolean {
  return (
    ['bidding', 'calling', 'robbing', 'playing'].includes(room.phase) &&
    room.turnId === room.youId &&
    room.players.every((player) => player.online)
  );
}

/** A fresh connection/foreground snapshot is a baseline, never a replay. */
export class RoomFeedback {
  private previous: {
    roomId: string;
    youId: string;
    eventId: number;
    round: number;
    landlordId: string | null;
    turnKey: string | null;
  } | null = null;

  suspend(): void {
    this.previous = null;
  }

  observe(room: RoomView, active = true) {
    const turnKey = isActionTurn(room)
      ? `${room.roomId}:${room.round}:${room.phase}:${room.turnId}`
      : null;
    const before = this.previous;
    const sameSeat = before?.roomId === room.roomId && before.youId === room.youId;
    const fresh = !!before && sameSeat && room.event.id > before.eventId;
    // Duplicate or late packets cannot roll back notification history.
    if (!sameSeat || !before || room.event.id >= before.eventId)
      this.previous = {
        roomId: room.roomId,
        youId: room.youId,
        eventId: room.event.id,
        round: room.round,
        landlordId: room.landlordId,
        turnKey,
      };
    const reveal =
      active &&
      fresh &&
      room.phase === 'playing' &&
      !!room.landlordId &&
      (before!.round !== room.round || before!.landlordId !== room.landlordId);
    return {
      announce: active && fresh,
      reveal,
      cue: active && fresh && !reveal && !!turnKey && before!.turnKey !== turnKey,
    };
  }
}
