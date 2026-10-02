# 试玩语音

来源：本机 Windows 系统语音 `Microsoft Huihui Desktop`，通过 `System.Speech` 离线生成普通话 WAV。

生成日期：2026-10-03。用途：家庭试玩和播放兼容性验证。

- 文案保存在 `scripts/voice-lines.json`。
- 重建命令：`npm run voice:generate`（Windows，需要该中文系统音色）。
- 格式：16kHz、16位、单声道 PCM WAV。
- 报牌使用“对三”“大王”“三带二”“炸弹”等短句；J/Q/K/A 使用钩、圈、凯、尖的扑克牌口语。
- 音色是系统合成试玩音色。正式上线时可按同一文件名替换为有明确使用授权的录音，播放器和规则事件无需修改。
