// Creates the first account on the local test instance (mobile/dev/compose.yaml) with the web client's own crypto and
// prints the login (CF_TEST_PASSWORD, or a new random password: nothing well-known). From web/ (for its node_modules):
//   docker compose -f ../mobile/dev/compose.yaml exec -T proxy cat /data/caddy/pki/authorities/local/root.crt > /tmp/cftest-ca.pem
//   CF_CA=/tmp/cftest-ca.pem CF_SETUP_TOKEN=<token from: docker compose -f ../mobile/dev/compose.yaml logs app> npx tsx ../mobile/dev/account.mts
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Agent, request } from "node:https";
import { checkServerIdentity } from "node:tls";
import { getSodium } from "../../web/src/crypto/sodium";
import { createAccount, normEmail } from "../../web/src/crypto/account";

const token = process.env.CF_SETUP_TOKEN;
const ca = process.env.CF_CA;
if (!token || !ca) throw new Error("set CF_SETUP_TOKEN and CF_CA");
const email = "tester@example.org";
const password = process.env.CF_TEST_PASSWORD || "pw-" + randomBytes(12).toString("base64url");
const s = await getSodium();
const acc = await createAccount(s, email, password);
const body = JSON.stringify({ setup_token: token, email: normEmail(email), ...acc.bundle });

// the instance answers at 10.0.2.2 (the emulator's name for this Mac); from here it is 127.0.0.1, same certificate
// the CA file only goes into the TLS trust store of this one connection, never into the request
const agent = new Agent({ ca: readFileSync(ca), checkServerIdentity: (_host, cert) => checkServerIdentity("10.0.2.2", cert), keepAlive: false });
const status = await new Promise<number>((resolve, reject) => {
  const req = request({
    host: "127.0.0.1", port: 8443, path: "/api/setup", method: "POST", agent,
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Host: "10.0.2.2" },
  }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
  req.on("error", reject);
  req.end(body);
});
console.log(status >= 200 && status < 300 ? `test account created: ${email} / ${password}` : `setup failed: HTTP ${status}`);
