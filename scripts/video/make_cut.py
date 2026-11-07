"""Cuts the raw WatchSeal recording into a <=3 minute demo video.

usage: python3 -P make_cut.py <video_dir> <title_card.jpg> <cover.jpg> <out.mp4>
Needs ffmpeg and Pillow, plus <video_dir>/fonts/InstrumentSans.ttf (Google Fonts, OFL).
Reads <video_dir>/raw/beats.json written by record-demo.mjs. Action segments play at 1x; waits for Walrus and
Claude are fast-forwarded (with an on-screen speed badge) to fit the time budget.
"""
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

VD, TITLE, COVER, OUT = Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
FONT = str(VD / "fonts" / "InstrumentSans.ttf")
W, H = 1920, 1080
TARGET = 179.0
TITLE_S, END_S = 3.5, 5.0
WORK = VD / "work"
WORK.mkdir(exist_ok=True)

INK, ICE = (15, 42, 54), (230, 238, 241)

# Caption shown while a segment plays, keyed by the beat that starts it.
# "<label>|done" is the segment right after a wait finishes.
CAPTIONS = {
    "landing": "WatchSeal watches Sui package upgrades and learns how your team triages them.",
    "landing: Cetus learning curve": "Real history. Cetus CLMM v9 to v15, replayed against Sui Mainnet. Memory changed 5 of 6 verdicts.",
    "dashboard": "Chain reads go through Tatum's Sui gRPC gateway. What it learns is stored in Walrus Memory.",
    "add Cetus": "Reading the Cetus package through Tatum gRPC.",
    "add Cetus|done": "The starting memories are already on Walrus Mainnet, each with a blob id.",
    "v10: next upgrade": "v10. Diffing the ABI and bytecode, recalling memories from Walrus, asking Claude.",
    "v10 analysis": "v10. Diffing the ABI and bytecode, recalling memories from Walrus, asking Claude.",
    "v10 analysis|done": "Critical. A new multisig signed it, and only memory knew who signed before.",
    "v10: transaction tab": "Full nodes pruned this 2025 transaction, so it came from archival GraphQL.",
    "v10 compare": "Re-running the same alert with zero memories.",
    "v10 compare|done": "Without memory it is high. Memory raised the risk one level.",
    "v10 label expected": "Expected. Two memories go to Walrus, the label and a newly trusted signer.",
    "v10 label expected|done": "Expected. Two memories go to Walrus, the label and a newly trusted signer.",
    "v11: next upgrade": "v11, exploit day. Waiting for the new memories to land on Walrus, then recalling.",
    "v11 analysis": "v11, exploit day. Waiting for the new memories to land on Walrus, then recalling.",
    "v11 analysis|done": "A bytecode-only change in config, signed by the now-trusted multisig. Rated low.",
    "v11 label suspicious": "The analyst flags it anyway.",
    "v11 label suspicious|done": "The analyst flags it anyway.",
    "rule": "Standing rules are memories too.",
    "rule saved": "Standing rules are memories too.",
    "rule saved|done": "Standing rules are memories too.",
    "v12: next upgrade": "v12. 38 new functions.",
    "v12 analysis": "v12. 38 new functions.",
    "v12 analysis|done": "The withdraw rule matched governance_fund_withdrawal. Critical.",
    "v12: memory influence": "Memory influence cites the rule and links its Walrus blob.",
    "v12 compare": "Without memory it would be high.",
    "v12 compare|done": "Without memory it would be high.",
    "v12 label expected": "Expected.",
    "v12 label expected|done": "Expected.",
    "v13: next upgrade": "v13. Bytecode churn in all 13 modules.",
    "v13 analysis": "v13. Bytecode churn in all 13 modules.",
    "v13 analysis|done": "Earlier labels already pull it down to low.",
    "v13 label false positive": "Marked a false positive. It looks like dependency relink noise.",
    "v13 label false positive|done": "Marked a false positive. It looks like dependency relink noise.",
    "v14: next upgrade": "v14. The same pattern again.",
    "v14 analysis": "v14. The same pattern again.",
    "v14 analysis|done": "Medium. Two labels pull it down, and the exploit-day label pulls it back up.",
    "v14 compare": "And without memory?",
    "v14 compare|done": "High without memory. Memory lowered it one level, to medium.",
    "v14: payoff gauge": "High without memory. Memory lowered it one level, to medium.",
    "v14: memory influence": "The v13 and v12 labels lower it. The v11 suspicious label on config keeps it above low.",
    "close: echogram": "The learning curve, drawn as an echo-sounder recording. The faint echo is the verdict without memory.",
    "ask the memory": "Ask the memory. A live semantic recall against Walrus.",
    "ask the memory|done": "Who may upgrade Cetus? The two trusted signers, nearest first.",
}


def font(size, weight="SemiBold"):
    f = ImageFont.truetype(FONT, size)
    f.set_variation_by_name(weight)
    return f


def wrap(draw, text, f, width):
    """Fewest lines that fit, then balanced so no line ends up holding a lone word."""
    words = text.split()
    n = 1
    while True:
        target = draw.textlength(text, font=f) / n
        lines, cur = [], ""
        for w in words:
            t = (cur + " " + w).strip()
            if cur and draw.textlength(t, font=f) > max(target * 1.08, 1) and len(lines) < n - 1:
                lines.append(cur)
                cur = w
            else:
                cur = t
        lines.append(cur)
        if all(draw.textlength(line, font=f) <= width for line in lines):
            return lines
        n += 1


def caption_png(text, speed, path):
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if text:
        f = font(36)
        lines = wrap(d, text, f, 1480)
        lh = 50
        bw = max(d.textlength(line, font=f) for line in lines) + 64
        bh = lh * len(lines) + 36
        x0, y0 = (W - bw) / 2, H - 70 - bh
        d.rounded_rectangle((x0, y0, x0 + bw, y0 + bh), radius=16, fill=INK + (232,))
        for i, line in enumerate(lines):
            d.text((W / 2, y0 + 18 + i * lh), line, font=f, fill=ICE, anchor="ma")
    if speed > 1.05:
        f2 = font(24, "Medium")
        label = f"fast-forward {speed:.0f}x"
        tw = d.textlength(label, font=f2)
        d.rounded_rectangle((W - tw - 72, 28, W - 28, 76), radius=24, fill=INK + (220,))
        d.polygon([(W - tw - 58, 42), (W - tw - 46, 52), (W - tw - 58, 62)], fill=ICE)
        d.text((W - tw - 40, 52), label, font=f2, fill=ICE, anchor="lm")
    im.save(path)


def end_card(path):
    im = Image.open(COVER).convert("RGB").resize((W, H), Image.LANCZOS)
    d = ImageDraw.Draw(im)
    x = W - 140
    d.text((x, 150), "WatchSeal", font=font(120, "SemiBold"), fill=INK, anchor="ra")
    d.text((x, 300), "Tatum for the chain. Walrus for the memory.", font=font(42, "Medium"), fill=(36, 67, 79), anchor="ra")
    d.text((x, 368), "github.com/0xNoramiya/watchseal", font=font(36, "Medium"), fill=(14, 107, 116), anchor="ra")
    im.save(path)


def run(args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


meta = json.loads((VD / "raw" / "beats.json").read_text())
raw, beats = meta["video"], meta["beats"]
# Playwright's recording runs slower than the wall clock the beats were logged with, at a
# steady rate. The video ends right after the final beat, so scale beat times to fit.
raw_dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", raw], capture_output=True, text=True).stdout.strip())
drift = raw_dur / beats[-1]["t"]
for b in beats:
    b["t"] *= drift
print(f"drift correction x{drift:.4f} (video {raw_dur:.1f}s, beats {beats[-1]['t'] / drift:.1f}s)")

# Build contiguous segments between beats.
segs = []
for i in range(len(beats) - 1):
    b, nxt = beats[i], beats[i + 1]
    dur = nxt["t"] - b["t"]
    if dur <= 0.05:
        continue
    if b["kind"] == "wait-start":
        key, is_wait = b["label"], True
    elif b["kind"] == "wait-end":
        key, is_wait = b["label"] + "|done", False
    else:
        key, is_wait = b["label"], False
    segs.append({"start": b["t"], "dur": dur, "wait": is_wait, "key": key})

action = sum(s["dur"] for s in segs if not s["wait"])
waits = [s for s in segs if s["wait"]]
wait_total = sum(s["dur"] for s in waits)
# Each wait plays at roughly 8x, kept between 1.2 and 6 seconds on screen.
for s in waits:
    shown = min(s["dur"], max(1.2, min(6.0, s["dur"] / 8)))
    s["speed"] = s["dur"] / shown
budget = sum(s["dur"] / s["speed"] for s in waits)
# If the actions alone would overflow the budget, play them a little faster too.
action_speed = max(1.0, action / (TARGET - TITLE_S - END_S - budget))
for s in segs:
    if not s["wait"]:
        s["speed"] = action_speed

parts = []
title = WORK / "title.mp4"
run(["ffmpeg", "-y", "-loop", "1", "-t", str(TITLE_S), "-i", TITLE, "-vf", f"scale={W}:{H},fps=30,fade=in:0:12,fade=out:st={TITLE_S - 0.5}:d=0.5", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", str(title)])
parts.append(title)
for i, s in enumerate(segs):
    cap = WORK / f"cap_{i:02d}.png"
    caption_png(CAPTIONS.get(s["key"], ""), s["speed"], cap)
    out = WORK / f"seg_{i:02d}.mp4"
    vf = f"[0:v]setpts=(PTS-STARTPTS)/{s['speed']:.4f},scale={W}:{H}:flags=lanczos,fps=30[v];[v][1:v]overlay=0:0"
    run(["ffmpeg", "-y", "-ss", f"{s['start']:.3f}", "-t", f"{s['dur']:.3f}", "-i", raw, "-i", str(cap), "-filter_complex", vf, "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", str(out)])
    parts.append(out)
    print(f"{i:02d} {s['key'][:34]:34} {s['dur']:6.1f}s x{s['speed']:.1f} -> {s['dur'] / s['speed']:5.1f}s")
end_png = WORK / "end.png"
end_card(str(end_png))
end = WORK / "end.mp4"
run(["ffmpeg", "-y", "-loop", "1", "-t", str(END_S), "-i", str(end_png), "-vf", f"fps=30,fade=in:0:12", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", str(end)])
parts.append(end)
lst = WORK / "concat.txt"
lst.write_text("".join(f"file '{p}'\n" for p in parts))
run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", "-movflags", "+faststart", OUT])
dur = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", OUT], capture_output=True, text=True).stdout.strip()
print(f"action {action:.1f}s at x{action_speed:.2f}, waits {wait_total:.1f}s into {budget:.1f}s, final {float(dur):.1f}s -> {OUT}")
