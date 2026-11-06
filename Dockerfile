# syntax=docker/dockerfile:1
# Base images by tag and digest: a release builds from exactly the reviewed image; Dependabot moves both together.
FROM --platform=$BUILDPLATFORM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
# no install scripts: nothing in the web build needs one, so no dependency runs code at install time
RUN npm ci --ignore-scripts
COPY web/ ./
# the same version as the server binary, shown under Account (vite.config.ts)
ARG VERSION=dev
RUN npm run build

FROM --platform=$BUILDPLATFORM golang:1.27-alpine@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb AS server
ARG TARGETOS TARGETARCH
ARG VERSION=dev
WORKDIR /src
COPY server/ ./
COPY --from=web /web/dist ./static
RUN mkdir -p /out/data && CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/app .

FROM gcr.io/distroless/static-debian13:nonroot@sha256:25ac8f0c3b2334a9eb05452266bd4697864a8c8ef0ef71e5e6480d7f92868329
COPY --from=server /out/app /app
COPY --from=server --chown=65532:65532 /out/data /data
ENV LISTEN_ADDR=:8080 DATA_DIR=/data GOMEMLIMIT=600MiB
EXPOSE 8080
USER nonroot:nonroot
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s CMD ["/app", "healthcheck"]
ENTRYPOINT ["/app"]
