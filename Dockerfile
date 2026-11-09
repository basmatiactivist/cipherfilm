# syntax=docker/dockerfile:1
# Base images by tag and digest: a release builds from exactly the reviewed image; Dependabot moves both together.
FROM --platform=$BUILDPLATFORM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
# no install scripts: nothing in the web build needs one, so no dependency runs code at install time
RUN npm ci --ignore-scripts
# the search models' list, shared with the server (web/src/search/rank.ts)
COPY server/models.json /server/models.json
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

# Alpine rather than distroless: a shell for the server's own commands in Portainer's (or any) container console,
# `cipherfilm status` (docs/SERVER-COMMANDS.md). The app runs as an unprivileged user; compose.yaml adds read-only and no capabilities.
# The shell's home is /tmp, so its history never lands in the data folder (and its backups).
FROM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
# nothing added from the package index: the pinned base already has the CA certificates, and the server needs no zone data.
# The package manager and what only it and busybox's https client use (zlib, OpenSSL) are removed: the server is one
# static Go program, the shell (busybox) stays for the `cipherfilm` console command, and nothing is installed at run time
RUN addgroup -S -g 65532 nonroot && adduser -S -D -H -u 65532 -G nonroot -h /tmp -s /bin/sh nonroot \
 && ln -s /app /usr/local/bin/cipherfilm \
 && echo ca-certificates-bundle >> /etc/apk/world \
 && apk del --quiet ssl_client libssl3 libcrypto3 scanelf apk-tools libapk zlib \
 && rm -rf /etc/apk /lib/apk/exec /var/cache/apk
COPY --from=server /out/app /app
COPY --from=server --chown=65532:65532 /out/data /data
ENV LISTEN_ADDR=:8080 DATA_DIR=/data GOMEMLIMIT=600MiB
WORKDIR /data
EXPOSE 8080
USER nonroot:nonroot
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s CMD ["/app", "healthcheck"]
ENTRYPOINT ["/app"]
