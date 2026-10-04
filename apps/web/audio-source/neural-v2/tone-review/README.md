# 未采用的男声声调实验

日期：2026-10-03。用户指出“勾”应读阴平，男声小样仍有声调不准及中气不足，随后明确要求具体声调后续调试。此目录均为实验原件，没有用于正式报牌。

- 原始单句：钩。／对钩。／三个钩。以同音字尝试规避多音字歧义，产品文案仍为勾。
- 来源：Microsoft Edge公开神经音色，edge-tts==7.2.8；male-xi为zh-CN-YunxiNeural，male-yang为zh-CN-YunyangNeural，语速+0%、音高+0Hz，详见design.json。
- MP3为生成原件，普通WAV为FFmpeg解码副本。
- 带-level的WAV为Praat/parselmouth 0.4.6的重合相加重合成实验，最后一段有声区的音高轨迹设为常值；云希185Hz、云扬135Hz。用70–400Hz范围、10ms分析步长定位有声区；不把基频分析当作发音听审通过。
- 对应试听位于public/audio/classic-v2/auditions/*-tone.mp3；未用于正式语音，仍需未来听审。正式312句来自neural-v2四个固定座位目录。
