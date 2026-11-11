#!/usr/bin/env python3
# Reference vectors for search (docs/SEARCH.md): LAION's OpenCLIP ViT-B/32 run through ONNX
# Runtime with the documented preprocessing (shortest side to 224 with PIL's bicubic, centre crop, CLIP mean and std;
# text as int32 [1, 77] padded with 0). Tests/CipherfilmCoreTests/LaionParityTests.swift compares the Mac with these.
#   pip install onnxruntime==1.31.1 numpy pillow
#   python3 scripts/laion-reference.py <folder with clip-b32-*.onnx> <out.json> <image>...
import json
import sys

import numpy as np
import onnxruntime as ort
from PIL import Image

MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)
# CLIP token ids (the same table as SearchTests.tokenizerIds)
TEXTS = {
    "a dog": [49406, 320, 1929, 49407],
    "sunset over mountains": [49406, 3424, 962, 5873, 49407],
    "A photo of a DOG on the beach!": [49406, 320, 1125, 539, 320, 1929, 525, 518, 2117, 256, 49407],
}


def image_input(path):
    im = Image.open(path).convert("RGB")  # no EXIF rotation and no colour matching, as the apps decode
    w, h = im.size
    s = 224 / min(w, h)
    im = im.resize((max(224, round(w * s)), max(224, round(h * s))), Image.BICUBIC)
    l, t = (im.width - 224) // 2, (im.height - 224) // 2
    x = np.asarray(im.crop((l, t, l + 224, t + 224)), dtype=np.float32) / 255
    return ((x - MEAN) / STD).transpose(2, 0, 1)[None].astype(np.float32)


def main():
    models, out, images = sys.argv[1], sys.argv[2], sys.argv[3:]
    vision = ort.InferenceSession(f"{models}/clip-b32-vision.onnx", providers=["CPUExecutionProvider"])
    text = ort.InferenceSession(f"{models}/clip-b32-text.onnx", providers=["CPUExecutionProvider"])
    ref = {"ort": ort.__version__, "images": {}, "texts": {}}
    for p in images:
        ref["images"][p] = vision.run(None, {"image": image_input(p)})[0][0].tolist()
    for t, ids in TEXTS.items():
        x = np.zeros((1, 77), dtype=np.int32)
        x[0, : len(ids)] = ids
        ref["texts"][t] = text.run(None, {"text": x})[0][0].tolist()
    with open(out, "w") as f:
        json.dump(ref, f)


if __name__ == "__main__":
    main()
