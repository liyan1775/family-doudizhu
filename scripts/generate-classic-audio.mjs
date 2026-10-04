// 原创五声音阶小曲及四套神经配音。保留合成原件，只发布处理后的 MP3。
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const audio = resolve(root, 'apps/web/public/audio');
const design = JSON.parse(readFileSync(resolve(root, 'scripts/game-voices-v2.json'), 'utf8'));
const output = join(audio, design.assetVersion);
const lines = JSON.parse(readFileSync(resolve(root, 'scripts/voice-lines.json'), 'utf8'));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0)
    throw new Error(result.error?.message || result.stderr || `${command} failed`);
}
const originals = resolve(root, 'apps/web/audio-source');
const banks = design.voices;
const filter =
  'silenceremove=start_periods=1:start_duration=0.005:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_duration=0.005:start_threshold=-50dB,areverse,apad=pad_dur=0.08,loudnorm=I=-16:TP=-1.5:LRA=7';
function encode(source, destination, bitrate = '40k', audioFilter = filter) {
  run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    source,
    '-af',
    audioFilter,
    '-ar',
    '24000',
    '-ac',
    '1',
    '-c:a',
    'libmp3lame',
    '-b:a',
    bitrate,
    '-map_metadata',
    '-1',
    destination,
  ]);
}
for (const bank of banks) {
  const folder = join(output, 'voices', bank.id);
  mkdirSync(folder, { recursive: true });
  for (const key of Object.keys(lines)) {
    encode(
      join(originals, design.sourceVersion, bank.id, `${key}.mp3`),
      join(folder, `${key}.mp3`),
    );
  }
  console.log(`${bank.id}: ${Object.keys(lines).length} clips`);
}
mkdirSync(join(output, 'auditions'), { recursive: true });
for (const sample of design.samples ?? []) {
  const original = join(originals, design.sourceVersion, sample.id, 'audition.mp3');
  if (existsSync(original)) encode(original, join(output, 'auditions', `${sample.id}.mp3`), '48k');
}

// 与浏览器振荡器一致的原创单音，供不支持 Web Audio 的设备使用。
const cueRate = 24000;
const cueLength = Math.round(0.22 * cueRate);
const cueWav = Buffer.alloc(44 + cueLength * 2);
cueWav.write('RIFF');
cueWav.writeUInt32LE(cueWav.length - 8, 4);
cueWav.write('WAVEfmt ', 8);
cueWav.writeUInt32LE(16, 16);
cueWav.writeUInt16LE(1, 20);
cueWav.writeUInt16LE(1, 22);
cueWav.writeUInt32LE(cueRate, 24);
cueWav.writeUInt32LE(cueRate * 2, 28);
cueWav.writeUInt16LE(2, 32);
cueWav.writeUInt16LE(16, 34);
cueWav.write('data', 36);
cueWav.writeUInt32LE(cueLength * 2, 40);
for (let i = 0; i < cueLength; i++) {
  const t = i / cueRate;
  const gain =
    t < 0.015
      ? 0.0001 * 1300 ** (t / 0.015)
      : t < 0.2
        ? 0.13 * (0.0001 / 0.13) ** ((t - 0.015) / 0.185)
        : 0;
  cueWav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 880 * t) * gain * 32767), 44 + i * 2);
}
const cueOriginal = join(originals, 'turn-cue.wav');
if (!existsSync(cueOriginal)) writeFileSync(cueOriginal, cueWav);
encode(cueOriginal, join(output, 'turn.mp3'), '48k', 'anull');

// 16 小节、108 BPM，拨弦旋律、低音和轻打击。音符为本项目原创。
const sampleRate = 22050;
const beat = 60 / 108;
const duration = 64 * beat;
const samples = new Float64Array(Math.ceil(duration * sampleRate));
const melody = [
  [67, 69, 72, 74, 72, 69, 67, 64],
  [67, 67, 64, 62, 64, 67, 69, 72],
  [74, 76, 74, 72, 69, 72, 74, 69],
  [67, 64, 62, 64, 67, 69, 67, 0],
  [72, 74, 76, 79, 76, 74, 72, 69],
  [67, 69, 72, 69, 67, 64, 62, 64],
  [67, 72, 69, 74, 72, 69, 67, 64],
  [62, 64, 67, 69, 67, 64, 62, 0],
  [67, 69, 72, 74, 76, 74, 72, 69],
  [72, 69, 67, 64, 67, 69, 72, 0],
  [74, 76, 79, 76, 74, 72, 69, 72],
  [67, 69, 67, 64, 62, 64, 67, 0],
  [72, 76, 74, 72, 69, 72, 67, 69],
  [74, 72, 69, 67, 64, 67, 69, 72],
  [67, 69, 72, 74, 72, 69, 67, 64],
  [62, 64, 67, 69, 67, 0, 67, 0],
];
function note(midi, time, length, amplitude, bass = false) {
  if (!midi) return;
  const start = Math.round(time * sampleRate);
  const count = Math.round(length * sampleRate);
  const frequency = 440 * 2 ** ((midi - 69) / 12);
  for (let i = 0; i < count && start + i < samples.length; i++) {
    const t = i / sampleRate;
    const attack = Math.min(1, t / 0.008);
    const release = Math.min(1, (length - t) / 0.035);
    const envelope = attack * release * Math.exp(-t * (bass ? 4 : 8));
    const angle = 2 * Math.PI * frequency * t;
    const tone =
      Math.sin(angle) + 0.3 * Math.sin(2 * angle) + (bass ? 0 : 0.14 * Math.sin(3 * angle));
    samples[start + i] += amplitude * envelope * tone;
  }
}
function tap(time, strong) {
  const start = Math.round(time * sampleRate);
  let seed = start + 17;
  for (let i = 0; i < 0.08 * sampleRate && start + i < samples.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    const t = i / sampleRate;
    const noise = ((seed >>> 0) / 2 ** 32) * 2 - 1;
    samples[start + i] +=
      (strong ? 0.065 * Math.sin(2 * Math.PI * 100 * t) : 0.025 * noise) *
      Math.exp(-t * 65) *
      Math.min(1, t / 0.003);
  }
}
const basses = [48, 48, 53, 55, 48, 57, 53, 55, 48, 57, 53, 55, 48, 53, 55, 48];
for (let bar = 0; bar < melody.length; bar++) {
  for (let n = 0; n < 8; n++) note(melody[bar][n], (bar * 4 + n / 2) * beat, beat * 0.48, 0.24);
  for (let n = 0; n < 4; n++) {
    note(basses[bar] + (n % 2 ? 7 : 0), (bar * 4 + n) * beat, beat * 0.8, 0.16, true);
    tap((bar * 4 + n) * beat, n % 2 === 0);
    if (n % 2) note(basses[bar] + 12, (bar * 4 + n + 0.5) * beat, beat * 0.3, 0.07);
  }
}
const wav = Buffer.alloc(44 + samples.length * 2);
wav.write('RIFF');
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVE', 8);
wav.write('fmt ', 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(samples.length * 2, 40);
for (let i = 0; i < samples.length; i++)
  wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
const originalMusic = join(originals, 'family-table.wav');
mkdirSync(originals, { recursive: true });
if (!existsSync(originalMusic)) writeFileSync(originalMusic, wav);
const musicFolder = join(audio, 'classic-v1', 'music');
mkdirSync(musicFolder, { recursive: true });
if (!existsSync(join(musicFolder, 'family-table.mp3')))
  run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    originalMusic,
    '-c:a',
    'libmp3lame',
    '-b:a',
    '64k',
    '-map_metadata',
    '-1',
    join(musicFolder, 'family-table.mp3'),
  ]);
function size(folder) {
  return readdirSync(folder, { withFileTypes: true }).reduce(
    (sum, item) =>
      sum +
      (item.isDirectory() ? size(join(folder, item.name)) : statSync(join(folder, item.name)).size),
    0,
  );
}
console.log(`Classic audio download: ${(size(output) / 1024 / 1024).toFixed(2)} MiB`);
