// Accepts an invite (from `/app invite EMAIL`) with the web client's own crypto and prints the new login: for a
// throwaway test account on a real server (a measurement over the real network). From web/:
//   CF_INVITE=https://host/invite/<token> CF_EMAIL=address npx tsx ../mobile/dev/invite-account.mts
import { randomBytes } from "node:crypto";
import { getSodium } from "../../web/src/crypto/sodium";
import { createAccount, normEmail } from "../../web/src/crypto/account";

const invite = process.env.CF_INVITE;
const email = process.env.CF_EMAIL;
if (!invite || !email) throw new Error("set CF_INVITE and CF_EMAIL");
const u = new URL(invite);
const token = decodeURIComponent(u.pathname.split("/").pop() ?? "");
const password = "pw-" + randomBytes(15).toString("base64url");
const s = await getSodium();
const acc = await createAccount(s, normEmail(email), password);
const res = await fetch(`${u.origin}/api/invites/${encodeURIComponent(token)}/accept`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(acc.bundle),
});
console.log(res.ok ? `test account created: ${normEmail(email)} / ${password}` : `accept failed: HTTP ${res.status} ${await res.text()}`);
