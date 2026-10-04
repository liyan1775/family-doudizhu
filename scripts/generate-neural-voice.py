"""离线素材制作：仅将公共报牌文案发送给微软神经语音服务，游玩时不联网合成。"""
import argparse
import asyncio
import json
import shutil
from pathlib import Path

import edge_tts

ROOT = Path(__file__).resolve().parents[1]
LINES = json.loads((ROOT / "scripts/voice-lines.json").read_text(encoding="utf-8"))


async def main(samples_only: bool, design_path: str):
    design = json.loads((ROOT / design_path).read_text(encoding="utf-8"))
    if design.get("sourceVersion", "neural-v1") == "neural-v1":
        raise RuntimeError("neural-v1 is preserved history. Use a new sourceVersion for new material.")
    source = ROOT / "apps/web/audio-source" / design.get("sourceVersion", "neural-v1")
    source.mkdir(parents=True, exist_ok=True)
    saved_design = source / "design.json"
    saved_lines = source / "voice-lines.json"
    has_production = any(any((source / voice["id"]).glob("*.mp3")) for voice in design["voices"])
    if has_production and saved_design.exists() and saved_lines.exists():
        previous_design = json.loads(saved_design.read_text(encoding="utf-8"))
        previous_lines = json.loads(saved_lines.read_text(encoding="utf-8"))
        if previous_design["voices"] != design["voices"] or previous_lines != LINES or previous_design.get("phoneticOverrides") != design.get("phoneticOverrides"):
            raise RuntimeError("Published source parameters changed. Create a new sourceVersion and assetVersion.")
    (source / "design.json").write_text(json.dumps(design, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (source / "voice-lines.json").write_text(json.dumps(LINES, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    reuse = ROOT / "apps/web/audio-source" / design.get("reuseVersion", "missing")
    old_lines = json.loads((reuse / "voice-lines.json").read_text(encoding="utf-8")) if (reuse / "voice-lines.json").exists() else {}
    old_design = json.loads((reuse / "design.json").read_text(encoding="utf-8")) if (reuse / "design.json").exists() else {}
    semaphore = asyncio.Semaphore(3)
    completed = 0

    def spoken_text(voice, key, text):
        text = design.get("phoneticOverrides", {}).get(key, text)
        # 语速和音高以已采用参数为准；男声的进一步声调调整另行听审。
        emphatic = key.startswith(("single-", "pair-", "triple-"))
        if emphatic and text.endswith("。"):
            text = text[:-1] + "！"
        return text

    async def generate(voice, key, text):
        nonlocal completed
        folder = source / voice["id"]
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / f"{key}.mp3"
        partial = folder / f"{key}.part.mp3"
        if target.exists() and target.stat().st_size > 1000:
            return
        old_voice = next((v for v in old_design.get("voices", []) if v["id"] == voice["id"]), None)
        previous = reuse / voice["id"] / f"{key}.mp3"
        if not samples_only and old_voice == voice and old_lines.get(key) == LINES.get(key) and key not in design.get("phoneticOverrides", {}) and previous.exists():
            shutil.copyfile(previous, target)
            return
        async with semaphore:
            for attempt in range(3):
                try:
                    speaker = edge_tts.Communicate(text, voice["voice"], rate=voice["rate"], pitch=voice["pitch"],
                                                   connect_timeout=15, receive_timeout=30)
                    await speaker.save(str(partial))
                    if partial.stat().st_size < 1000:
                        raise RuntimeError(f"Empty audio: {partial}")
                    partial.replace(target)
                    completed += 1
                    if samples_only or completed % 20 == 0:
                        print(f"Generated {completed}: {voice['id']}/{key}", flush=True)
                    return
                except Exception:
                    if attempt == 2:
                        raise
                    await asyncio.sleep(1 + attempt)

    tasks = []
    for voice in design.get("samples", design["voices"]) if samples_only else design["voices"]:
        if samples_only:
            tasks.append(generate(voice, "audition", voice.get("text", design.get("sampleText", "对皮蛋！炸弹！"))))
        else:
            for key, text in LINES.items():
                tasks.append(generate(voice, key, spoken_text(voice, key, text)))
    await asyncio.gather(*tasks)
    print("Neural voice generation finished.", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", action="store_true")
    parser.add_argument("--design", default="scripts/game-voices-v2.json")
    args = parser.parse_args()
    asyncio.run(main(args.samples, args.design))
