# Your own domain, still only in your tailnet

With `compose.domain.yaml` the Tailscale setup also answers at a name of your own, such as `photos.example.com`.
Nothing changes about who can reach it: the name points at the server's **tailnet address** (`100.x.y.z`), which only
devices in your tailnet can reach. No port is opened on the host, and no proxy or CDN sits in between.

The certificate is a normal Let's Encrypt certificate, renewed automatically by Caddy. Let's Encrypt can't reach the
server to check that the name is yours (that is the point), so Caddy proves it through DNS instead: it sets a
temporary `_acme-challenge` TXT record through your DNS provider's API and removes it afterwards. The image built
here includes the module for Cloudflare DNS; for another provider, swap the module in `deploy/domain/Dockerfile`
and the `dns` line in `deploy/domain/Caddyfile`.

The tailnet name (`<name>.<tailnet>.ts.net`) keeps working with its Tailscale certificate, and Kopia's UI stays on
`:8443` of the tailnet name.

Good to know: the name and the tailnet address become public in DNS, and the name appears in the public
certificate logs. Neither lets anyone outside your tailnet connect.

## Set up (Cloudflare DNS)

1. Find the server's tailnet addresses: `docker compose exec tailscale tailscale ip`.
2. In Cloudflare, DNS for your zone: an `A` record for the name with the `100.x.y.z` address (and an `AAAA` record
   with the `fd7a:...` address), **Proxy status: DNS only** (grey cloud). Cloudflare could not reach the address anyway.
3. Cloudflare, *My Profile > API Tokens > Create Token*, template *Edit zone DNS*, *Zone Resources: Include >
   Specific zone >* your zone only. Copy the token.
4. In `.env`:

   ```
   COMPOSE_FILE=compose.yaml:compose.tailscale.yaml:compose.kopia.yaml:compose.domain.yaml
   DOMAIN=photos.example.com
   TS_DOMAIN=photos.your-tailnet.ts.net
   PUBLIC_HOSTS=photos.example.com,photos.your-tailnet.ts.net
   CF_API_TOKEN='the token'
   ```

   Without Kopia leave out `compose.kopia.yaml`.
5. `docker compose up -d --build`. The first certificate takes about a minute: `docker compose logs caddy`.

To go back, drop `compose.domain.yaml` from `COMPOSE_FILE` and run `docker compose up -d --remove-orphans`.
