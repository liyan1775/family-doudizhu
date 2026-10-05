import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import QRCode from 'qrcode';
import {
  analyze,
  beats,
  DEFAULT_PROFILE,
  describeCombo,
  MODES,
  PROFILES,
  rankLabel,
  suggestPlay,
} from '../../../packages/game/src/index.js';
import type {
  Ack,
  Card,
  GameMode,
  RoomView,
  RuleProfile,
  Session,
} from '../../../packages/game/src/index.js';
import { VoicePlayer, type VoiceStatus } from './voice.js';
import { MusicPlayer, type MusicStatus } from './music.js';
import { seatVoice, VOICES } from './audio-catalog.js';
import { RoomDirectory } from './RoomDirectory.js';
import { isPublicEntry, phoneEntryUrls, phonePublicUrl, type EntryConfig } from './phone-links.js';
import { RoomFeedback, isActionTurn } from './room-feedback.js';
import { TurnCue } from './turn-cue.js';
import { handLayout } from './hand-layout.js';
import {
  createPlayerConnection,
  type PlayerConnection,
  type TransportStatus,
} from './player-connection.js';
import { entryIntent, entryRequestId, tableSeat } from './entry-session.js';

type Config = EntryConfig;
const SESSION_KEY = 'family-doudizhu-session';
const SUIT_ICONS = { spades: '♠', hearts: '♥', clubs: '♣', diamonds: '♦', joker: '★' };
function readSession(): Session | null {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null');
  } catch {
    return null;
  }
}
function PlayingCard({
  card,
  selected = false,
  onClick,
  small = false,
}: {
  card: Card;
  selected?: boolean;
  onClick?: () => void;
  small?: boolean;
}) {
  const red = card.suit === 'hearts' || card.suit === 'diamonds' || card.rank === 17;
  const label = `${card.rank > 15 ? '' : SUIT_ICONS[card.suit]}${rankLabel(card.rank)}`;
  const content = (
    <>
      <span className="card-rank">{rankLabel(card.rank)}</span>
      <span className="card-suit">{SUIT_ICONS[card.suit]}</span>
      {selected && <span className="card-check">✓</span>}
    </>
  );
  const className = `playing-card ${red ? 'red' : ''} ${small ? 'small' : ''} ${selected ? 'selected' : ''} ${card.rank > 15 ? 'joker' : ''} ${card.rank === 10 ? 'ten' : ''}`;
  return onClick ? (
    <button
      type="button"
      className={className}
      onClick={onClick}
      aria-label={label}
      aria-pressed={selected}
      data-card-id={card.id}
    >
      {content}
    </button>
  ) : (
    <span className={className} aria-label={label} data-card-id={card.id}>
      {content}
    </span>
  );
}
function HandCards({
  cards,
  selected,
  onSelect,
  compact,
  scrollRef,
}: {
  cards: Card[];
  selected: string[];
  onSelect?: (id: string) => void;
  compact: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const [size, setSize] = useState({ width: 280, height: 180 });
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !compact) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const next = {
        width: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        height:
          element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
      };
      setSize((current) =>
        Math.abs(current.width - next.width) < 0.5 && Math.abs(current.height - next.height) < 0.5
          ? current
          : next,
      );
    };
    measure();
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [compact, scrollRef]);
  const layout = handLayout(cards.length, size.width, size.height, compact);
  const renderCard = (card: Card) => (
    <PlayingCard
      key={card.id}
      card={card}
      selected={selected.includes(card.id)}
      onClick={onSelect ? () => onSelect(card.id) : undefined}
    />
  );
  let offset = 0;
  return (
    <div
      className="hand-cards"
      ref={scrollRef}
      style={
        compact
          ? ({
              '--hand-card-width': `${layout.cardWidth}px`,
              '--hand-card-height': `${layout.cardHeight}px`,
              '--hand-font-size': `${layout.fontSize}px`,
            } as React.CSSProperties)
          : undefined
      }
    >
      {compact
        ? layout.columns.map((count, row) => {
            const rowCards = cards.slice(offset, offset + count);
            offset += count;
            return (
              <div
                className="hand-card-row"
                key={row}
                style={{
                  gridTemplateColumns:
                    count > 1
                      ? `repeat(${count - 1}, minmax(0, 1fr)) var(--hand-card-width)`
                      : 'var(--hand-card-width)',
                }}
              >
                {rowCards.map(renderCard)}
              </div>
            );
          })
        : cards.map(renderCard)}
    </div>
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog ref={dialog} className="modal" onCancel={onClose}>
      <div className="modal-top">
        <h2>{title}</h2>
        <button className="close-button" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function App() {
  const [connectionCheck] = useState(
    () => new URLSearchParams(location.search).get('connection-check') === '1',
  );
  const [socket, setSocket] = useState<PlayerConnection | null>(null);
  const [connected, setConnected] = useState(false);
  const [transport, setTransport] = useState<TransportStatus>({
    route: 'offline',
    publicConnected: false,
    directConnected: false,
    sequence: 0,
  });
  const [replaced, setReplaced] = useState(false);
  const [room, setRoom] = useState<RoomView | null>(null);
  const [name, setName] = useState(localStorage.getItem('family-name') ?? '');
  const [mode, setMode] = useState<GameMode>('three');
  const [profile, setProfile] = useState<RuleProfile>('three-classic');
  const invitationRoom = new URLSearchParams(location.search).get('room') ?? '';
  const initialRoom = /^\d{6}$/.test(invitationRoom) ? invitationRoom : '';
  const [roomNumber, setRoomNumber] = useState(/^\d{6}$/.test(initialRoom) ? initialRoom : '');
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState(false);
  const [phoneInvite, setPhoneInvite] = useState(false);
  const [help, setHelp] = useState(false);
  const [soundSettings, setSoundSettings] = useState(false);
  const [soundCategory, setSoundCategory] = useState<'voice' | 'music'>('voice');
  const [leave, setLeave] = useState(false);
  const [tableInfo, setTableInfo] = useState(false);
  const [landlordReveal, setLandlordReveal] = useState<string | null>(null);
  const [cueError, setCueError] = useState(false);
  const [config, setConfig] = useState<Config>({ publicBaseUrl: null, localUrls: [] });
  const [inviteBase, setInviteBase] = useState('');
  const [qr, setQr] = useState('');
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const [voice] = useState(() => new VoicePlayer());
  const [cue] = useState(() => new TurnCue());
  const [feedback] = useState(() => new RoomFeedback());
  const [music] = useState(() => new MusicPlayer());
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>(voice.status);
  const [musicStatus, setMusicStatus] = useState<MusicStatus>(music.status);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const revealActive = useRef(false);
  const handScroll = useRef<HTMLDivElement>(null);
  const latestRoom = useRef<RoomView | null>(null);
  const entryReceipt = useRef<{ fingerprint: string; id: string } | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  latestRoom.current = room;
  function cancelReveal() {
    clearTimeout(revealTimer.current);
    revealActive.current = false;
    setLandlordReveal(null);
  }
  function unlockVoice() {
    cue.unlock();
    voice.unlock();
  }
  function entryPayload(payload: object) {
    const fingerprint = JSON.stringify(payload);
    if (entryReceipt.current?.fingerprint !== fingerprint)
      entryReceipt.current = { fingerprint, id: entryRequestId() };
    return { ...payload, requestId: entryReceipt.current.id };
  }
  function saveSeat(session: Session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    const savedName = name.trim() || localStorage.getItem('family-name');
    if (savedName) localStorage.setItem('family-name', savedName);
    history.replaceState(null, '', `/?room=${session.roomId}`);
    setRoomNumber(session.roomId);
    setPhoneInvite(false);
  }

  useEffect(() => {
    voice.onStatus = (status) => {
      setVoiceStatus(status);
      if (!status.enabled) cue.clear();
    };
    music.onStatus = setMusicStatus;
    let speechActive = false;
    let cueActive = false;
    voice.onSpeaking = (speaking) => {
      speechActive = speaking;
      music.duck(speechActive || cueActive);
    };
    cue.onPlaying = (playing) => {
      cueActive = playing;
      music.duck(speechActive || cueActive);
    };
    cue.onError = setCueError;
    voice.prepareSamples();
    const visibility = () => {
      voice.clear();
      cue.clear();
      feedback.suspend();
      cancelReveal();
      if (!document.hidden && latestRoom.current) feedback.observe(latestRoom.current);
      music.setActive(!document.hidden);
    };
    document.addEventListener('visibilitychange', visibility);
    const s = createPlayerConnection();
    setSocket(s);
    let connectionGeneration = 0;
    let entryRetry: ReturnType<typeof setTimeout> | undefined;
    s.on('connect', () => {
      const generation = ++connectionGeneration;
      clearTimeout(entryRetry);
      setConnected(true);
      setReplaced(false);
      const session = readSession();
      const invitation = new URLSearchParams(location.search).get('room') ?? '';
      const intent = entryIntent(invitation, session, localStorage.getItem('family-name') ?? '');
      if (!intent) {
        setBusy(false);
        return;
      }
      const payload = intent.event === 'enter-room' ? entryPayload(intent.payload) : intent.payload;
      const enterSeat = () => {
        if (!s.connected || generation !== connectionGeneration) return;
        setBusy(true);
        s.timeout(6000).volatile.emit(
          intent.event,
          payload,
          (error: Error | null, result: Ack<Session>) => {
            if (!s.connected || generation !== connectionGeneration) return;
            if (error) {
              setMessage('入座回复较慢，正在重试，请保持页面打开');
              entryRetry = setTimeout(enterSeat, 1500);
              return;
            }
            setBusy(false);
            if (result.ok && result.data) {
              saveSeat(result.data);
              setMessage('');
              return;
            }
            if (!result.ok) {
              if (intent.event === 'resume-room' && readSession()?.token === session?.token)
                localStorage.removeItem(SESSION_KEY);
              setRoom(null);
              feedback.suspend();
              if (intent.event === 'resume-room' && invitation === session?.roomId) {
                history.replaceState(null, '', '/');
                setRoomNumber('');
              }
              setMessage(result.error ?? '请重新入座');
            }
          },
        );
      };
      enterSeat();
    });
    s.on('transport-status', (status: TransportStatus) => setTransport(status));
    s.on('disconnect', () => {
      connectionGeneration++;
      clearTimeout(entryRetry);
      setBusy(false);
      setConnected(false);
      voice.clear();
      cue.clear();
      feedback.suspend();
      cancelReveal();
    });
    s.on('connect_error', () => setConnected(false));
    s.on('session-replaced', () => {
      // 同一站点的页面共享身份；保留令牌，另一页面刷新后仍能恢复座位。
      setReplaced(true);
      voice.clear();
      cue.clear();
      feedback.suspend();
      cancelReveal();
      setRoom(null);
      setInvite(false);
    });
    s.on('room-state', (state: RoomView) => {
      const signal = feedback.observe(state, !document.hidden);
      if (!isActionTurn(state)) cue.clear();
      if (state.phase !== 'playing') cancelReveal();
      if (signal.announce) voice.playEvent(state.event, state.players, state.youId);
      if (signal.reveal) {
        const landlordName = state.players.find((p) => p.id === state.landlordId)?.name ?? '家人';
        clearTimeout(revealTimer.current);
        revealActive.current = true;
        setLandlordReveal(`${landlordName}当地主`);
        const { roomId, round, landlordId } = state;
        revealTimer.current = setTimeout(() => {
          revealActive.current = false;
          setLandlordReveal(null);
          const current = latestRoom.current;
          if (
            !document.hidden &&
            s.connected &&
            current &&
            current.roomId === roomId &&
            current.round === round &&
            current.landlordId === landlordId &&
            isActionTurn(current)
          )
            cue.play(voice.enabled && voice.unlocked);
        }, 1400);
      } else if (signal.cue && !revealActive.current) {
        cue.play(voice.enabled && voice.unlocked);
      }
      const previousState = latestRoom.current;
      const changedTurn =
        previousState?.roomId !== state.roomId ||
        previousState?.round !== state.round ||
        previousState?.turnId !== state.turnId ||
        previousState?.phase !== state.phase;
      latestRoom.current = state;
      setRoom(state);
      setSelected((current) =>
        changedTurn ? [] : current.filter((id) => state.hand.some((c) => c.id === id)),
      );
    });
    return () => {
      clearTimeout(entryRetry);
      s.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      voice.dispose();
      cue.dispose();
      clearTimeout(revealTimer.current);
      music.dispose();
    };
  }, [voice, music, cue, feedback]);

  useEffect(() => {
    let active = true;
    const controllers = new Set<AbortController>();
    async function check() {
      const controller = new AbortController();
      controllers.add(controller);
      const timer = window.setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch('/api/config', {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error();
        const data: Config = await response.json();
        if (!Array.isArray(data.localUrls)) throw new Error();
        if (!active) return;
        setConfig(data);
        const urls = phoneEntryUrls(data);
        const base = !localHost && urls.includes(location.origin) ? location.origin : urls[0] || '';
        setInviteBase((current) => (urls.includes(current) ? current : base));
      } catch {
        if (active) setInviteBase('');
      } finally {
        clearTimeout(timer);
        controllers.delete(controller);
      }
    }
    void check();
    const interval = window.setInterval(() => {
      if (!document.hidden) void check();
    }, 10_000);
    const visibility = () => {
      if (!document.hidden) void check();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      active = false;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', visibility);
      for (const controller of controllers) controller.abort();
    };
  }, [localHost]);

  useEffect(() => {
    if (room) voice.prepare(Array.from({ length: MODES[room.mode].players }, (_, seat) => seat));
  }, [voice, room?.roomId, room?.mode]);

  const landscapeTable = !!room && room.phase !== 'waiting';
  useEffect(() => {
    document.body.classList.toggle('playing-landscape', landscapeTable);
    return () => document.body.classList.remove('playing-landscape');
  }, [landscapeTable]);
  useEffect(() => {
    if (!room?.turnDeadline || !room.serverTime) {
      setSecondsLeft(null);
      return;
    }
    const remaining = room.turnDeadline - room.serverTime;
    const received = performance.now();
    const update = () =>
      setSecondsLeft(Math.max(0, Math.ceil((remaining - (performance.now() - received)) / 1000)));
    update();
    const timer = window.setInterval(update, 250);
    return () => clearInterval(timer);
  }, [room]);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(''), 8000);
    return () => clearTimeout(timer);
  }, [message]);
  const joinUrl = room && inviteBase ? `${inviteBase}/?room=${room.roomId}` : '';
  const publicMode = isPublicEntry(config);
  const publicInvite = publicMode && !!inviteBase && inviteBase === phonePublicUrl(config);
  const qrTarget = phoneInvite ? inviteBase : joinUrl;
  useEffect(() => {
    let current = true;
    setQr('');
    if (qrTarget)
      QRCode.toDataURL(qrTarget, {
        width: 320,
        margin: 3,
        errorCorrectionLevel: 'M',
        color: { dark: '#163e31', light: '#ffffff' },
      })
        .then((value) => {
          if (current) setQr(value);
        })
        .catch(() => setMessage('二维码暂时生成失败，请用房间号加入'));
    return () => {
      current = false;
    };
  }, [qrTarget]);

  async function request<T>(event: string, payload: object = {}): Promise<T | undefined> {
    if (!socket?.connected) throw new Error('正在重新连接，请稍等');
    return new Promise((resolve, reject) => {
      socket
        .timeout(6000)
        .volatile.emit(
          event,
          { revision: latestRoom.current?.event.id, ...payload },
          (error: Error | null, result: Ack<T>) => {
            if (error) reject(new Error('操作回复超时，请先查看牌局是否已更新'));
            else if (!result.ok) reject(new Error(result.error ?? '操作没有成功'));
            else resolve(result.data);
          },
        );
    });
  }
  async function act(event: string, payload: object = {}) {
    if (busy) return;
    if (voice.enabled && !voice.unlocked) unlockVoice();
    else if (voice.enabled && !cue.unlocked) cue.unlock();
    setBusy(true);
    setMessage('');
    try {
      await request(event, payload);
      if (event === 'play' || event === 'pass') setSelected([]);
      if (event === 'leave-room') {
        voice.clear();
        cue.clear();
        feedback.suspend();
        cancelReveal();
        music.setActive(false);
        localStorage.removeItem(SESSION_KEY);
        setRoom(null);
        setLeave(false);
        setSelected([]);
        history.replaceState(null, '', '/');
        setRoomNumber('');
      }
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function enter(create: boolean, joinRoomNumber = roomNumber) {
    if (!name.trim()) {
      setMessage('先填写您的称呼，方便家人认出您');
      document.getElementById('player-name')?.focus();
      return;
    }
    if (!create && !/^\d{6}$/.test(joinRoomNumber)) {
      setMessage('请填写6位房间号');
      return;
    }
    if (voice.enabled && !voice.unlocked) unlockVoice();
    else if (voice.enabled) cue.unlock();
    music.setActive(true);
    if (music.enabled) music.start();
    setBusy(true);
    setMessage('');
    try {
      const payload = {
        name,
        mode,
        profile,
        roomId: joinRoomNumber,
        ...(create ? {} : { previousSession: readSession() ?? undefined }),
      };
      const session = await request<Session>(
        create ? 'create-room' : 'enter-room',
        create ? payload : entryPayload(payload),
      );
      if (session) {
        saveSeat(session);
        localStorage.setItem('family-name', name.trim());
        history.replaceState(null, '', `/?room=${session.roomId}`);
        if (create) setInvite(true);
      }
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function changeMode(value: GameMode) {
    setMode(value);
    setProfile(DEFAULT_PROFILE[value]);
  }
  function hint() {
    if (!room) return;
    const limit = room.bombLimits[room.youId];
    const ids = suggestPlay(
      room.hand,
      room.lastPlay?.combo ?? null,
      room.mode,
      room.profile,
      limit.limit === null || limit.used < limit.limit,
    );
    setSelected(ids);
    requestAnimationFrame(() =>
      handScroll.current
        ?.querySelector('.selected')
        ?.scrollIntoView({ behavior: 'auto', block: 'nearest' }),
    );
    setMessage(ids.length ? '已经帮您选好；看一眼，再点出牌' : '没有能压过的牌，可以点“不出”');
  }
  const selectedCards = useMemo(
    () => room?.hand.filter((c) => selected.includes(c.id)) ?? [],
    [room?.hand, selected],
  );
  const selectedCombo = room ? analyze(selectedCards, room.mode, room.profile) : null;
  const validSelection =
    !!selectedCombo &&
    !!room &&
    beats(selectedCombo, room.lastPlay?.combo ?? null, room.mode, room.profile);
  const me = room?.players.find((p) => p.id === room.youId);
  const inGame = !!room && !['waiting', 'finished'].includes(room.phase);
  const myTurn = !!room && room.turnId === room.youId;
  const allOnline = room?.players.every((p) => p.online) ?? true;
  const visibleSeconds = connected && allOnline ? secondsLeft : null;
  const canAct = connected && !busy && allOnline && !landlordReveal;
  const turnName = room?.players.find((p) => p.id === room.turnId)?.name;
  const landlordName = room?.players.find((p) => p.id === room.landlordId)?.name;
  const actionWord =
    room?.phase === 'playing'
      ? '出牌'
      : room?.phase === 'bidding'
        ? '叫分'
        : room?.phase === 'calling'
          ? '叫地主'
          : '抢地主';
  const turnText = !connected
    ? '正在连接，请稍等'
    : !allOnline
      ? '有家人离线，等回来继续'
      : landlordReveal
        ? '地主确定'
        : room?.phase === 'finished'
          ? room.event.text
          : myTurn
            ? `请${actionWord}`
            : `等${turnName ?? '家人'}${actionWord}`;
  const voiceLabel =
    voiceStatus.unlocked && voiceStatus.enabled
      ? '报牌已开'
      : voiceStatus.enabled
        ? '报牌待开启'
        : '报牌已关';
  const toggleVoice = () =>
    voiceStatus.enabled && voiceStatus.unlocked ? voice.mute() : unlockVoice();
  const soundLoading = voiceStatus.loading;
  const loadPercent = soundLoading.total
    ? Math.round((soundLoading.loaded / soundLoading.total) * 100)
    : 0;

  return (
    <div
      className={`app ${room ? 'in-room' : ''} ${landscapeTable ? 'game-active table-landscape' : ''} ${inGame && myTurn && connected && allOnline && !landlordReveal ? 'my-turn' : ''}`}
    >
      <header className="topbar">
        <a
          className="brand"
          href="/"
          onClick={
            room
              ? (e) => {
                  e.preventDefault();
                  setLeave(true);
                }
              : undefined
          }
        >
          <span className="brand-mark">♠</span>
          <span>
            聚会斗地主
            <small>{landscapeTable ? `房间 ${room?.roomId} · 横放手机玩` : '家人围一桌'}</small>
          </span>
        </a>
        <div className="top-actions">
          <span className={`connection ${connected ? 'online' : ''}`}>
            <i />
            {connected ? '已连接' : '连接中'}
          </span>
          <button
            className="sound-button"
            onClick={() => {
              if (inGame && voiceStatus.enabled && !voiceStatus.unlocked) unlockVoice();
              setSoundSettings(true);
            }}
            aria-label={`声音设置，${voiceLabel}`}
          >
            <span>{voiceStatus.unlocked && voiceStatus.enabled ? '♪' : '♫'}</span>
            {inGame && voiceStatus.enabled && !voiceStatus.unlocked ? '恢复声音' : '声音设置'}
          </button>
          {landscapeTable ? (
            <button className="table-info-button" onClick={() => setTableInfo(true)}>
              牌桌
            </button>
          ) : (
            <button className="help-button" onClick={() => setHelp(true)} aria-label="玩法说明">
              ?
            </button>
          )}
        </div>
      </header>
      {voiceStatus.error && (
        <div className="notice" role="status">
          {inGame ? '报牌声音待恢复。' : '报牌暂时没有播放，仍可看文字继续玩。'}
          <button className="text-link" onClick={unlockVoice}>
            {inGame ? '恢复声音' : '恢复报牌声音'}
          </button>
        </div>
      )}
      {cueError && voiceStatus.enabled && (
        <div className="notice" role="status">
          回合提示音暂时没有播放。
          <button className="text-link" onClick={() => cue.unlock()}>
            恢复提示音
          </button>
        </div>
      )}
      {musicStatus.error && (
        <div className="notice" role="status">
          配乐暂时没有播放。
          <button className="text-link" onClick={() => music.start()}>
            恢复配乐
          </button>
          <button className="text-link" onClick={() => music.stop()}>
            关闭配乐
          </button>
        </div>
      )}
      {voiceStatus.enabled && soundLoading.phase === 'loading' && (
        <div className="sound-loading" role="status">
          <span>正在准备报牌声音 · {loadPercent}%</span>
          <progress
            value={soundLoading.loaded}
            max={soundLoading.total}
            aria-label="报牌声音加载进度"
          />
          <small>可以先入座，准备好就能听到。</small>
        </div>
      )}
      {replaced && (
        <div className="notice">
          这个座位已在另一页面打开。可以回到那个页面，或
          <button className="text-link" onClick={() => socket?.connect()}>
            在这里继续
          </button>
          。
        </div>
      )}
      {!connected && !replaced && (
        <div className="notice">正在连接牌桌。请保持页面打开，连接恢复后会回到原座位。</div>
      )}
      {message && (
        <div className="toast" role="status" onClick={() => setMessage('')}>
          {message}
        </div>
      )}
      {!room ? (
        <main className={initialRoom ? 'home invited-home' : 'home'}>
          {!initialRoom ? (
            <section className="hero">
              <div>
                <span className="eyebrow">一家人 · 一桌牌 · 一起乐</span>
                <h1>
                  人齐了，
                  <br />
                  就开一桌。
                </h1>
                <p>
                  微信扫一扫，家人坐一桌。
                  <br />
                  大字看得清，出牌听得见。
                </p>
                <div className="hero-tags">
                  <span>二人 / 三人 / 四人</span>
                  <span>普通话报牌</span>
                </div>
              </div>
              <div className="hero-cards" aria-hidden="true">
                <span className="hero-card back-card" />
                <span className="hero-card middle-card">
                  <b>A</b>
                  <i>♥</i>
                </span>
                <span className="hero-card front-card">
                  <b>A</b>
                  <i>♠</i>
                  <em>好牌一起打</em>
                </span>
                <span className="hero-star">✦</span>
              </div>
            </section>
          ) : (
            <section className="invitation-heading">
              <span className="eyebrow">扫码成功</span>
              <h1>家人在等您入座</h1>
              <p>填个称呼，就能一起玩。</p>
            </section>
          )}
          {!initialRoom && localHost && (
            <div className="phone-entry">
              <p>电脑运行游戏，家人都用手机玩。</p>
              <button
                className="button light"
                onClick={() => {
                  setPhoneInvite(true);
                  setInvite(true);
                }}
              >
                手机扫码开桌
              </button>
            </div>
          )}
          <div className="welcome-panel">
            <label htmlFor="player-name">先告诉家人，您是谁</label>
            <input
              id="player-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：爷爷、奶奶、老张"
              maxLength={10}
              autoComplete="nickname"
            />
            <span className="field-hint">不用注册，填个熟悉的称呼就好。</span>
          </div>
          {!initialRoom && (
            <RoomDirectory
              disabled={!connected || busy}
              onJoin={(table) => {
                setRoomNumber(table.roomId);
                void enter(false, table.roomId);
              }}
            />
          )}
          <div className="sound-welcome">
            <div>
              <strong>熟悉的报牌，热闹的牌桌</strong>
              <p>男女声音按座位区分，配乐可以单独开启。</p>
            </div>
            <button className="button light" onClick={() => setSoundSettings(true)}>
              试听声音 ♪
            </button>
          </div>
          <div className={`entry-grid ${initialRoom ? 'invited' : ''}`}>
            <section className="entry-card create-entry">
              <span className="step-label">我是房主</span>
              <h2>开一桌，等家人</h2>
              <p>选好人数，就能展示入座二维码。</p>
              <div className="mode-options" aria-label="游戏人数">
                {(Object.keys(MODES) as GameMode[]).map((value) => (
                  <button
                    key={value}
                    className={mode === value ? 'active' : ''}
                    onClick={() => changeMode(value)}
                    aria-pressed={mode === value}
                  >
                    <strong>{MODES[value].players}</strong>
                    <span>人斗地主</span>
                  </button>
                ))}
              </div>
              <details className="rule-picker">
                <summary>本桌玩法：{PROFILES[profile].name}</summary>
                <div>
                  {(Object.entries(PROFILES) as [RuleProfile, (typeof PROFILES)[RuleProfile]][])
                    .filter(([, p]) => p.mode === mode)
                    .map(([value, p]) => (
                      <label key={value}>
                        <input
                          type="radio"
                          checked={value === profile}
                          onChange={() => setProfile(value)}
                          name="profile"
                        />
                        <span>
                          <b>{p.name}</b>
                          <small>{p.summary}</small>
                        </span>
                      </label>
                    ))}
                </div>
              </details>
              <button
                className="button primary full"
                disabled={!connected || busy}
                onClick={() => enter(true)}
              >
                创建房间 <span>→</span>
              </button>
            </section>
            <section className="entry-card join-entry">
              <span className="step-label">家人已经开好桌</span>
              <h2>{initialRoom ? '这就是家人的牌桌' : '找到家人的牌桌'}</h2>
              <p>
                {initialRoom
                  ? '房间号已经填好，填写称呼后就能加入。'
                  : '扫码会自动填好房间号，也可以手动输入。'}
              </p>
              <label htmlFor="room-number">6位房间号</label>
              <input
                id="room-number"
                className="room-input"
                value={roomNumber}
                onChange={(e) => setRoomNumber(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="例如 123456"
                inputMode="numeric"
                maxLength={6}
              />
              <div className="join-tip">
                <span>⌁</span>
                <p>
                  {publicMode ? 'Wi-Fi 或手机流量' : '手机和开桌的电脑'}
                  <br />
                  {publicMode ? '扫码就能和家人一起玩' : '连接同一个 Wi-Fi'}
                </p>
              </div>
              <button
                className="button secondary full"
                disabled={!connected || busy}
                onClick={() => enter(false)}
              >
                加入房间 <span>→</span>
              </button>
            </section>
          </div>
          <footer className="home-footer">
            {initialRoom ? (
              <a href="/">我要自己开一桌</a>
            ) : (
              '慢慢玩，别着急。和家人在一起，就是好时光。'
            )}
          </footer>
        </main>
      ) : (
        <main
          className={`room-page mode-${room.mode} ${room.allowance > 0 ? 'with-allowance' : ''}`}
        >
          <div className="room-heading">
            <div>
              <span className="eyebrow">
                {PROFILES[room.profile].name} ·{' '}
                {room.phase === 'waiting' ? '等家人入座' : `第 ${room.round} 局`}
              </span>
              <h1>
                房间 <span>{room.roomId}</span>
              </h1>
            </div>
            <div className="room-tools">
              <button className="button light" onClick={() => setInvite(true)}>
                邀请家人
              </button>
              <button className="text-button" onClick={() => setLeave(true)}>
                离开
              </button>
            </div>
          </div>
          <section
            className="players"
            aria-label="玩家余牌数量"
            style={
              { '--players': MODES[room.mode].players - (inGame ? 1 : 0) } as React.CSSProperties
            }
          >
            {Array.from({ length: MODES[room.mode].players }, (_, seat) => {
              const p = room.players.find((p) => p.seat === seat);
              return (
                <div
                  key={seat}
                  className={`player-seat ${tableSeat(seat, me?.seat ?? 0, MODES[room.mode].players)} ${p?.id === room.youId ? 'own-seat' : ''} ${p?.id === room.turnId ? 'current' : ''} ${!p ? 'empty' : ''} ${p && !p.online ? 'offline-seat' : ''}`}
                >
                  <div className="avatar">{p ? [...p.name][0] : '+'}</div>
                  <strong>
                    {p ? `${p.name}${p.id === room.youId ? '（您）' : ''}` : '等家人'}
                  </strong>
                  {landscapeTable && p ? (
                    <>
                      <span className="remaining-count">
                        <b>{p.cardCount}</b> 张
                        <small className="seat-role">
                          {!p.online
                            ? '离线'
                            : room.landlordId
                              ? p.id === room.landlordId
                                ? '地主'
                                : '农民'
                              : p.id === room.turnId
                                ? room.phase === 'bidding'
                                  ? '叫分'
                                  : '叫抢'
                                : '待定'}
                        </small>
                      </span>
                    </>
                  ) : (
                    <span>
                      {!p
                        ? '扫码入座'
                        : !p.online
                          ? '暂时离线'
                          : room.phase === 'waiting'
                            ? p.ready
                              ? '✓ 已准备'
                              : '尚未准备'
                            : `${p.id === room.landlordId ? '地主' : room.landlordId ? '农民' : '待叫地主'} · ${p.cardCount}张`}
                    </span>
                  )}
                  <small className="seat-score">
                    {p ? `积分 ${p.score >= 0 ? '+' : ''}${p.score}` : '空座位'}
                  </small>
                  {p && room.bombLimits[p.id].limit !== null && (
                    <small className="seat-bombs">
                      炸弹 {room.bombLimits[p.id].used}/{room.bombLimits[p.id].limit}
                    </small>
                  )}
                </div>
              );
            })}
          </section>
          {room.phase === 'waiting' ? (
            <section className="lobby">
              <span className="lobby-icon">♣</span>
              <h2>
                {room.players.length < MODES[room.mode].players
                  ? `还差 ${MODES[room.mode].players - room.players.length} 位家人`
                  : '人齐了，准备开局'}
              </h2>
              <p>
                {me?.ready ? '您已准备，等其他家人点准备。' : '入座后点一下准备，人齐就自动发牌。'}
              </p>
              <button
                className="button primary big"
                disabled={!connected || busy}
                onClick={() => act('ready', { ready: !me?.ready })}
              >
                {me?.ready ? '取消准备' : '我准备好了'}
              </button>
              <div className="lobby-rule">{PROFILES[room.profile].summary}</div>
            </section>
          ) : (
            <>
              <section
                className={`table ${landlordReveal ? 'revealing' : ''} ${room.allowance > 0 ? 'has-allowance' : ''}`}
              >
                <div className="table-top">
                  <span className="landlord-label">
                    {room.landlordId
                      ? `地主：${landlordName}`
                      : room.phase === 'bidding'
                        ? '叫分确定地主'
                        : room.phase === 'calling' || room.phase === 'robbing'
                          ? '抢地主 · 让牌'
                          : '家人的牌桌'}
                  </span>
                  <span>
                    {room.profile === 'two-rob' ? '基础' : '叫分'} ×{room.highestBid || 1} · 倍数 ×
                    {room.multiplier}
                  </span>
                </div>
                <div className="turn-banner">
                  <span aria-live="polite">{turnText}</span>
                  {room.phase === 'playing' && (
                    <span
                      className={`turn-countdown ${visibleSeconds !== null && visibleSeconds <= 5 ? 'urgent' : ''}`}
                      aria-label={
                        visibleSeconds === null ? '倒计时暂停' : `本回合还剩${visibleSeconds}秒`
                      }
                    >
                      {visibleSeconds === null ? '暂停' : `${visibleSeconds}秒`}
                    </span>
                  )}
                </div>
                {landlordReveal && (
                  <div className="landlord-reveal" role="status">
                    <strong>{landlordReveal}</strong>
                    <span>
                      {room.landlordId === room.youId
                        ? '您是地主，您先出牌'
                        : '您是农民，等地主先出牌'}
                    </span>
                  </div>
                )}
                <div className="last-play">
                  {room.lastPlay ? (
                    <>
                      <p>
                        <span className="last-play-name">
                          {room.players.find((p) => p.id === room.lastPlay?.playerId)?.name}
                        </span>
                        <span className="last-play-description">
                          {describeCombo(room.lastPlay.combo)} · {room.lastPlay.cards.length}张
                        </span>
                      </p>
                      <div className="played-cards">
                        {room.lastPlay.cards.map((card) => (
                          <PlayingCard key={card.id} card={card} small />
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="table-empty">
                      <span>♠</span>
                      <p>
                        {room.phase === 'playing'
                          ? '新的一轮，先手可以出任意合法牌型'
                          : '看看好牌，选好再叫'}
                      </p>
                    </div>
                  )}
                </div>
                <p className="event-text" aria-live="polite">
                  {room.event.text}
                </p>
                {room.bottom.length > 0 && (
                  <details className="bottom-cards">
                    <summary>{room.mode === 'four' ? '您的8张底牌' : '本局3张底牌'}</summary>
                    <div>
                      {room.bottom.map((c) => (
                        <PlayingCard key={c.id} card={c} small />
                      ))}
                    </div>
                  </details>
                )}
                {room.allowance > 0 && (
                  <div className="allowance">
                    地主让 {room.allowance} 张 · 农民剩 {room.allowance} 张或更少就获胜
                  </div>
                )}
              </section>
              {room.phase === 'finished' && (
                <section className="settlement">
                  <h2>
                    {(room.winner === 'landlord') === (room.landlordId === room.youId)
                      ? '这局您赢了！'
                      : '这局结束，再来一局'}
                  </h2>
                  <div>
                    {room.settlement.map((item) => (
                      <p key={item.playerId}>
                        <span>{room.players.find((p) => p.id === item.playerId)?.name}</span>
                        <b className={item.delta > 0 ? 'positive' : 'negative'}>
                          {item.delta > 0 ? '+' : ''}
                          {item.delta} 分
                        </b>
                      </p>
                    ))}
                  </div>
                  <p>{room.spring ? '春天，积分翻倍。' : '积分仅用于本桌娱乐。'}</p>
                  {room.youId === room.hostId ? (
                    <button
                      className="button primary big"
                      disabled={!canAct}
                      onClick={() => act('next-round')}
                    >
                      再来一局
                    </button>
                  ) : (
                    <p>等房主开始下一局</p>
                  )}
                </section>
              )}
              <section className="hand-area" id="your-hand">
                <div className="hand-heading">
                  <h2>
                    {me?.name}（您） <span>· {room.hand.length}张</span>
                  </h2>
                  <span>
                    {room.landlordId === room.youId
                      ? '地主'
                      : room.landlordId
                        ? '农民'
                        : '身份待定'}
                  </span>
                </div>
                <HandCards
                  cards={room.hand}
                  selected={selected}
                  compact={landscapeTable}
                  scrollRef={handScroll}
                  onSelect={
                    room.phase === 'playing' && myTurn && canAct
                      ? (id) =>
                          setSelected((current) =>
                            current.includes(id)
                              ? current.filter((selectedId) => selectedId !== id)
                              : [...current, id],
                          )
                      : undefined
                  }
                />
                <p className="selection-hint">
                  {room.phase === 'playing'
                    ? selected.length
                      ? `${selected.length}张已选 · ${selectedCombo ? describeCombo(selectedCombo) : '请调整为合法牌型'}${selectedCombo && !validSelection ? '，还不能压过' : ''}`
                      : myTurn
                        ? '点牌选中，再点“出牌”'
                        : '先看看手牌，轮到您再选'
                    : room.phase === 'finished'
                      ? '剩余手牌'
                      : '看看手牌，再决定要不要当地主'}
                </p>
                {!inGame && voiceStatus.enabled && !voiceStatus.unlocked && !voiceStatus.error && (
                  <button className="voice-recover" onClick={unlockVoice}>
                    点一下，恢复报牌声音 ♪
                  </button>
                )}
              </section>
              {room.phase !== 'finished' && (
                <div
                  className={`action-dock ${room.phase === 'calling' || room.phase === 'robbing' ? 'rob-actions' : ''}`}
                >
                  <div className="action-turn" role="status">
                    {turnText}
                  </div>
                  {room.phase === 'bidding' ? (
                    <>
                      <button
                        className="button light"
                        disabled={!myTurn || !canAct}
                        onClick={() => act('bid', { value: 0 })}
                      >
                        不叫
                      </button>
                      {[1, 2, 3].map((value) => (
                        <button
                          key={value}
                          className="button primary"
                          disabled={!myTurn || !canAct || value <= room.highestBid}
                          onClick={() => act('bid', { value })}
                        >
                          {value} 分
                        </button>
                      ))}
                    </>
                  ) : room.phase === 'calling' || room.phase === 'robbing' ? (
                    <>
                      <button
                        className="button light"
                        disabled={!myTurn || !canAct}
                        onClick={() => act('rob', { yes: false })}
                      >
                        {room.phase === 'calling' ? '不叫' : '不抢'}
                      </button>
                      <button
                        className="button primary"
                        disabled={!myTurn || !canAct}
                        onClick={() => act('rob', { yes: true })}
                      >
                        {room.phase === 'calling' ? '叫地主' : '抢地主'}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="button light"
                        disabled={!myTurn || !canAct || !room.lastPlay}
                        onClick={() => act('pass')}
                      >
                        不出
                      </button>
                      <button className="button light" disabled={!myTurn || !canAct} onClick={hint}>
                        提示
                      </button>
                      <button
                        className="button primary"
                        disabled={!myTurn || !canAct || !validSelection}
                        onClick={() => act('play', { ids: selected })}
                      >
                        出牌{selected.length ? `（${selected.length}）` : ''}
                      </button>
                      <button
                        className="text-button clear-selection"
                        disabled={!selected.length}
                        onClick={() => setSelected([])}
                      >
                        重选
                      </button>
                    </>
                  )}
                </div>
              )}
            </>
          )}
          <footer className="room-footer">
            保持页面打开 · 掉线会保留座位 · 本桌积分在服务器重启后清空
          </footer>
        </main>
      )}
      {tableInfo && room && (
        <Modal title="这桌的情况" onClose={() => setTableInfo(false)}>
          <p className="modal-hint">
            房间 {room.roomId} · {PROFILES[room.profile].name}
          </p>
          <div className="score-list">
            {room.players.map((p) => (
              <div key={p.id}>
                <strong>
                  {p.name}
                  {p.id === room.youId ? '（您）' : ''}
                </strong>
                <span>
                  {p.id === room.landlordId ? '地主' : room.landlordId ? '农民' : '身份待定'} · 积分{' '}
                  {p.score >= 0 ? '+' : ''}
                  {p.score}
                </span>
                {room.bombLimits[p.id].limit !== null && (
                  <span>
                    炸弹 {room.bombLimits[p.id].used}/{room.bombLimits[p.id].limit}
                  </span>
                )}
              </div>
            ))}
          </div>
          {room.bottom.length > 0 && (
            <details className="bottom-cards">
              <summary>{room.mode === 'four' ? '您的8张底牌' : '本局3张底牌'}</summary>
              <div>
                {room.bottom.map((c) => (
                  <PlayingCard key={c.id} card={c} small />
                ))}
              </div>
            </details>
          )}
          <div className="table-info-actions">
            <button
              className="button light"
              onClick={() => {
                setTableInfo(false);
                setInvite(true);
              }}
            >
              邀请家人
            </button>
            <button
              className="button light"
              onClick={() => {
                setTableInfo(false);
                setHelp(true);
              }}
            >
              玩法说明
            </button>
            <button
              className="button light"
              onClick={() => {
                setTableInfo(false);
                setLeave(true);
              }}
            >
              离开牌桌
            </button>
          </div>
        </Modal>
      )}
      {connectionCheck && (
        <output className="connection-check" aria-label="连接诊断" data-route={transport.route}>
          {JSON.stringify(transport)}
        </output>
      )}
      {invite && (room || phoneInvite) && (
        <Modal
          title={phoneInvite ? '用手机扫码开桌' : '扫一扫，一起入座'}
          onClose={() => {
            setInvite(false);
            setPhoneInvite(false);
          }}
        >
          <p className="modal-description">
            {phoneInvite ? '房主用微信扫一扫，在手机上开桌，再邀请家人。' : '请家人用微信扫一扫，'}
            <br />
            {publicInvite
              ? 'Wi-Fi 或手机流量都能加入，无需安装软件。'
              : '所有手机和电脑连接同一个 Wi-Fi。'}
          </p>
          {qr && qrTarget ? (
            <img
              className="qr-image"
              src={qr}
              alt={phoneInvite ? '手机开桌二维码' : `房间${room?.roomId}的入座二维码`}
            />
          ) : (
            <div className="qr-placeholder">
              {qrTarget
                ? '正在生成二维码…'
                : publicMode
                  ? '公网入口暂时中断，请等待电脑恢复联网；恢复后二维码会自动显示。'
                  : '没有找到局域网地址，请连接 Wi-Fi 后刷新'}
            </div>
          )}
          {qr && qrTarget && (
            <a
              className="button light full"
              href={
                config.entryMode === 'temporary'
                  ? `/api/invite.png?${new URLSearchParams({
                      ...(phoneInvite ? {} : { room: room!.roomId }),
                    })}`
                  : qr
              }
              download="聚会斗地主-房间邀请.png"
            >
              {publicMode ? '保存二维码，分享给家人' : '保存邀请二维码'}
            </a>
          )}
          {!phoneInvite && room && (
            <>
              <div className="invite-code">
                <span>房间号</span>
                <strong>{room.roomId}</strong>
              </div>
              <p className="modal-description">
                {room.players.length} / {MODES[room.mode].players} 人已入座 ·{' '}
                {PROFILES[room.profile].name}
              </p>
            </>
          )}
          <details className="connection-help">
            <summary>扫码打不开？</summary>
            <p>
              {publicInvite ? (
                '请使用本次启动的二维码，确认手机和主机电脑都能上网。微信提示打不开时，可在手机浏览器尝试。'
              ) : (
                <>
                  先确认手机和电脑在同一个 Wi-Fi。如果电脑有多个网络地址，可切换后重扫。Windows
                  防火墙需要允许此游戏的端口通信。
                </>
              )}
            </p>
            {!publicMode && (
              <select
                aria-label="二维码访问地址"
                value={inviteBase}
                onChange={(e) => setInviteBase(e.target.value)}
              >
                {phoneEntryUrls(
                  {
                    ...config,
                    localUrls: [...config.localUrls, ...(localHost ? [] : [location.origin])],
                  },
                  'lan',
                ).map((url) => (
                  <option key={url} value={url}>
                    {url}
                  </option>
                ))}
              </select>
            )}
            <p>
              {publicMode
                ? '本次邀请在启动窗口关闭后结束；电脑重新启动后请分享新二维码。'
                : 'localhost 只能在这台电脑打开，手机请使用局域网地址。'}
            </p>
          </details>
          <button
            className="button primary full"
            onClick={() => {
              setInvite(false);
              setPhoneInvite(false);
            }}
          >
            {phoneInvite ? '关闭二维码' : '好了，回到牌桌'}
          </button>
        </Modal>
      )}
      {help && (
        <Modal title="慢慢玩，很简单" onClose={() => setHelp(false)}>
          <ol className="help-steps">
            <li>房主填称呼，选择人数，再点创建房间。</li>
            <li>
              {publicMode
                ? '家人用 Wi-Fi 或手机流量，微信扫码，填称呼加入。'
                : '家人连同一个 Wi-Fi，用微信扫码，填称呼加入。'}
            </li>
            <li>每人点准备。发牌后，轮流叫分或抢地主。</li>
            <li>轮到您时，点牌选中，再点出牌；不想跟牌就点不出。</li>
            <li>点提示可以帮您选牌。右上角“声音设置”可试听报牌、开关配乐。</li>
          </ol>
          <p className="help-note">
            二人、四人有地方变体，房主可在开桌前选择玩法。本桌规则：
            {room ? PROFILES[room.profile].summary : PROFILES[profile].summary}
          </p>
          <button className="button primary full" onClick={() => setHelp(false)}>
            明白了
          </button>
        </Modal>
      )}
      {soundSettings && (
        <Modal title="声音设置" onClose={() => setSoundSettings(false)}>
          <div className="sound-categories" role="group" aria-label="声音类别">
            <button
              className={soundCategory === 'voice' ? 'active' : ''}
              aria-pressed={soundCategory === 'voice'}
              onClick={() => setSoundCategory('voice')}
            >
              报牌与音色
            </button>
            <button
              className={soundCategory === 'music' ? 'active' : ''}
              aria-pressed={soundCategory === 'music'}
              onClick={() => setSoundCategory('music')}
            >
              配乐与音量
            </button>
          </div>
          {soundCategory === 'voice' && (
            <section className="sound-section">
              <h3>报牌声音</h3>
              <p>每个座位一种声音，出牌和“不出”都能听出来。</p>
              <button className="button primary full" onClick={toggleVoice}>
                {voiceStatus.enabled && voiceStatus.unlocked ? '关闭报牌声音' : '开启报牌声音'}
              </button>
              <div className="voice-seats">
                {VOICES.slice(0, room ? MODES[room.mode].players : 4).map((v, seat) => {
                  const player = room?.players.find((p) => p.seat === seat);
                  return (
                    <div className="voice-seat" key={v.id}>
                      <div>
                        <strong>
                          {player?.name ?? `第 ${seat + 1} 座`}
                          {player?.id === room?.youId && player ? '（您）' : ''}
                        </strong>
                        <span>{seatVoice(seat).label}</span>
                      </div>
                      <button
                        className="button light"
                        onClick={() => voice.preview(seat)}
                        aria-label={`试听第${seat + 1}座${v.label}`}
                      >
                        试听
                      </button>
                    </div>
                  );
                })}
              </div>
              <p className="sound-caption">试听内容：对皮蛋、ace、炸弹。身份提醒使用清楚的女声。</p>
              {soundLoading.phase === 'partial' && (
                <p className="sound-caption" role="status">
                  部分声音还没准备好，播放时会再试；仍可看文字继续玩。
                </p>
              )}
            </section>
          )}
          {soundCategory === 'music' && (
            <section className="sound-section">
              <h3>经典风格配乐</h3>
              <p>轻快拨弦小曲《家人围一桌》。</p>
              <p className="sound-caption" role="status">
                {musicStatus.playing
                  ? '配乐正在播放'
                  : musicStatus.enabled
                    ? '配乐等待播放'
                    : '配乐已关闭'}
              </p>
              <button
                className="button light full"
                onClick={() => (musicStatus.enabled ? music.stop() : music.start())}
              >
                {musicStatus.enabled ? '关闭配乐' : '开启配乐 ♪'}
              </button>
              {musicStatus.enabled && !musicStatus.playing && !musicStatus.error && (
                <button className="text-link music-recover" onClick={() => music.start()}>
                  点一下，播放配乐
                </button>
              )}
              <label className="music-volume" htmlFor="music-volume">
                配乐音量 <strong>{musicStatus.volume}%</strong>
              </label>
              <input
                id="music-volume"
                type="range"
                min="0"
                max="60"
                step="5"
                value={musicStatus.volume}
                onChange={(e) => music.setVolume(Number(e.target.value))}
              />
              <p className="sound-caption">报牌时配乐自动让声。围桌时建议只在一部手机开启配乐。</p>
            </section>
          )}
          <button className="button primary full" onClick={() => setSoundSettings(false)}>
            好了，继续玩
          </button>
        </Modal>
      )}
      {leave && room && (
        <Modal title="离开这桌？" onClose={() => setLeave(false)}>
          <p className="modal-description">
            {['waiting', 'finished'].includes(room.phase)
              ? '离开后，可以用房间号重新加入。'
              : '这一局还没结束。请先打完，或关闭弹窗继续。'}
          </p>
          <button className="button primary full" onClick={() => setLeave(false)}>
            继续在这桌
          </button>
          {['waiting', 'finished'].includes(room.phase) && (
            <button className="button light full" disabled={busy} onClick={() => act('leave-room')}>
              离开房间
            </button>
          )}
        </Modal>
      )}
    </div>
  );
}
