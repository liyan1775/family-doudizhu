# 声音素材与来源

当前0.3.0使用 `classic-v2/voices/` 四套神经配音及 `classic-v2/turn.mp3` 短提示音，配乐继续使用 `classic-v1/music/` 原创曲。来源、参数与重建见 `docs/audio.md`，当前设计见 `scripts/game-voices-v2.json`。

- 神经配音：微软Edge公开音色云希、小晓、云健、晓伊，使用 `edge-tts==7.2.8` 制作，每套78句。女声小晓采用认可小样参数；男声声调调试延后，保留既有参数。
- 当前生成原件保存在 `apps/web/audio-source/neural-v2/`，文案与设计快照随原件保存。勾使用同音“钩”作为合成文本，ace用Ace；产品叫法和牌面没有因此改变。
- v1素材、原件、76句历史文案与设计均保留。未通过的男声试听和实验短音保留供后续参考，没有用于正式报牌。
- 回合短音为项目原创880Hz、220毫秒单音，Web Audio在本机立即播放；不支持时使用turn.mp3，原始WAV为audio-source/turn-cue.wav。
- 原创曲《家人围一桌》由 `scripts/generate-classic-audio.mjs` 生成；原始WAV在 `apps/web/audio-source/family-table.wav`，发布MP3在 `classic-v1/music/`。
- 生成日期：2026-10-03。音色为AI合成，整套听感与微信真机效果待验证。

## 保留的首版系统语音

来源：本机 Windows 系统语音 `Microsoft Huihui Desktop`，通过 `System.Speech` 离线生成普通话 WAV。

生成日期：2026-10-03。用途：家庭试玩和播放兼容性验证。

- 历史文案快照为 `apps/web/audio-source/neural-v1/voice-lines.json`，当前文案为 `scripts/voice-lines.json`。
- 历史补全命令：`npm run voice:generate`（Windows，需要该中文系统音色），只补缺失WAV，不覆盖历史原件。
- 格式：16kHz、16位、单声道 PCM WAV。
- 报牌使用“对三”“大王”“三带二”“炸弹”等短句；J/Q/K/A 使用钩、圈、凯、尖的扑克牌口语。
- 根目录WAV保留为0.1.0历史原件。当前播放器读取版本目录内的MP3；后续更换素材应创建新资源版本并记录来源，保留现有原件。
