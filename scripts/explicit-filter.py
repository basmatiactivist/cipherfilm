#!/usr/bin/env python3
# The explicit-content filter of search (docs/SEARCH.md, "Explicit content"): writes server/explicit-filter.json (read
# by the web and Android apps when they are built) and mac/Sources/CipherfilmCore/ExplicitConcepts.swift (the Mac's
# copy; a test compares the two) with the text vectors of a fixed set of concepts, so no device runs the text model
# for it. With --check it prints the scores of the given images and of a list of everyday and explicit search words,
# to see how the thresholds below sit (results in docs/SEARCH.md).
#
#   python3 -m venv /tmp/v && /tmp/v/bin/pip install onnxruntime==1.31.1 numpy pillow tokenizers
#   /tmp/v/bin/python scripts/explicit-filter.py <folder with clip-b32-text.onnx and clip-b32-tokenizer.json>
#   /tmp/v/bin/python scripts/explicit-filter.py <folder, also with clip-b32-vision.onnx> --check <image>...
#
# The model files are those in server/models.json (checked here by SHA-256).
import base64
import hashlib
import json
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Hidden from search when the image's score (best explicit concept minus best neutral one, below) reaches this. The
# repository's harmless pictures (app screenshots, icons, flat colours, noise) score at most -0.006; skin-coloured
# blob shapes up to +0.028 (hidden: fine). Explicit photos can't be part of the repository: the owner checks this on
# real photos before a release (docs/SEARCH.md).
IMAGE_THRESHOLD = 0.01
# A search whose words score this much or more finds nothing (all concepts below, explicit against neutral).
QUERY_THRESHOLD = 0.03

# Both sides: what an explicit photo is (image) and what else a photo can be (neutral), worded like CLIP's captions.
EXPLICIT_IMAGE = [
    "a photo of a naked person", "a photo of a naked woman", "a photo of a naked man", "a nude photo of a woman",
    "a topless woman", "pornography", "a pornographic photo", "an explicit sexual photo", "people having sex",
    "a photo of genitals", "a photo of a penis", "a photo of breasts",
]
NEUTRAL_IMAGE = [
    "a photo of a person", "a photo of a woman", "a photo of a man", "a photo of people", "a portrait photo", "a selfie",
    "a photo of a child", "a photo of a baby", "a family photo", "a photo of a couple", "a photo of a person in a swimsuit",
    "a photo of people at the beach", "a photo of a person at the gym", "a photo of a wedding", "a photo of a party",
    "a landscape photo", "a photo of a city", "a photo of a building", "a photo of a room", "a photo of food",
    "a photo of an animal", "a photo of a pet", "a photo of flowers", "a photo of a car", "a photo of the sky",
    "a photo of an object", "a screenshot", "a screenshot of a phone app", "a user interface", "a photo of a document",
    "text", "a logo", "an icon", "a drawing", "a painting", "a statue", "a plain background", "an abstract pattern",
    "a blurry photo", "a dark photo",
]
# Search words only: single words people type, explicit and everyday ones that sound alike.
EXPLICIT_WORDS = [
    "nude", "naked", "nudity", "porn", "pornography", "sex", "sexual", "topless", "penis", "vagina", "breasts",
    "genitals", "nackt", "porno", "erotic", "xxx", "nsfw",
]
NEUTRAL_WORDS = [
    "beach", "dog", "cat", "food", "car", "flowers", "snow", "mountains", "city", "baby", "wedding", "party", "document",
    "selfie", "swimsuit", "bikini", "clothes", "dress", "shirtless man", "underwear", "lingerie", "bath", "shower", "bed",
    "statue", "painting", "body", "skin", "tattoo", "bird", "animal", "rat", "nail polish", "music band", "kiss", "hug",
    "couple", "gym", "yoga", "massage", "eye", "lipstick", "book", "x-ray",
]

# --check: how the thresholds sit
EVERYDAY_QUERIES = [
    "beach", "mountains", "snow", "sunset", "food", "dog", "cat", "car", "birthday cake", "flowers", "city at night",
    "document", "selfie", "forest", "lake", "swimming pool", "bikini", "baby", "baby in the bath", "kids playing",
    "wedding", "shirtless man at the beach", "sauna", "massage", "shower", "bed", "bedroom", "statue", "painting",
    "michelangelo david", "body", "skin", "tattoo", "yoga", "gym", "breastfeeding", "doctor", "kiss", "couple", "hug",
    "party", "dance", "underwear", "lingerie", "red dress", "naked mole rat", "nude color nail polish", "sex pistols",
    "sexy car", "hot dog", "beach volleyball", "bath", "pregnant belly", "sunbathing", "model", "strand", "hund", "katze",
    "geburtstag", "schnee", "berge", "essen", "hochzeit", "baden", "schwimmbad", "receipt", "passport", "whiteboard",
    "christmas tree", "fireworks", "horse", "bicycle", "airplane", "sushi", "pizza", "coffee", "mirror selfie", "dress",
    "feet", "legs", "hands", "chest x-ray", "anatomy", "adult", "love", "romantic dinner", "hotel room", "shirtless",
    "bra", "naked eye", "nude lipstick", "sex education book",
]
EXPLICIT_QUERIES = [
    "nudes", "naked woman", "naked man", "tits", "boobs", "blowjob", "dick pic", "nude selfie", "having sex", "orgasm",
    "explicit", "sexy naked girl", "naked girl", "nude beach", "sex tape", "porn video", "nacktbilder", "nacktfoto",
    "sexbilder", "titten", "nude woman on bed", "naked couple", "topless beach", "erect penis", "masturbation",
    "hardcore", "nipples", "naked body", "nude art", "stripper",
]

MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)


def model(name):
    with open(os.path.join(ROOT, "server", "models.json")) as f:
        return next(m for m in json.load(f) if m["name"] == name)


def checked(folder, name):
    p = os.path.join(folder, name)
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 22), b""):
            h.update(b)
    if h.hexdigest() != model(name)["sha256"]:
        sys.exit(f"{name}: not the file in server/models.json")
    return p


def b64(v):
    return base64.urlsafe_b64encode(v.astype("<f2").tobytes()).decode().rstrip("=")


def unb64(s):
    return np.frombuffer(base64.urlsafe_b64decode(s + "=" * (-len(s) % 4)), dtype="<f2").astype(np.float32)


def main():
    import onnxruntime as ort
    from tokenizers import Tokenizer

    folder = sys.argv[1]
    tok = Tokenizer.from_file(checked(folder, "clip-b32-tokenizer.json"))
    text = ort.InferenceSession(checked(folder, "clip-b32-text.onnx"), providers=["CPUExecutionProvider"])

    def embed(s):
        ids = tok.encode(s).ids[:77]
        x = np.zeros((1, 77), dtype=np.int32)
        x[0, : len(ids)] = ids
        v = text.run(None, {"text": x})[0][0]
        return v / np.linalg.norm(v)

    if "--check" in sys.argv:
        return check(folder, embed, sys.argv[sys.argv.index("--check") + 1 :])

    concepts = []
    for words, explicit, image in ((EXPLICIT_IMAGE, True, True), (NEUTRAL_IMAGE, False, True), (EXPLICIT_WORDS, True, False), (NEUTRAL_WORDS, False, False)):
        for w in words:
            concepts.append({"text": w, "explicit": explicit, "image": image, "vec": b64(embed(w))})
    out = {
        "note": "Generated by scripts/explicit-filter.py; docs/SEARCH.md, 'Explicit content'. vec: the concept's text vector "
        "(clip-b32-text.onnx, L2-normalised) as little-endian float16, base64url. An image is hidden from search when "
        "max(explicit, image) - max(neutral, image) of the cosines of its vector reaches image.threshold; a search finds "
        "nothing when that of its words' vector over all concepts reaches query.threshold.",
        "model": model("clip-b32-text.onnx")["sha256"],
        "image": {"threshold": IMAGE_THRESHOLD},
        "query": {"threshold": QUERY_THRESHOLD},
        "concepts": concepts,
    }
    with open(os.path.join(ROOT, "server", "explicit-filter.json"), "w") as f:
        head = {k: v for k, v in out.items() if k != "concepts"}
        f.write("{\n" + ",\n".join(f'  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}' for k, v in head.items()))
        f.write(',\n  "concepts": [\n' + ",\n".join("    " + json.dumps(c, ensure_ascii=False) for c in concepts) + "\n  ]\n}\n")
    swift = [
        "// Generated by scripts/explicit-filter.py from the same vectors as server/explicit-filter.json (a test compares",
        "// them): the explicit-content filter of search, docs/SEARCH.md \"Explicit content\". Don't edit by hand.",
        "enum ExplicitConcepts {",
        f"  static let imageThreshold: Float = {IMAGE_THRESHOLD}",
        f"  static let queryThreshold: Float = {QUERY_THRESHOLD}",
        "  /** (explicit, image, the text vector as little-endian float16, base64url) */",
        "  static let all: [(explicit: Bool, image: Bool, vec: String)] = [",
    ]
    swift += [f'    ({str(c["explicit"]).lower()}, {str(c["image"]).lower()}, "{c["vec"]}"), // {c["text"]}' for c in concepts]
    swift += ["  ]", "}", ""]
    with open(os.path.join(ROOT, "mac", "Sources", "CipherfilmCore", "ExplicitConcepts.swift"), "w") as f:
        f.write("\n".join(swift))
    print(f"{len(concepts)} concepts written")


def margin(v, concepts, image_only):
    use = [c for c in concepts if c["image"] or not image_only]
    e = max(float(v @ c["v"]) for c in use if c["explicit"])
    n = max(float(v @ c["v"]) for c in use if not c["explicit"])
    return e - n


def check(folder, embed, images):
    import onnxruntime as ort
    from PIL import Image

    with open(os.path.join(ROOT, "server", "explicit-filter.json")) as f:
        filt = json.load(f)
    concepts = filt["concepts"]
    for c in concepts:
        c["v"] = unb64(c["vec"])
        c["v"] /= np.linalg.norm(c["v"])
    vision = ort.InferenceSession(checked(folder, "clip-b32-vision.onnx"), providers=["CPUExecutionProvider"])
    rows = []
    for p in images:
        try:
            im = Image.open(p).convert("RGB")
        except Exception:
            continue
        w, h = im.size
        s = 224 / min(w, h)
        im = im.resize((max(224, round(w * s)), max(224, round(h * s))), Image.BICUBIC)
        l, t = (im.width - 224) // 2, (im.height - 224) // 2
        x = np.asarray(im.crop((l, t, l + 224, t + 224)), dtype=np.float32) / 255
        v = vision.run(None, {"image": ((x - MEAN) / STD).transpose(2, 0, 1)[None].astype(np.float32)})[0][0]
        rows.append((margin(v / np.linalg.norm(v), concepts, True), p))
    t = filt["image"]["threshold"]
    for m, p in sorted(rows, reverse=True):
        print(f"image {m:+.4f} {'HIDDEN' if m >= t else 'shown '} {p}")
    qt = filt["query"]["threshold"]
    for label, qs in (("everyday", EVERYDAY_QUERIES), ("explicit", EXPLICIT_QUERIES)):
        scored = sorted(((margin(embed(q), concepts, False), q) for q in qs), reverse=True)
        blocked = [q for m, q in scored if m >= qt]
        print(f"{label} queries: {len(blocked)} of {len(qs)} blocked: {blocked}")
        print("  scores: " + ", ".join(f"{q} {m:+.3f}" for m, q in scored))


if __name__ == "__main__":
    main()
