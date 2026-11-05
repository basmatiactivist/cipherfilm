# Caddy with the Cloudflare DNS module: gets Let's Encrypt certificates through the DNS check, so the server never
# has to be reachable from the internet.
FROM caddy:2.11.7-builder-alpine@sha256:95a5e7e2692b5eb9545aadc5b90a39f6f509bee59c9508a493f83ee902eaef63 AS build
RUN xcaddy build --with github.com/caddy-dns/cloudflare@v0.2.4

FROM caddy:2.11.7-alpine@sha256:e70b164da81ef698b3ad19af799ea6086ce6d9e48ed4079eb9fe26f6fbf14ee5
COPY --from=build /usr/bin/caddy /usr/bin/caddy
# it only listens on 4443 and runs with no capabilities at all; a file capability would stop it from starting
RUN setcap -r /usr/bin/caddy
# and not as root: tailscaled lets this uid fetch certificates (TS_PERMIT_CERT_UID in compose.domain.yaml), nothing more
USER 10001:10001
