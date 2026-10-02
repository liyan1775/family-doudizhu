import { useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
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

interface Config {
  publicBaseUrl: string | null;
  localUrls: string[];
}
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
  const className = `playing-card ${red ? 'red' : ''} ${small ? 'small' : ''} ${selected ? 'selected' : ''} ${card.rank > 15 ? 'joker' : ''}`;
  return onClick ? (
    <button
      type="button"
      className={className}
      onClick={onClick}
      aria-label={label}
      aria-pressed={selected}
    >
      {content}
    </button>
  ) : (
    <span className={className} aria-label={label}>
      {content}
    </span>
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
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
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
  const [leave, setLeave] = useState(false);
  const [config, setConfig] = useState<Config>({ publicBaseUrl: null, localUrls: [] });
  const [inviteBase, setInviteBase] = useState('');
  const [qr, setQr] = useState('');
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const [voice] = useState(() => new VoicePlayer());
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>({
    enabled: voice.enabled,
    unlocked: false,
    error: false,
  });
  const seenEvent = useRef<number | null>(null);
  const previousTurn = useRef<string | null>(null);
  const latestRoom = useRef<RoomView | null>(null);
  latestRoom.current = room;

  useEffect(() => {
    voice.onStatus = setVoiceStatus;
    const s = io({ autoConnect: true, reconnection: true });
    setSocket(s);
    s.on('connect', () => {
      setConnected(true);
      setReplaced(false);
      const session = readSession();
      if (session)
        s.timeout(6000).emit(
          'resume-room',
          session,
          (error: Error | null, result: Ack<Session>) => {
            if (error) {
              setMessage('恢复房间超时，请刷新页面重试');
              return;
            }
            if (!result.ok) {
              if (readSession()?.token === session.token) localStorage.removeItem(SESSION_KEY);
              setRoom(null);
              seenEvent.current = null;
              if (new URLSearchParams(location.search).get('room') === session.roomId) {
                history.replaceState(null, '', '/');
                setRoomNumber('');
              }
              setMessage(result.error ?? '请重新入座');
            }
          },
        );
    });
    s.on('disconnect', () => setConnected(false));
    s.on('connect_error', () => setConnected(false));
    s.on('session-replaced', () => {
      // 同一站点的页面共享身份；保留令牌，另一页面刷新后仍能恢复座位。
      setReplaced(true);
      setRoom(null);
      setInvite(false);
      seenEvent.current = null;
    });
    s.on('room-state', (state: RoomView) => {
      const firstState = seenEvent.current === null || latestRoom.current?.roomId !== state.roomId;
      if (!firstState && seenEvent.current !== state.event.id) {
        voice.play(state.event.audio);
        if (
          state.turnId === state.youId &&
          previousTurn.current !== state.turnId &&
          state.players.every((p) => p.online)
        )
          voice.play(['your-turn']);
      }
      seenEvent.current = state.event.id;
      previousTurn.current = state.turnId;
      setRoom(state);
      setSelected((current) => current.filter((id) => state.hand.some((c) => c.id === id)));
    });
    fetch('/api/config')
      .then((r) => r.json())
      .then((data: Config) => {
        setConfig(data);
        const sorted = [...data.localUrls].sort(
          (a, b) => Number(!a.includes('192.168.')) - Number(!b.includes('192.168.')),
        );
        const base = data.publicBaseUrl || (localHost ? sorted[0] || '' : location.origin);
        setInviteBase(base);
      })
      .catch(() => setMessage('读取连接地址失败，稍后可刷新重试'));
    return () => {
      s.disconnect();
      voice.dispose();
    };
  }, [voice]);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(''), 8000);
    return () => clearTimeout(timer);
  }, [message]);
  const joinUrl = room && inviteBase ? `${inviteBase}/?room=${room.roomId}` : '';
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
    setBusy(true);
    setMessage('');
    try {
      await request(event, payload);
      if (event === 'play' || event === 'pass') setSelected([]);
      if (event === 'leave-room') {
        localStorage.removeItem(SESSION_KEY);
        setRoom(null);
        setLeave(false);
        seenEvent.current = null;
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
  async function enter(create: boolean) {
    if (!name.trim()) {
      setMessage('先填写您的称呼，方便家人认出您');
      document.getElementById('player-name')?.focus();
      return;
    }
    if (!create && !/^\d{6}$/.test(roomNumber)) {
      setMessage('请填写6位房间号');
      return;
    }
    if (voice.enabled && !voice.unlocked) voice.unlock();
    setBusy(true);
    setMessage('');
    try {
      const session = await request<Session>(create ? 'create-room' : 'join-room', {
        name,
        mode,
        profile,
        roomId: roomNumber,
      });
      if (session) {
        setPhoneInvite(false);
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
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
    document.getElementById('your-hand')?.scrollIntoView({ behavior: 'auto', block: 'center' });
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
  const myTurn = room?.turnId === room?.youId;
  const allOnline = room?.players.every((p) => p.online) ?? true;
  const canAct = connected && !busy && allOnline;
  const turnName = room?.players.find((p) => p.id === room.turnId)?.name;
  const voiceLabel =
    voiceStatus.unlocked && voiceStatus.enabled
      ? '声音已开'
      : voiceStatus.enabled
        ? '开启声音'
        : '声音已关';
  const toggleVoice = () =>
    voiceStatus.enabled && voiceStatus.unlocked ? voice.mute() : voice.unlock();

  return (
    <div className={room ? 'app in-room' : 'app'}>
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
            聚会斗地主<small>家人围一桌</small>
          </span>
        </a>
        <div className="top-actions">
          <span className={`connection ${connected ? 'online' : ''}`}>
            <i />
            {connected ? '已连接' : '连接中'}
          </span>
          <button className="sound-button" onClick={toggleVoice}>
            <span>{voiceStatus.unlocked && voiceStatus.enabled ? '♪' : '♫'}</span>
            {voiceLabel}
          </button>
          <button className="help-button" onClick={() => setHelp(true)} aria-label="玩法说明">
            ?
          </button>
        </div>
      </header>
      {voiceStatus.error && (
        <div className="notice">声音暂时没有播放，请点右上角“开启声音”重新试听。</div>
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
                  手机和开桌的电脑
                  <br />
                  连接同一个 Wi-Fi
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
        <main className="room-page">
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
            style={{ '--players': MODES[room.mode].players } as React.CSSProperties}
          >
            {Array.from({ length: MODES[room.mode].players }, (_, seat) => {
              const p = room.players.find((p) => p.seat === seat);
              return (
                <div
                  key={seat}
                  className={`player-seat ${p?.id === room.turnId ? 'current' : ''} ${!p ? 'empty' : ''} ${p && !p.online ? 'offline-seat' : ''}`}
                >
                  <div className="avatar">{p ? [...p.name][0] : '+'}</div>
                  <strong>
                    {p ? `${p.name}${p.id === room.youId ? '（您）' : ''}` : '等家人'}
                  </strong>
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
                  <small>{p ? `积分 ${p.score >= 0 ? '+' : ''}${p.score}` : '空座位'}</small>
                  {p && room.bombLimits[p.id].limit !== null && (
                    <small>
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
              <section className="table">
                <div className="table-top">
                  <span>
                    {room.phase === 'bidding'
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
                <div className="turn-banner" aria-live="polite">
                  {!allOnline
                    ? '有家人暂时离线，等回来后继续'
                    : room.phase === 'finished'
                      ? room.event.text
                      : myTurn
                        ? room.phase === 'playing'
                          ? '轮到您出牌'
                          : '轮到您叫地主'
                        : `等${turnName ?? '家人'}${room.phase === 'playing' ? '出牌' : '叫地主'}`}
                </div>
                <div className="last-play">
                  {room.lastPlay ? (
                    <>
                      <p>
                        {room.players.find((p) => p.id === room.lastPlay?.playerId)?.name} ·{' '}
                        {describeCombo(room.lastPlay.combo)}
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
                    您的手牌 <span>{room.hand.length}张</span>
                  </h2>
                  <span>
                    {room.landlordId === room.youId
                      ? '地主'
                      : room.landlordId
                        ? '农民'
                        : '身份待定'}
                  </span>
                </div>
                <div className="hand-cards">
                  {room.hand.map((card) => (
                    <PlayingCard
                      key={card.id}
                      card={card}
                      selected={selected.includes(card.id)}
                      onClick={
                        room.phase === 'playing' && myTurn && canAct
                          ? () =>
                              setSelected((current) =>
                                current.includes(card.id)
                                  ? current.filter((id) => id !== card.id)
                                  : [...current, card.id],
                              )
                          : undefined
                      }
                    />
                  ))}
                </div>
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
                {voiceStatus.enabled && !voiceStatus.unlocked && (
                  <button className="voice-recover" onClick={() => voice.unlock()}>
                    点一下，恢复报牌声音 ♪
                  </button>
                )}
              </section>
              {room.phase !== 'finished' && (
                <div className="action-dock">
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
            所有手机和电脑连接同一个 Wi-Fi。
          </p>
          {qr ? (
            <img
              className="qr-image"
              src={qr}
              alt={phoneInvite ? '手机开桌二维码' : `房间${room?.roomId}的入座二维码`}
            />
          ) : (
            <div className="qr-placeholder">
              {qrTarget ? '正在生成二维码…' : '没有找到局域网地址，请连接 Wi-Fi 后刷新'}
            </div>
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
              先确认手机和电脑在同一个 Wi-Fi。如果电脑有多个网络地址，可切换后重扫。Windows
              防火墙需要允许此游戏的端口通信。
            </p>
            <select
              aria-label="二维码访问地址"
              value={inviteBase}
              onChange={(e) => setInviteBase(e.target.value)}
            >
              {[
                ...new Set(
                  [config.publicBaseUrl, location.origin, ...config.localUrls].filter(
                    (x): x is string => !!x,
                  ),
                ),
              ].map((url) => (
                <option key={url} value={url}>
                  {url}
                </option>
              ))}
            </select>
            <p>localhost 只能在这台电脑打开，手机请使用局域网地址。</p>
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
            <li>家人连同一个 Wi-Fi，用微信扫码，填称呼加入。</li>
            <li>每人点准备。发牌后，轮流叫分或抢地主。</li>
            <li>轮到您时，点牌选中，再点出牌；不想跟牌就点不出。</li>
            <li>点提示可以帮您选牌。右上角可开启或关闭报牌声音。</li>
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
