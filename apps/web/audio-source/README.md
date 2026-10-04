# 声音原件

此目录保存正式声音素材原件，纳入Git，不直接发布到网页。

- `neural-v1/`：历史304句报牌及4段试听样本；原文案、设计快照保留在此目录，最初设计为scripts/neural-voices.json。
- `neural-v2/`：当前312句报牌／身份语音，含design.json和voice-lines.json；来自微软Edge公共神经音色、edge-tts==7.2.8，既有男声和第4座同文案素材复用v1原件，新女声和新增文案重新生成。
- `neural-v2/tone-review/`：未采用的男声阴平实验，来源和处理见其README.md；具体声调按用户要求延后。
- `turn-cue.wav`：项目原创880Hz／220毫秒短提示音，生成公式见scripts/generate-classic-audio.mjs。
- `family-table.wav`：原创曲《家人围一桌》的PCM原件；乐谱和合成代码在 `scripts/generate-classic-audio.mjs`。

来源、操作、重建和真机验证事项见 `docs/audio.md`。旧系统WAV继续保存在 `apps/web/public/audio/`，更新时保留历史原件。
