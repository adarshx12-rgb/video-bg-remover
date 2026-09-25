"""Compare fp16 / int8 weight-compressed withoutBG against the full model on real frames.

Input follows the app's contract (src/lib/models/withoutbg.ts): longest side to 448,
top-left on black, RGB float32 [0,1] NCHW. Metrics use the letterboxed region only.

Usage: put full.onnx, fp16.onnx and int8.onnx next to a frames/ folder of test images,
run it from that folder, and look at compare/contact-sheet.jpg.
"""
import glob
import os
import time

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw

SIZE = 448
VARIANTS = ['full', 'fp16', 'int8']


def letterbox(path):
    img = Image.open(path).convert('RGB')
    scale = SIZE / max(img.size)
    w, h = max(1, round(img.width * scale)), max(1, round(img.height * scale))
    small = img.resize((w, h), Image.BILINEAR)
    box = Image.new('RGB', (SIZE, SIZE))
    box.paste(small, (0, 0))
    x = np.asarray(box, dtype=np.float32).transpose(2, 0, 1)[None] / 255.0
    return small, x, w, h


def checker(w, h, cell=12):
    yy, xx = np.mgrid[0:h, 0:w]
    c = (((yy // cell) + (xx // cell)) % 2).astype(np.float32)
    return (0.84 + 0.12 * c)[..., None] * 255


def composite(small, alpha):
    rgb = np.asarray(small, dtype=np.float32)
    a = alpha[..., None]
    return Image.fromarray((rgb * a + checker(*small.size) * (1 - a)).astype(np.uint8))


def diff_image(d):
    # 0 -> black, 32/255 or more -> bright red
    v = np.clip(d / (32 / 255), 0, 1)
    return Image.fromarray(np.stack([v * 255, v * 40, v * 40], -1).astype(np.uint8))


sessions = {}
for v in VARIANTS:
    t = time.perf_counter()
    sessions[v] = ort.InferenceSession(f'{v}.onnx', providers=['CPUExecutionProvider'])
    print(f'{v}: session created in {time.perf_counter() - t:.1f}s')

os.makedirs('compare', exist_ok=True)
rows, times = [], {v: [] for v in VARIANTS}
print(f"\n{'frame':<12}{'variant':<7}{'mean diff /255':>15}{'99th pct':>10}{'max':>7}{'>10/255':>9}{'fg/bg flips':>12}")
for path in sorted(glob.glob('frames/*')):
    name = os.path.splitext(os.path.basename(path))[0]
    small, x, w, h = letterbox(path)
    alphas = {}
    for v in VARIANTS:
        t = time.perf_counter()
        out = sessions[v].run(['alpha'], {'rgb': x})[0]
        times[v].append(time.perf_counter() - t)
        alphas[v] = np.clip(out[0, 0, :h, :w], 0, 1)
    for v in ['fp16', 'int8']:
        d = np.abs(alphas[v] - alphas['full'])
        flips = np.mean((alphas[v] >= 0.5) != (alphas['full'] >= 0.5))
        print(f'{name:<12}{v:<7}{d.mean() * 255:>15.2f}{np.percentile(d, 99) * 255:>10.1f}{d.max() * 255:>7.0f}{np.mean(d > 10 / 255) * 100:>8.2f}%{flips * 100:>11.3f}%')
    tiles = [small, composite(small, alphas['full']), composite(small, alphas['fp16']), composite(small, alphas['int8']),
             diff_image(np.abs(alphas['int8'] - alphas['full']))]
    rows.append((name, tiles))

print('\nCPU time per frame (onnxruntime, this machine):', {v: f'{np.mean(t[1:] or t):.2f}s' for v, t in times.items()})

# One contact sheet: source | full | fp16 | int8 | int8 difference (red = bigger)
labels = ['source', 'full 433 MB', 'fp16 217 MB', 'int8 110 MB', 'int8 vs full difference']
tile_w = 300
pad, head = 8, 24
scaled = [[t.resize((tile_w, round(t.height * tile_w / t.width))) for t in tiles] for _, tiles in rows]
height = head + sum(r[0].height + pad for r in scaled)
sheet = Image.new('RGB', (len(labels) * (tile_w + pad) + pad, height), (32, 34, 33))
draw = ImageDraw.Draw(sheet)
for i, label in enumerate(labels):
    draw.text((pad + i * (tile_w + pad), 6), label, fill=(230, 230, 230))
y = head
for r in scaled:
    for i, t in enumerate(r):
        sheet.paste(t, (pad + i * (tile_w + pad), y))
    y += r[0].height + pad
sheet.save('compare/contact-sheet.jpg', quality=90)
for (name, tiles) in rows:
    big = Image.new('RGB', (sum(t.width for t in tiles[1:4]), tiles[0].height))
    xo = 0
    for t in tiles[1:4]:
        big.paste(t, (xo, 0))
        xo += t.width
    big.save(f'compare/{name}-full-fp16-int8.jpg', quality=92)
print('saved compare/contact-sheet.jpg')
