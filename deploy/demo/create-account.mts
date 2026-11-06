// Creates the public demo account from an invite link, with the web client's own crypto, and prints its recovery
// words (stdout only; everything else goes to stderr). The password comes from CF_DEMO_PASSWORD, never from the
// command line, where it would land in the shell history and the process list. From web/ (for its node_modules):
//   CF_DEMO_PASSWORD=... npx tsx ../deploy/demo/create-account.mts https://demo.example.org/invite/TOKEN demo@example.org
// A server with a locally issued certificate: NODE_EXTRA_CA_CERTS=/path/to/root.crt in front.
import { getSodium } from "../../web/src/crypto/sodium";
import { createAccount, normEmail } from "../../web/src/crypto/account";

const MIN_PASSWORD = 10; // as in the web app (web/src/components.tsx)

const [link, emailArg] = process.argv.slice(2);
const password = process.env.CF_DEMO_PASSWORD ?? "";
if (!link || !emailArg) {
  console.error("usage: CF_DEMO_PASSWORD=... npx tsx ../deploy/demo/create-account.mts INVITE_LINK EMAIL");
  process.exit(2);
}
if (password.length < MIN_PASSWORD) {
  console.error(`set CF_DEMO_PASSWORD to the demo password (at least ${MIN_PASSWORD} characters)`);
  process.exit(2);
}

const url = new URL(link);
const m = url.pathname.match(/^\/invite\/([^/]+)$/);
if (url.protocol !== "https:" || !m) {
  console.error("that is not an invite link (https://…/invite/…): make one with `docker compose exec app /app invite EMAIL --url https://…`");
  process.exit(2);
}
const token = decodeURIComponent(m[1]);
const api = `${url.origin}/api/invites/${encodeURIComponent(token)}`;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`${method} ${new URL(path).pathname.replace(encodeURIComponent(token), "…")}: HTTP ${res.status} ${data.error ?? ""}`.trim());
    process.exit(1);
  }
  return { data, cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
}

// the invite names its address: a typo here would make an account no one can sign in to with the published e-mail
const email = normEmail(emailArg);
const { data: info } = await call("GET", api);
if (normEmail(info.email) !== email) {
  console.error(`this invite is for ${info.email}, not ${email}`);
  process.exit(1);
}

const s = await getSodium();
console.error("deriving keys (a few seconds)…");
const acc = await createAccount(s, email, password);
const { data: me, cookie } = await call("POST", `${api}/accept`, acc.bundle);
s.memzero(acc.masterKey);
// the sign-in that comes with accepting is of no use here: end it, so it doesn't stay in the account's device list
await fetch(`${url.origin}/api/auth/logout`, { method: "POST", headers: { Cookie: cookie, "X-CSRF-Token": me.csrf } }).catch(() => {});

console.error(`account created: ${email} on ${url.origin}. Its recovery words (keep them safe; the only way back if the password is lost):`);
console.log(acc.recoveryWords.join(" "));
