import lines from '../../../scripts/voice-lines.json';
import type { GameAnnouncement, GameEvent, Player } from '../../../packages/game/src/index.js';

// 路径含资源版本；更新音频时换版本，避免手机继续使用旧缓存。
export const AUDIO_BASE = '/audio/classic-v2';
export const MUSIC_URL = '/audio/classic-v1/music/family-table.mp3';
export const TURN_CUE_URL = `${AUDIO_BASE}/turn.mp3`;
export const PREVIEW_KEYS = ['pair-12', 'single-14', 'bomb'];
export const VOICES = [
  { id: 'lively-male', label: '男声 · 爽朗' },
  { id: 'warm-female', label: '女声 · 亲切' },
  { id: 'deep-male', label: '男声 · 浑厚' },
  { id: 'bright-female', label: '女声 · 明快' },
] as const;
export type VoiceId = (typeof VOICES)[number]['id'];
export const SYSTEM_VOICE: VoiceId = 'warm-female';
export const VOICE_KEYS = Object.keys(lines);

export function seatVoice(seat: number): (typeof VOICES)[number] {
  return VOICES[seat] ?? VOICES[1];
}
export function eventVoice(
  event: GameAnnouncement | GameEvent,
  players: Pick<Player, 'id' | 'seat'>[],
): VoiceId {
  if (!['ready', 'bid', 'play', 'pass', 'finish'].includes(event.kind)) return SYSTEM_VOICE;
  const actor = players.find((p) => p.id === event.actorId);
  return actor ? seatVoice(actor.seat).id : SYSTEM_VOICE;
}
export function eventClips(
  event: GameEvent,
  players: Pick<Player, 'id' | 'seat'>[],
  youId?: string,
) {
  return (event.announcements ?? [event]).flatMap((part) => {
    const actorVoice = eventVoice(part, players);
    return part.audio.map((key, index) => ({
      key:
        part.kind === 'landlord' && key === 'landlord' && youId
          ? part.actorId === youId
            ? 'own-landlord'
            : 'own-farmer'
          : key,
      voice: part.kind === 'finish' && index > 0 ? SYSTEM_VOICE : actorVoice,
      important: ['bid', 'landlord', 'deal', 'finish'].includes(part.kind),
    }));
  });
}
export function voiceUrl(clip: string, voice: VoiceId): string | null {
  if (!Object.hasOwn(lines, clip) || !VOICES.some((v) => v.id === voice)) return null;
  return `${AUDIO_BASE}/voices/${voice}/${clip}.mp3`;
}
