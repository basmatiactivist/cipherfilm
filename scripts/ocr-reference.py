#!/usr/bin/env python3
"""The reference for text in photos (docs/SEARCH.md "Text in photos"): the same steps the Android app (Ocr.kt) and the
Mac app (Ocr.swift) take, written plainly, so their output can be checked against it.

    python3 -I scripts/ocr-reference.py <models dir> <image>...      prints the text found and the time per image
    python3 -I scripts/ocr-reference.py <models dir> --fixture <out.png>   draws the test picture the apps' tests use

Needs onnxruntime, numpy and pillow. The models dir holds ocr-det-v3.onnx, ocr-rec-latin-v5.onnx and
ocr-latin-dict.txt (server/models.json).
"""
import sys
import time

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw, ImageFont

DET_SIDE = 960          # the longest side the detector sees (multiples of 32)
DET_MEAN = (0.485, 0.456, 0.406)
DET_STD = (0.229, 0.224, 0.225)
BIN = 0.3               # a pixel is text above this
BOX = 0.6               # a region is kept when its mean is at least this
UNCLIP = 1.5            # regions grow by area * UNCLIP / perimeter on every side
MIN_SIDE = 3            # regions smaller than this (detector pixels) are dropped
REC_H = 48
REC_MAX_W = 960         # a line wider than this (after scaling to 48 px high) is squeezed
REC_MIN_SCORE = 0.5     # a line's mean character confidence
MAX_LINES = 40


def det_input(img: Image.Image):
    w, h = img.size
    s = min(1.0, DET_SIDE / max(w, h))
    nw, nh = max(32, round(w * s / 32) * 32), max(32, round(h * s / 32) * 32)
    a = np.asarray(img.convert("RGB").resize((nw, nh), Image.BILINEAR), dtype=np.float32) / 255.0
    a = a[:, :, ::-1]  # BGR, as the model was trained (OpenCV order); the mean and std are applied in that order
    a = (a - np.array(DET_MEAN, np.float32)) / np.array(DET_STD, np.float32)
    return a.transpose(2, 0, 1)[None].copy(), nw, nh


def regions(prob: np.ndarray):
    """Connected text pixels (4-neighbours), as axis-aligned boxes with their mean probability, in reading order."""
    h, w = prob.shape
    on = prob > BIN
    seen = np.zeros_like(on)
    out = []
    for y in range(h):
        for x in range(w):
            if not on[y, x] or seen[y, x]:
                continue
            stack = [(y, x)]
            seen[y, x] = True
            x0 = x1 = x
            y0 = y1 = y
            total = 0.0
            n = 0
            while stack:
                cy, cx = stack.pop()
                total += prob[cy, cx]
                n += 1
                x0, x1, y0, y1 = min(x0, cx), max(x1, cx), min(y0, cy), max(y1, cy)
                for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
                    if 0 <= ny < h and 0 <= nx < w and on[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
            bw, bh = x1 - x0 + 1, y1 - y0 + 1
            if min(bw, bh) < MIN_SIDE or total / n < BOX:
                continue
            d = bw * bh * UNCLIP / (2 * (bw + bh))
            out.append((x0 - d, y0 - d, x1 + 1 + d, y1 + 1 + d))
    out.sort(key=lambda b: (round(b[1] / 8), b[0]))
    return out


def rec_input(crop: Image.Image):
    w, h = crop.size
    if h > w * 1.5:  # standing text: turned to read left to right
        crop = crop.transpose(Image.ROTATE_90)
        w, h = crop.size
    nw = max(8, min(REC_MAX_W, round(w * REC_H / h)))
    a = np.asarray(crop.convert("RGB").resize((nw, REC_H), Image.BILINEAR), dtype=np.float32) / 255.0
    a = (a[:, :, ::-1] - 0.5) / 0.5
    return a.transpose(2, 0, 1)[None].copy()


def ctc(logits: np.ndarray, chars):
    idx = logits.argmax(1)
    prob = logits.max(1)
    out, scores, last = [], [], 0
    for i, p in zip(idx, prob):
        if i != 0 and i != last:
            out.append(chars[i - 1] if i - 1 < len(chars) else " ")
            scores.append(p)
        last = i
    return "".join(out), (float(np.mean(scores)) if scores else 0.0)


def normalize(lines):
    """One line of words, as stored: whitespace collapsed."""
    return " ".join(" ".join(lines).split())


class Ocr:
    def __init__(self, d):
        o = ort.SessionOptions()
        o.intra_op_num_threads = 2
        self.det = ort.InferenceSession(f"{d}/ocr-det-v3.onnx", o)
        self.rec = ort.InferenceSession(f"{d}/ocr-rec-latin-v5.onnx", o)
        self.chars = open(f"{d}/ocr-latin-dict.txt", encoding="utf-8").read().split("\n")
        if self.chars and self.chars[-1] == "":
            self.chars.pop()

    def read(self, img: Image.Image):
        img = img.convert("RGB")
        x, nw, nh = det_input(img)
        prob = self.det.run(None, {"x": x})[0][0, 0]
        sx, sy = img.width / nw, img.height / nh
        lines = []
        for (x0, y0, x1, y1) in regions(prob)[:MAX_LINES]:
            box = (max(0, int(x0 * sx)), max(0, int(y0 * sy)), min(img.width, int(np.ceil(x1 * sx))), min(img.height, int(np.ceil(y1 * sy))))
            if box[2] - box[0] < 4 or box[3] - box[1] < 4:
                continue
            logits = self.rec.run(None, {"x": rec_input(img.crop(box))})[0][0]
            text, score = ctc(logits, self.chars)
            if score >= REC_MIN_SCORE and text.strip():
                lines.append(text.strip())
        return lines


def fixture(path):
    """The apps' test picture: a sign, a line in German with umlauts and a small one, on a photo-like background."""
    img = Image.new("RGB", (1200, 800), (70, 110, 150))
    d = ImageDraw.Draw(img)
    for y in range(800):
        d.line([(0, y), (1200, y)], fill=(70 + y // 10, 110 + y // 20, 150 - y // 12))
    bold = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
    reg = "/System/Library/Fonts/Supplemental/Arial.ttf"
    d.rectangle([140, 120, 1060, 330], fill=(245, 240, 225))
    d.text((180, 160), "BAKERY OPEN", font=ImageFont.truetype(bold, 110), fill=(30, 30, 30))
    d.text((150, 450), "Zürich Hauptbahnhof Gleis 7", font=ImageFont.truetype(reg, 64), fill=(255, 255, 255))
    d.text((150, 600), "Fresh bread daily", font=ImageFont.truetype(reg, 40), fill=(240, 240, 240))
    img.save(path)


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[2] == "--fixture":
        fixture(sys.argv[3])
        sys.exit(0)
    ocr = Ocr(sys.argv[1])
    for p in sys.argv[2:]:
        im = Image.open(p)
        t = time.perf_counter()
        lines = ocr.read(im)
        ms = (time.perf_counter() - t) * 1000
        print(f"{p}: {ms:.0f} ms, {len(lines)} lines")
        print("  " + normalize(lines))
