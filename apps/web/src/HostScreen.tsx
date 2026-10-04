import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  isPublicEntry,
  phoneEntryUrls,
  phoneLanUrls,
  phonePublicUrl,
  type EntryConfig,
} from './phone-links.js';

export function HostScreen() {
  const [urls, setUrls] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  const [qr, setQr] = useState('');
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [config, setConfig] = useState<EntryConfig>({ publicBaseUrl: null, localUrls: [] });
  const [shareMessage, setShareMessage] = useState('');
  const publicMode = isPublicEntry(config);
  const targetPublic = publicMode && !!target && target === phonePublicUrl(config);
  const entryReady =
    connected &&
    !!target &&
    (!targetPublic || config.publicStatus === 'ready' || config.entryMode !== 'temporary');

  useEffect(() => {
    let active = true;
    const controllers = new Set<AbortController>();
    setLoading(true);
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
        const config: EntryConfig = await response.json();
        if (!Array.isArray(config.localUrls)) throw new Error();
        const options = phoneEntryUrls(config, 'lan');
        if (!active) return;
        setConfig(config);
        setUrls(options);
        setTarget((current) => (options.includes(current) ? current : (options[0] ?? '')));
        setConnected(true);
        setError('');
      } catch {
        if (active) {
          setConnected(false);
          setError('没有连接到电脑主机。请重新运行“启动游戏”，再检查连接。');
        }
      } finally {
        clearTimeout(timer);
        controllers.delete(controller);
        if (active) setLoading(false);
      }
    }
    void check();
    const interval = window.setInterval(() => {
      if (!document.hidden) void check();
    }, 10_000);
    return () => {
      active = false;
      clearInterval(interval);
      for (const controller of controllers) controller.abort();
    };
  }, [attempt]);

  useEffect(() => {
    let active = true;
    setQr('');
    setShareMessage('');
    if (entryReady && target) {
      QRCode.toDataURL(target, {
        width: 440,
        margin: 4,
        errorCorrectionLevel: 'M',
        color: { dark: '#163e31', light: '#ffffff' },
      })
        .then((image) => {
          if (active) setQr(image);
        })
        .catch(() => {
          if (active) setError('二维码暂时没有生成，请点“重新检查连接”。');
        });
    }
    return () => {
      active = false;
    };
  }, [entryReady, target, attempt]);

  return (
    <div className={`app host-app ${publicMode ? 'host-public' : ''}`}>
      <header className="topbar host-topbar">
        <div className="brand">
          <span className="brand-mark">♠</span>
          <span>
            聚会斗地主<small>家人围一桌</small>
          </span>
        </div>
        <span className={`connection host-status ${entryReady ? 'online' : ''}`} role="status">
          <i />
          {loading
            ? '正在准备'
            : !connected
              ? '主机未连接'
              : publicMode
                ? config.publicStatus === 'ready'
                  ? '同一 Wi-Fi／公网已就绪'
                  : '同一 Wi-Fi 可玩 · 公网中断'
                : '电脑主机已连接'}
        </span>
      </header>
      <main className="host-main">
        <section className="host-heading">
          <span className="eyebrow">电脑做主机 · 家人用手机玩</span>
          <h1>
            用微信扫一扫，
            <br className="host-mobile-break" />
            手机上开桌
          </h1>
          <p>
            {publicMode
              ? '在家扫同一 Wi-Fi 码，连接更快；远方家人扫异地码，也能坐同一桌。'
              : '所有手机和这台电脑连接同一个 Wi-Fi。'}
          </p>
        </section>
        <div className="host-content">
          <section className="host-qr-card" aria-label="手机进入游戏主页">
            {publicMode && phoneLanUrls(config).length > 0 && (
              <div className="invite-networks" aria-label="选择扫码网络">
                <button
                  className={`button ${!targetPublic ? 'primary' : 'light'}`}
                  onClick={() => setTarget(phoneLanUrls(config)[0])}
                >
                  同一 Wi-Fi · 更快
                </button>
                <button
                  className={`button ${targetPublic ? 'primary' : 'light'}`}
                  disabled={!phonePublicUrl(config)}
                  onClick={() => setTarget(phonePublicUrl(config) ?? '')}
                >
                  异地／流量
                </button>
              </div>
            )}
            {qr && !error && entryReady ? (
              <img className="host-qr-image" src={qr} alt="游戏主页二维码" />
            ) : (
              <div className="host-qr-placeholder" role="status">
                {error ||
                  (loading
                    ? '正在准备二维码…'
                    : config.entryMode === 'temporary' && !entryReady
                      ? '公网入口暂时中断，请保持启动窗口打开并检查电脑联网。恢复后二维码会自动显示。'
                      : connected && !target
                        ? '请先让电脑连接家里的 Wi-Fi，再点下面重新检查。'
                        : '正在生成二维码…')}
              </div>
            )}
            <h2>{targetPublic ? '异地／流量扫码，进入同一桌' : '同一 Wi-Fi 扫码，连接更快'}</h2>
            <p>第一位家人和后来的人都可以扫这个码。</p>
            {publicMode && qr && entryReady && !error && (
              <div className="host-share">
                <a
                  className="button primary"
                  href={
                    config.entryMode === 'temporary'
                      ? `/api/invite.png?${new URLSearchParams(!targetPublic ? { network: 'lan', address: target } : {})}`
                      : qr
                  }
                  download="聚会斗地主-本次邀请.png"
                >
                  保存二维码
                </a>
                <button
                  className="button light"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(target);
                      setShareMessage('邀请链接已复制，可以发给家人。');
                    } catch {
                      setShareMessage('暂时无法复制，请保存二维码分享给家人。');
                    }
                  }}
                >
                  复制邀请链接
                </button>
                <p role="status">
                  {shareMessage ||
                    (targetPublic
                      ? '保存这个码，发给远方家人。'
                      : '这个码用于同一 Wi-Fi；发给远方家人请先点“异地／流量”。')}
                </p>
              </div>
            )}
          </section>
          <section className="host-steps" aria-label="扫码后怎样入座">
            <div className="host-step">
              <span className="host-step-number">1</span>
              <div>
                <h2>第一位家人先开桌</h2>
                <p>
                  扫码进入主页，填称呼、选人数，
                  <br />
                  在手机上点“创建房间”。
                </p>
              </div>
            </div>
            <div className="host-step">
              <span className="host-step-number">2</span>
              <div>
                <h2>其他家人接着入座</h2>
                <p>
                  扫电脑上的主页码，点家人开的桌；
                  <br />
                  或扫房主手机上的房间码直接加入。
                </p>
              </div>
            </div>
            <div className="host-reminder">
              <strong>{publicMode ? '本次邀请，关闭窗口后结束' : '电脑页面一直保留就好'}</strong>
              <p>
                游玩时保持电脑开机{publicMode ? '联网' : ''}、启动窗口打开。
                <br />
                {publicMode
                  ? '重新启动后，请分享新的二维码。'
                  : '打完后关闭启动窗口，结束本次游戏。'}
              </p>
            </div>
          </section>
        </div>
        <div className="host-network">
          <button
            className="button light"
            onClick={() => setAttempt((value) => value + 1)}
            disabled={loading}
          >
            重新检查连接
          </button>
          <details className="connection-help host-connection-help">
            <summary>扫码打不开？</summary>
            <p>
              {targetPublic ? (
                '请确认电脑和手机都能上网，并使用本次启动的新二维码。若微信提示打不开，可先在手机浏览器尝试。'
              ) : (
                <>
                  先确认手机没有使用移动流量，和电脑连的是同一个
                  Wi-Fi。若仍打不开，可换一个网络地址再扫。
                </>
              )}
            </p>
            {urls.length > 1 && (
              <label>
                选择网络地址
                <select value={target} onChange={(event) => setTarget(event.target.value)}>
                  {urls.map((url, index) => (
                    <option key={url} value={url}>
                      地址{index + 1} · {url}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {target && (
              <p className="host-address">
                当前二维码地址：
                <a href={target} target="_blank" rel="noreferrer">
                  {target}
                </a>
              </p>
            )}
            <p>
              {publicMode
                ? '临时入口需要电脑一直联网。入口恢复后会自动展示二维码；若联网组件已退出，请按启动窗口提示重新开桌。'
                : '家庭 Wi-Fi 不要使用访客网络；Windows 提示网络访问时，允许游戏在家庭网络使用。'}
            </p>
          </details>
        </div>
      </main>
    </div>
  );
}
