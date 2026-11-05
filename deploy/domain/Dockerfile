# Caddy with the Cloudflare DNS module: gets Let's Encrypt certificates through the DNS check, so the server never
# has to be reachable from the internet.
FROM caddy:2.11.7-builder-alpine AS build
RUN xcaddy build --with github.com/caddy-dns/cloudflare@v0.2.4

FROM caddy:2.11.7-alpine
COPY --from=build /usr/bin/caddy /usr/bin/caddy
# it only listens on 4443 and runs with no capabilities at all; a file capability would stop it from starting
RUN setcap -r /usr/bin/caddy
# and not as root: tailscaled lets this uid fetch certificates (TS_PERMIT_CERT_UID in compose.domain.yaml), nothing more
USER 10001:10001
