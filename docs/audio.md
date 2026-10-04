# 声音方案与素材维护

版本：0.3.0；制作日期：2026-10-03。

## 已确认的方向

用户希望有熟悉的斗地主配乐和接近商业游戏的自然短句报牌，接受短时间加载，按座位区分音色。J／Q／K／A叫勾／皮蛋／凯／ace；本人回合用明显视觉和短音替换口播；地主确定后各自手机播报本人身份。

本轮小晓女声方向被认可。男声新小样声调与力度未通过，用户明确指出勾应读阴平，并要求具体声调后续再调、先上线其他功能。当前保留既有男声参数，只更新已确认叫法。未通过的样本与声调实验仍保留，不用于正式报牌；不能将整套听感标为已获认可。

## 操作与分配

右上角“声音设置”有“报牌与音色”“配乐与音量”两个大按钮。报牌默认开启，入座点击或试听点击用于取得浏览器播放许可。每座“试听”播放对皮蛋、ace、炸弹；报牌关闭后可重新开启。短提示音跟随报牌开关，关闭后仍保留文字和回合高亮。刷新后保留原座位，必要时点恢复声音。

| 座位  | 显示名称    | 生成音色             | 语速 |
| ----- | ----------- | -------------------- | ---- |
| 第1座 | 男声 · 爽朗 | zh-CN-YunxiNeural    | +5%  |
| 第2座 | 女声 · 亲切 | zh-CN-XiaoxiaoNeural | +9%（音高+2Hz） |
| 第3座 | 男声 · 浑厚 | zh-CN-YunjianNeural  | +2%  |
| 第4座 | 女声 · 明快 | zh-CN-XiaoyiNeural   | +6%  |

同一玩家在所有手机上使用同一座位音色，刷新或短时重连保持座位。准备、叫分、出牌、不出按服务端事件操作者播放。结束叫分包含末次动作和地主宣布的有序片段，分别保留操作者；后者在本机映射为“您是地主／您是农民”，使用统一小晓女声。结束旧阶段时清理尚未播放的旧阶段提示，保护末次动作及身份不会被新出牌挤掉。发牌、流程提示和结算尾句继续使用统一女声。这些是AI合成配音。

回合短音独立于语音队列，Web Audio本机生成880Hz正弦音，约220毫秒；不支持时用静态MP3。只对本人新回合播放一次，离线、换轮、后台与退出立即停止；刷新、重连和返回页面只建立当前状态，不补播旧提醒。短音与报牌期间配乐让声。声音不能成为唯一提示。

配乐《家人围一桌》为本项目原创，108 BPM、16小节、约35.56秒循环，五声音阶拨弦旋律配低音与轻打击。每部手机默认关闭；开启后记住偏好，默认音量25%，可调0%至60%。多人围桌时建议只在一部手机开配乐。报牌时增益降低至设定值的18%；缺少Web Audio时在报牌期间暂停音乐。切后台暂停并丢弃旧播报，返回时按浏览器许可恢复，必要时点击播放入口。

## 加载与兼容

首页预取少量试听，本桌按人数预取所需音色，每套78句；不会阻止填写称呼、扫码入座、准备或出牌。最多6并发，请求5秒超时，整次预取8秒预算。失败后结束加载状态；实际播报可重试相同自然音色，最终失败则显示恢复按钮并保留文字提示。牌局首屏不显示大块加载进度，声音设置中可查加载状态。

运行用MP3共1,489,856字节（约1.42 MiB），含四套312句、短音与沿用配乐，不含历史资源和制作试听；三人／二人桌会减少完整音色下载。首页、二维码和游戏脚本先显示，预取资源作为Blob复用；路径带版本，服务端提供30天immutable缓存与Range支持。再次访问的实际加载时间取决于手机、缓存和网络。

## 来源与固定路径

- 文案：`scripts/voice-lines.json`，78句。单张／对子／三张结尾用感叹号；勾以同音“钩”、ace以Ace作为合成文本，详见设计中的phoneticOverrides，不能据此宣称声调已调试完成。
- 当前设计与版本：`scripts/game-voices-v2.json`。生成工具edge-tts==7.2.8，经微软Edge在线神经语音服务制作，只在素材制作时使用；游玩播放项目静态资源。
- 当前原件：`apps/web/audio-source/neural-v2/{voice}/`，312句；设计和文案快照为此目录design.json／voice-lines.json。未改声线且同文案的素材从v1复用，其余重新生成。
- 历史神经原件：`apps/web/audio-source/neural-v1/{voice}/`，304句及4段初版试听，保留历史design.json／voice-lines.json，最初设计为scripts/neural-voices.json。
- 首版原件：`apps/web/public/audio/*.wav`，保留76段Microsoft Huihui Desktop系统合成语音。
- 配乐原件：`apps/web/audio-source/family-table.wav`；原创音符、乐器合成与可重复生成代码：`scripts/generate-classic-audio.mjs`。
- 当前成品：`apps/web/public/audio/classic-v2/voices/{voice}/{clip}.mp3` 和 `classic-v2/turn.mp3`；配乐继续用classic-v1/music/family-table.mp3，历史声音仍保留。
- 回合短音原件：`apps/web/audio-source/turn-cue.wav`，本项目原创；波形公式与MP3后处理见scripts/generate-classic-audio.mjs。
- 制作试听：neural-v2中strong、bright、male-xi、male-yang和tone-review均有原件或设计记录；classic-v2/auditions是试听成品，没有加入正式报牌预加载。
- 后处理：剪去首尾静音、保留80ms尾部、统一响度，单声道24kHz／40kbps报牌；配乐22.05kHz／64kbps。

参考来源：[微软音色列表](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support)、[edge-tts源项目与接口约束](https://github.com/rany2/edge-tts)。记录生成来源不等同于真人配音或商业游戏原声授权；若改用外部录音，应保存使用范围与授权记录。

## 重建

已有生成原件时，只需本机安装FFmpeg并执行 `npm run audio:generate`，不会联网重新合成。

需要重新生成神经配音时，先创建本机临时Python环境（不提交依赖），再安装固定版本并生成：

```powershell
py -3.12 -m venv tmp/audio-tools
& .\tmp\audio-tools\Scripts\python.exe -m pip install -r scripts/audio-tools-requirements.txt
& .\tmp\audio-tools\Scripts\python.exe scripts/generate-neural-voice.py --samples
& .\tmp\audio-tools\Scripts\python.exe scripts/generate-neural-voice.py
npm run audio:generate
npm test
npm run build
```

脚本默认读取game-voices-v2.json，跳过已有完整原件，先写临时文件再保存成品。v1禁止重新合成覆盖；已有正式原件的版本中，文案、音色或发音参数改变会要求新sourceVersion／assetVersion。后续声调调试建立v3，保留当前原件并更新设计、播放器、缓存路由与来源文档。旧Windows系统合成命令只补历史缺失WAV，不覆盖现存原件。

## 真机试玩重点

Android微信和iPhone微信均需检查：首次扫码试听、三分／末次叫分与本人身份、短提示音只在本机响、关闭／恢复声音、第三／第四座差异、勾／皮蛋／凯／ace、特殊炸弹、配乐音量与让声、刷新、切后台返回和断网恢复。长称呼与系统大字也需现场核对。结果记入testing.md，桌面检查不能替代真机。
