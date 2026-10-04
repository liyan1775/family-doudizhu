import { useEffect, useState } from 'react';
import { MODES, PROFILES, type RoomSummary } from '../../../packages/game/src/index.js';

export function RoomDirectory({
  disabled,
  onJoin,
}: {
  disabled: boolean;
  onJoin: (room: RoomSummary) => void;
}) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let pending = false;
    let controller: AbortController | null = null;
    setLoading(true);
    async function load() {
      if (pending) return;
      pending = true;
      controller = new AbortController();
      const timer = window.setTimeout(() => controller?.abort(), 5000);
      try {
        const response = await fetch('/api/rooms', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error();
        const data: { rooms: RoomSummary[] } = await response.json();
        if (!Array.isArray(data.rooms)) throw new Error();
        const available = data.rooms.filter(
          (room) =>
            /^\d{6}$/.test(room.roomId) &&
            typeof room.hostName === 'string' &&
            Object.hasOwn(MODES, room.mode) &&
            Object.hasOwn(PROFILES, room.profile) &&
            PROFILES[room.profile].mode === room.mode &&
            Number.isInteger(room.playerCount) &&
            room.playerCount > 0 &&
            room.playerCount < room.maxPlayers &&
            room.maxPlayers === MODES[room.mode].players,
        );
        if (active) {
          setRooms(available);
          setError('');
        }
      } catch {
        if (active) setError('暂时没读到家人开的桌。也可以扫房主的房间码，或用房间号加入。');
      } finally {
        clearTimeout(timer);
        pending = false;
        if (active) setLoading(false);
      }
    }
    void load();
    const interval = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 3000);
    return () => {
      active = false;
      clearInterval(interval);
      controller?.abort();
    };
  }, [attempt]);

  return (
    <section className="room-directory" aria-label="可加入的房间">
      <div className="directory-heading">
        <div>
          <h2>家人已经开好的桌</h2>
          <p>填好上面的称呼，点一下就能加入。</p>
        </div>
        <button
          className="button light directory-refresh"
          onClick={() => setAttempt((value) => value + 1)}
          disabled={loading}
        >
          重新看看
        </button>
      </div>
      {error ? (
        <p className="directory-message" role="status">
          {error}
        </p>
      ) : loading ? (
        <p className="directory-message" role="status">
          正在看看家人开的桌…
        </p>
      ) : rooms.length ? (
        <div className="directory-grid">
          {rooms.map((room) => (
            <button
              key={room.roomId}
              className="directory-room"
              disabled={disabled}
              onClick={() => onJoin(room)}
              aria-label={`加入${room.hostName}的桌，${room.playerCount}/${room.maxPlayers}人`}
            >
              <span>
                <strong>{room.hostName}的桌</strong>
                <small>
                  {PROFILES[room.profile].name} · 房间{room.roomId}
                </small>
              </span>
              <span className="directory-room-action">
                <b>
                  {room.playerCount} / {room.maxPlayers} 人
                </b>
                <span>加入这桌 →</span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="directory-message">还没有可加入的桌。第一位家人可以在下面开一桌。</p>
      )}
    </section>
  );
}
