# The models Cipherfilm uses, and where they come from

Cipherfilm's search ("beach", "dog") and its people view run open machine-learning models **on your devices**: the
Android app, the Mac app and, for turning search words into a vector, the web app. No photo, face or search word is
sent to anyone for this; the server only stores the results, encrypted (docs/SEARCH.md, docs/CRYPTO.md).

This page says which models those are, who made them, under which license, how we got the exact files, and what we
checked. How they are used is in docs/SEARCH.md.

## The files

Each device downloads the files once, directly from **Hugging Face**, where these open models are published, at a
URL pinned to a fixed commit of the model's repository (`https://huggingface.co/<repo>/resolve/<commit>/<path>`, never
a branch). Hugging Face answers with a redirect to its CDN (currently `us.aws.cdn.hf.co`; earlier `cdn-lfs*.hf.co` and
`cas-bridge.xethub.hf.co`), which sends CORS headers, so the web app can fetch from it too. The files are not in the
server image.

**One list:** `server/models.json` holds each file's name, pinned URL, SHA-256 and size. The Android app and the web
app read it when they are built; the Mac app has the same values, and a test (`mac/Tests/.../DownloadTests.swift`)
fails if they differ; the server uses it to answer older apps (below). A device checks every file's size and SHA-256
before it opens it, so a later change upstream, or anything else on the way, can't slip in.

**Asked first:** Hugging Face is a third party, so no device fetches anything from it before the person agreed, on
that device. Before any model download (turning search on, faces, indexing on this device, a new model after an
update, the web app's text model for search words) the app says what is downloaded (the models and
their total size, from this list, for the files that device needs), from whom (Hugging Face, `huggingface.co` and its
CDN `*.hf.co`), what Hugging Face learns (below), that it happens once per device and that every file is checked
(SHA-256), with the buttons "Download and turn on" and "Not now". The yes is kept on the device (any account) for the
exact files, by SHA-256: other files (the face models, a model changed in a release, as MobileCLIP's replacement
below) ask again. Files already on the device count only once their hash was checked, never by their name alone. Without it nothing is fetched: the one download function of each app refuses (`mobile/src/search/models.ts`
`fetchAll`, `mac/.../Search.swift` `ModelStore.download`, `web/src/search/content.ts` and its worker), search waits
("Waiting for your OK"), and there is no prefetch, HEAD request or background download (the background indexers
never download). Withdrawing: turning search off deletes the models on Android and in the browser, and offers it on
the Mac ("Turn Off on This Mac" always does); the yes goes with them, as it does with the image model removed from a
device that stops indexing. Signing out of the web app deletes its model and the yes. Models already downloaded by an older version count
as agreed (they aren't downloaded again); the search settings show "Models downloaded from Hugging Face on <date>,
N MB" (the date from the files, or from the yes). Where the yes is kept: next to the models (`models/consent.json`)
on Android and the Mac, `localStorage` `cf-models-ok` in the browser. On Android the question also says when the
download waits for Wi-Fi ("Download models only on Wi-Fi", on by default) or uses mobile data.

**What Hugging Face learns:** the device's IP address, that it downloaded these public files, and an ordinary
user agent. No cookie, account, photo, search word or anything about the library goes there; the downloads carry no
referrer. The web app's Content-Security-Policy allows `connect-src` to `https://huggingface.co` and `https://*.hf.co`
only for this.

**Older apps** (up to 2.1.3) still ask their server, `GET /api/models/{name}`, and follow no redirect: the server
fetches the pinned URL and passes the file through (a `Range` header goes along, so a download resumes), with the same
rules as when it had the files: a signed-in session, 404 for anything not in the list. The LAION files are passed
through to everyone, also under the names those apps knew (`nsfw-laion-b32-vision.onnx`, `nsfw-laion-b32-text.onnx`);
MobileCLIP's files are not passed through any more (below), so such an app can't set up search until it is updated.

| File | Model | Made by | Source (pinned commit) | License | Size |
|---|---|---|---|---|---|
| `clip-b32-vision.onnx` | OpenCLIP ViT-B/32 `laion2b_s34b_b79k`, image encoder, fp32 | LAION (weights), Immich (ONNX export) | [immich-app/ViT-B-32__laion2b-s34b-b79k](https://huggingface.co/immich-app/ViT-B-32__laion2b-s34b-b79k) `19a057a0…`, `visual/model.onnx` | MIT | 351,613,724 bytes |
| `clip-b32-text.onnx` | the same model's text encoder, fp32 | same | same, `textual/model.onnx` | MIT | 254,193,396 bytes |
| `clip-b32-tokenizer.json` | CLIP BPE tokenizer | OpenAI (CLIP), in Immich's export | same, `textual/tokenizer.json` | MIT | 3,642,073 bytes |
| `yunet-2023mar.onnx` | YuNet face detector | OpenCV (Shiqi Yu et al.) | [opencv/face_detection_yunet](https://huggingface.co/opencv/face_detection_yunet) `3cc26e7f…` | MIT | 232,589 bytes |
| `sface-2021dec.onnx` | SFace face recognition | OpenCV (Yaoyao Zhong et al.) | [opencv/face_recognition_sface](https://huggingface.co/opencv/face_recognition_sface) `3d708243…` | Apache 2.0 | 38,696,353 bytes |

| SHA-256 | File |
|---|---|
| `b9ce24b91a8c62ef8d40ea786051709c93140104cbf2b6b4a2cc270df3838f9c` | `clip-b32-vision.onnx` |
| `48c25be37b352398f2533c9426dab6f9340535e14e46f884cc894236a5060722` | `clip-b32-text.onnx` |
| `6d9109cc838977f3ca94a379eec36aecc7c807e1785cd729660ca2fc0171fb35` | `clip-b32-tokenizer.json` |

The weights are LAION's, published under MIT ([laion/CLIP-ViT-B-32-laion2B-s34B-b79K](https://huggingface.co/laion/CLIP-ViT-B-32-laion2B-s34B-b79K),
`license:mit`). Immich's repository is an ONNX conversion of them without a license of its own; its vectors are
identical to the original's (below). The two model files are the ones explicit search used before, under neutral
names (they were `nsfw-laion-b32-*`; a device moves them, docs/SEARCH.md "One model").

Downloads per device: indexing (Android, Mac) 609,449,193 bytes, 648,378,135 with the face models; a device that
only searches, and the web app: 257,835,469 bytes (text model and tokenizer).

**No longer used: MobileCLIP S2.** Until 2.6.x the standard search model was Apple's MobileCLIP S2
([Xenova/mobileclip_s2](https://huggingface.co/Xenova/mobileclip_s2), an ONNX export of
[apple/MobileCLIP-S2](https://huggingface.co/apple/MobileCLIP-S2)). Its weights are under Apple's **`apple-amlr`**
license (Apple Machine Learning Research Model license: research purposes only, not commercial, revocable), not the
Apple Sample Code License this page said before. That doesn't fit an app distributed to everyone, so no build uses it
any more: the apps don't download it, delete copies they find, and the server no longer passes it through. LAION's
ViT-B/32 is the one model for everyone (docs/SEARCH.md "One model").

The full commits, SHA-256 values and sizes are in `server/models.json`.

## What we checked

- **YuNet and SFace:** faces are found with the same boxes on Android and Mac, and the descriptions match.
- **LAION ViT-B/32:** Immich's ONNX files were compared with **LAION's original OpenCLIP weights**
  (`open_clip.create_model_and_transforms("ViT-B-32", pretrained="laion2b_s34b_b79k")`). For test images and test
  queries the vectors are identical (cosine 1.0, images and text), so the export is the unchanged LAION model. Its
  tokenizer (`textual/tokenizer.json`) has the same vocabulary and merges as CLIP's and gives the ids the apps' own
  tokenizers are tested against. The browser's text vectors (ONNX Runtime Web) and the Mac's (image and text) match
  the Python reference with cosine ≥ 0.9999 (`web/src/search/search.test.ts`, `mac/.../LaionParityTests.swift`).
- **Mac and Android** produce the same vectors for the same photo (image cosine ≥ 0.998), so entries from either
  device are used by the other.

ONNX files are computation graphs and numbers, not programs: unlike some Python model formats (pickle), loading one
can't run foreign code. The worst a wrong file could do is search badly; and a wrong file is refused by its SHA-256.

## Why these models

- **LAION ViT-B/32:** an open model (MIT) that every build may ship, the one Immich uses for its smart search. LAION-2B
  tagged explicit images instead of removing them, so the model knows those concepts: that is what lets the apps
  filter explicit content from search (docs/SEARCH.md "Explicit content") and, where an admin allows it and the person
  chooses it, find it. It is larger than MobileCLIP S2 was (606 MB against 207 MB for the two encoders) and somewhat
  weaker for ordinary searches (Flickr30k text-to-image recall 66.4 % vs 73.4 %).
- **YuNet and SFace:** small, fast and accurate enough on a phone; widely used through OpenCV.

## Provenance notes

- **LAION-5B**, the collection LAION-2B comes from, was withdrawn by LAION in December 2023 after links to child sexual
  abuse material were found in it, and re-released cleaned as Re-LAION-5B in 2024. The `laion2b_s34b_b79k` checkpoint
  was trained before that, on the original data. Its weights remain openly distributed (LAION, OpenCLIP, Immich).
  This is why explicit search (search without the explicit-content filter) is off for everyone until an admin allows
  it per person, and never offered in the Google Play build.
- **No telemetry:** ONNX Runtime for Android ships a usage-telemetry client that reports to Microsoft. The Android
  app removes it from its manifest and switches telemetry off in code. Cipherfilm talks only to its own server,
  and to Hugging Face once for these files.
- **Updates:** a model changes only with a new Cipherfilm release, through a new commit and SHA-256 in
  `server/models.json` (and the Mac app's list). Index entries name the model they were made with (`m`), so a new model re-indexes the
  library instead of mixing vectors that don't compare.

## Credits

OpenCLIP and LAION-2B: Cherti et al., "Reproducible scaling laws for contrastive language-image learning"
(CVPR 2023); Schuhmann et al., "LAION-5B" (NeurIPS 2022). YuNet: Wu, Peng, Yu, "YuNet: A Tiny Millisecond-level Face
Detector" (2023). SFace: Zhong et al., "SFace: Sigmoid-Constrained Hypersphere Loss for Robust Face Recognition"
(2021). ONNX export of the LAION model: the Immich project. CLIP: Radford et al. (OpenAI, 2021).

Hugging Face is a trademark of Hugging Face, Inc. Cipherfilm is not affiliated with or endorsed by Hugging Face.
