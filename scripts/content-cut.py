#!/usr/bin/env python3
# Close matches of a search by content (docs/SEARCH.md "Close matches"): prints, for a list of everyday search words,
# the cosine of each picture's image vector to the words' text vector (LAION's ViT-B/32, as the apps compute them) and
# which pictures the cut in web/src/search/matches.json keeps. Without pictures it uses 25 real photos from the Play
# Store screenshots in the repository (docs/play/graphics/screenshots/raw: 01-timeline, 02-search, 04-album, each tile
# cut out). With --fixture it also writes e2e/fixtures/clip-images.json, the image vectors the web e2e search test uses.
#
#   python3 -m venv /tmp/v && /tmp/v/bin/pip install onnxruntime==1.31.1 numpy pillow tokenizers
#   /tmp/v/bin/python scripts/content-cut.py <folder with clip-b32-vision.onnx, clip-b32-text.onnx, clip-b32-tokenizer.json>
#   /tmp/v/bin/python scripts/content-cut.py <folder> <image>...      (your own photos: what the owner checks)
#   /tmp/v/bin/python scripts/content-cut.py <folder> --fixture
#
# The model files are those in server/models.json (checked here by SHA-256).
import hashlib
import json
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)

QUERIES = [
    "city", "beach", "snow", "mountains", "sea", "boat", "church", "castle", "northern lights", "skiing", "palm tree",
    "sunset", "lake", "bridge", "kites", "harbour", "night", "desert", "rocks", "clouds", "text", "sign", "bakery",
    "dog", "cat", "car", "food", "birthday cake", "person", "people", "baby", "screenshot", "document", "flowers",
    "dog on a beach", "city at night", "a photo of a city",
]

# The Play screenshots' photo tiles (in the screenshots' 900 × 2000 view; the files are 1080 × 2400): what each shows.
COLS = [(9, 295), (304, 591), (600, 887)]
SHOTS = {
    "t": ("01-timeline.png", [(358, 643), (653, 939), (948, 1234), (1244, 1530)]),
    "s": ("02-search.png", [(329, 614), (624, 910), (920, 1206), (1215, 1501)]),
    "a": ("04-album.png", [(1352, 1637)]),
}
SHOWS = {
    "t00": "Paris, a bridge at dusk", "t01": "Rio, city below mountains", "t02": "coast with a castle tower",
    "t10": "beach with kites at sunset", "t11": "beach with umbrellas", "t12": "harbour town with a church",
    "t20": "snowy mountains in a lake", "t21": "snowy mountain village", "t22": "ski slope with a chairlift",
    "t30": "green valley, hills", "t31": "coast with waves", "t32": "northern lights", "s01": "sea and a pier from above",
    "s02": "boat on a beach", "s10": "sandstone rocks", "s21": "cliff above the sea", "s30": "palm tree by a path",
    "a00": "mountains in clouds",
}
# the e2e test's photos (e2e/zzzzzzzzcontent.spec.ts): far apart in what they show
FIXTURE = {"northern lights": "t32", "beach umbrellas": "t11", "ski slope": "t22"}


def checked(folder, name):
    path = os.path.join(folder, name)
    with open(os.path.join(ROOT, "server", "models.json")) as f:
        want = next(m for m in json.load(f) if m["name"] == name)["sha256"]
    with open(path, "rb") as f:
        if hashlib.sha256(f.read()).hexdigest() != want:
            sys.exit(f"{name} isn't the file in server/models.json")
    return path


def close(scores, m):
    """web/src/search/matches.ts, for the same numbers"""
    if not scores:
        return 0
    best = scores[0]
    cut = max(m["min"], best - m["gap"])
    n = 0
    while n < len(scores) and scores[n] >= cut:
        n += 1
    if n == 0 and best >= m["floor"]:
        while n < len(scores) and n < m["few"] and scores[n] >= best - m["gap"]:
            n += 1
    return n


def main():
    import onnxruntime as ort
    from PIL import Image
    from tokenizers import Tokenizer

    folder = sys.argv[1]
    args = sys.argv[2:]
    fixture = "--fixture" in args
    paths = [a for a in args if a != "--fixture"]
    tok = Tokenizer.from_file(checked(folder, "clip-b32-tokenizer.json"))
    text = ort.InferenceSession(checked(folder, "clip-b32-text.onnx"), providers=["CPUExecutionProvider"])
    vision = ort.InferenceSession(checked(folder, "clip-b32-vision.onnx"), providers=["CPUExecutionProvider"])
    with open(os.path.join(ROOT, "web", "src", "search", "matches.json")) as f:
        m = json.load(f)

    def embed_text(s):
        ids = tok.encode(s).ids[:77]
        x = np.zeros((1, 77), dtype=np.int32)
        x[0, : len(ids)] = ids
        v = text.run(None, {"text": x})[0][0]
        return v / np.linalg.norm(v)

    def embed_image(im):
        im = im.convert("RGB")
        w, h = im.size
        s = 224 / min(w, h)
        im = im.resize((max(224, round(w * s)), max(224, round(h * s))), Image.BICUBIC)
        l, t = (im.width - 224) // 2, (im.height - 224) // 2
        x = np.asarray(im.crop((l, t, l + 224, t + 224)), dtype=np.float32) / 255
        v = vision.run(None, {"image": ((x - MEAN) / STD).transpose(2, 0, 1)[None].astype(np.float32)})[0][0]
        return v / np.linalg.norm(v)

    images = {}
    if paths:
        for p in paths:
            images[os.path.basename(p)] = embed_image(Image.open(p))
    else:
        for k, (name, rows) in SHOTS.items():
            shot = Image.open(os.path.join(ROOT, "docs", "play", "graphics", "screenshots", "raw", name))
            for r, (y0, y1) in enumerate(rows):
                for c, (x0, x1) in enumerate(COLS):
                    key = f"{k}{r}{c}"
                    if key not in SHOWS:
                        continue  # the same photo as another tile
                    box = tuple(round(v * 1.2) for v in (x0 + 4, y0 + 4, x1 - 4, y1 - 4))
                    images[key] = embed_image(shot.crop(box))

    print(f"cut: max({m['min']}, best - {m['gap']}); none: the best {m['few']} if the best is at least {m['floor']}")
    for q in QUERIES:
        v = embed_text(q)
        ranked = sorted(((float(v @ iv), k) for k, iv in images.items()), reverse=True)
        n = close([s for s, _ in ranked], m)
        kept = ", ".join(f"{SHOWS.get(k, k)} {s:.3f}" for s, k in ranked[:n]) or "no close matches"
        print(f"{q:18s} {kept}  |  next {ranked[n][0]:.3f}" if n < len(ranked) else f"{q:18s} {kept}")

    if fixture:
        out = {name: [round(float(x), 6) for x in images[key]] for name, key in FIXTURE.items()}
        with open(os.path.join(ROOT, "e2e", "fixtures", "clip-images.json"), "w") as f:
            json.dump(out, f)
        print("e2e/fixtures/clip-images.json written")


if __name__ == "__main__":
    main()
