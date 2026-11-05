# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM node:26-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS server
ARG TARGETOS TARGETARCH
ARG VERSION=dev
WORKDIR /src
COPY server/ ./
COPY --from=web /web/dist ./static
RUN mkdir -p /out/data && CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/app .

# The open models the Android app runs for search, on the phone (docs/SEARCH.md). Pinned to a commit and a SHA-256;
# the app checks the same hashes before it loads a file.
FROM scratch AS models
ARG HF=https://huggingface.co
ADD --chmod=644 --checksum=sha256:d28b92d7a3a6ba99bd000cce5c91678c0e279dc934c887a3785908a811872a6c \
  ${HF}/Xenova/mobileclip_s2/resolve/0c311c620b36a2270b851db7bef9135f3eaae5d7/onnx/vision_model.onnx /models/mobileclip-s2-vision.onnx
ADD --chmod=644 --checksum=sha256:f8aaa97cf17fbadd78b0bd6d5f6a1c57f712402cacc3055ea92c1a3331357dfe \
  ${HF}/Xenova/mobileclip_s2/resolve/0c311c620b36a2270b851db7bef9135f3eaae5d7/onnx/text_model_quantized.onnx /models/mobileclip-s2-text.onnx
ADD --chmod=644 --checksum=sha256:72ed5c96db5729294468543e4bc75fce14ca63f58e37300290189ba1c1e52b85 \
  ${HF}/Xenova/mobileclip_s2/resolve/0c311c620b36a2270b851db7bef9135f3eaae5d7/tokenizer.json /models/mobileclip-s2-tokenizer.json
# explicit search (only served to people an admin allowed it): LAION's CLIP ViT-B/32 (laion2b_s34b_b79k), Immich's
# split ONNX export; it uses the same CLIP tokenizer as MobileCLIP
ADD --chmod=644 --checksum=sha256:b9ce24b91a8c62ef8d40ea786051709c93140104cbf2b6b4a2cc270df3838f9c \
  ${HF}/immich-app/ViT-B-32__laion2b-s34b-b79k/resolve/19a057a0fb927cf239541300e74237cd56c7ffe2/visual/model.onnx /models/nsfw-laion-b32-vision.onnx
ADD --chmod=644 --checksum=sha256:48c25be37b352398f2533c9426dab6f9340535e14e46f884cc894236a5060722 \
  ${HF}/immich-app/ViT-B-32__laion2b-s34b-b79k/resolve/19a057a0fb927cf239541300e74237cd56c7ffe2/textual/model.onnx /models/nsfw-laion-b32-text.onnx
ADD --chmod=644 --checksum=sha256:8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4 \
  ${HF}/opencv/face_detection_yunet/resolve/3cc26e7f1014a5ee5d74a42acee58bafc9d0a310/face_detection_yunet_2023mar.onnx /models/yunet-2023mar.onnx
ADD --chmod=644 --checksum=sha256:0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79 \
  ${HF}/opencv/face_recognition_sface/resolve/3d7082438a6e4551e840c9b2bb60b71e8da4b524/face_recognition_sface_2021dec.onnx /models/sface-2021dec.onnx

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=server /out/app /app
COPY --from=server --chown=65532:65532 /out/data /data
COPY --from=models /models /models
ENV LISTEN_ADDR=:8080 DATA_DIR=/data MODELS_DIR=/models GOMEMLIMIT=600MiB
EXPOSE 8080
USER nonroot:nonroot
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s CMD ["/app", "healthcheck"]
ENTRYPOINT ["/app"]
