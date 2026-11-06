# The models Cipherfilm uses, and where they come from

Cipherfilm's search ("beach", "dog") and its people view run open machine-learning models **on your devices**: the
Android app, the Mac app and, for turning search words into a vector, the web app. No photo, face or search word is
sent to anyone for this; the server only stores the results, encrypted (docs/SEARCH.md, docs/CRYPTO.md).

This page says which models those are, who made them, under which license, how we got the exact files, and what we
checked. How they are used is in docs/SEARCH.md.

## The files

All files are shipped in the server image (`/models`, built in the `models` stage of the Dockerfile) and downloaded
by each device from **your own server** (`GET /api/models/{name}`, only with a signed-in session; the `nsfw-*` files
only for people allowed explicit search). Each one is pinned twice:

1. **In the Dockerfile**, to a fixed commit of its Hugging Face repository and a SHA-256 (`ADD --checksum`): the image
   build fails if a single byte differs, so a later change upstream can't slip in.
2. **In the apps**, to the same SHA-256 (`mobile/src/search/models.ts`, the Mac app's model list, the web client): a
   device checks every file before it opens it.

| File | Model | Made by | Source (pinned commit) | License | Size |
|---|---|---|---|---|---|
| `mobileclip-s2-vision.onnx` | MobileCLIP S2 image encoder, fp32 | Apple | [Xenova/mobileclip_s2](https://huggingface.co/Xenova/mobileclip_s2) `0c311c62…` | Apple Sample Code License (model), Apache 2.0 (export) | 143 MB |
| `mobileclip-s2-text.onnx` | MobileCLIP S2 text encoder, int8 | Apple | same | same | 64 MB |
| `mobileclip-s2-tokenizer.json` | CLIP BPE tokenizer | OpenAI (CLIP) | same | MIT | 2 MB |
| `yunet-2023mar.onnx` | YuNet face detector | OpenCV (Shiqi Yu et al.) | [opencv/face_detection_yunet](https://huggingface.co/opencv/face_detection_yunet) `3cc26e7f…` | MIT | 0.2 MB |
| `sface-2021dec.onnx` | SFace face recognition | OpenCV (Yaoyao Zhong et al.) | [opencv/face_recognition_sface](https://huggingface.co/opencv/face_recognition_sface) `3d708243…` | Apache 2.0 | 39 MB |
| `nsfw-laion-b32-vision.onnx` | OpenCLIP ViT-B/32 `laion2b_s34b_b79k`, image encoder, fp32 | LAION (weights), Immich (ONNX export) | [immich-app/ViT-B-32__laion2b-s34b-b79k](https://huggingface.co/immich-app/ViT-B-32__laion2b-s34b-b79k) `19a057a0…` | MIT | 352 MB |
| `nsfw-laion-b32-text.onnx` | the same model's text encoder, fp32 | same | same | MIT | 254 MB |

The full commits and SHA-256 values are in the Dockerfile and in docs/SEARCH.md.

## What we checked

- **MobileCLIP S2:** the vectors our Android code computes match the Python reference (ONNX Runtime, same
  preprocessing). The fp16 and int8 image encoders were rejected: fp16 overflows on ARM phones (the vectors become
  useless), int8 differs from fp32 (cosine about 0.05). The fp32 file is used.
- **YuNet and SFace:** faces are found with the same boxes on Android and Mac, and the descriptions match.
- **LAION ViT-B/32:** Immich's ONNX files were compared with **LAION's original OpenCLIP weights**
  (`open_clip.create_model_and_transforms("ViT-B-32", pretrained="laion2b_s34b_b79k")`). For test images and test
  queries the vectors are identical (cosine 1.0, images and text), so the export is the unchanged LAION model. Its
  tokenizer gives the same ids as MobileCLIP's, which is why one tokenizer file serves both.
- **Mac and Android** produce the same vectors for the same photo (image cosine ≥ 0.998), so entries from either
  device are used by the other.

ONNX files are computation graphs and numbers, not programs: unlike some Python model formats (pickle), loading one
can't run foreign code. The worst a wrong file could do is search badly; and a wrong file is refused by its SHA-256.

## Why these models

- **MobileCLIP S2** (default): better zero-shot accuracy than OpenAI's CLIP ViT-B/32 (ImageNet 74.4 % vs 63.3 %) with
  a smaller, faster image encoder, which matters on a phone. It was trained on DataCompDR, derived from DataComp, where
  sexual content was filtered out of the training data. It therefore barely understands explicit terms.
- **YuNet and SFace:** small, fast and accurate enough on a phone; widely used through OpenCV.
- **LAION ViT-B/32** (explicit search, off by default): for people whose admin allowed explicit search and who chose
  it. LAION-2B tagged explicit images instead of removing them, so the model knows those concepts. It is the model
  Immich ships for its smart search. For ordinary searches it is somewhat weaker than MobileCLIP S2 (Flickr30k
  text-to-image recall 66.4 % vs 73.4 %) and larger.

## Provenance notes

- **LAION-5B**, the collection LAION-2B comes from, was withdrawn by LAION in December 2023 after links to child sexual
  abuse material were found in it, and re-released cleaned as Re-LAION-5B in 2024. The `laion2b_s34b_b79k` checkpoint
  was trained before that, on the original data. Its weights remain openly distributed (LAION, OpenCLIP, Immich).
  This is why explicit search is off for everyone until an admin allows it per person.
- **No telemetry:** ONNX Runtime for Android ships a usage-telemetry client that reports to Microsoft. The Android
  app removes it from its manifest and switches telemetry off in code. Cipherfilm talks only to its own server.
- **Updates:** a model changes only with a new Cipherfilm release, through a new commit and SHA-256 in the
  Dockerfile and the apps. Index entries name the model they were made with (`m`), so a new model re-indexes the
  library instead of mixing vectors that don't compare.

## Credits

MobileCLIP: Vasu et al., "MobileCLIP: Fast Image-Text Models through Multi-Modal Reinforced Training" (Apple, CVPR
2024). OpenCLIP and LAION-2B: Cherti et al., "Reproducible scaling laws for contrastive language-image learning"
(CVPR 2023); Schuhmann et al., "LAION-5B" (NeurIPS 2022). YuNet: Wu, Peng, Yu, "YuNet: A Tiny Millisecond-level Face
Detector" (2023). SFace: Zhong et al., "SFace: Sigmoid-Constrained Hypersphere Loss for Robust Face Recognition"
(2021). ONNX export of the LAION model: the Immich project. CLIP: Radford et al. (OpenAI, 2021).
