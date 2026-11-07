import "./styles.css";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { isSecure } from "./env";
import * as auth from "./auth";
import { dropMasterKey, mem } from "./state";
import { dropRequests } from "./api";
import { clearCaches } from "./cache";
import { clearPeople } from "./people/people";
import { clearPlayer } from "./player";
import { clearUploadMemory, forgetDecrypted } from "./items";
import { forgetKept } from "./keep";
import { Card } from "./components";
import { Logo } from "./icons";
import { Library } from "./library";
import { Login, Unlock } from "./signin";
import { lazy } from "./lazy";
import { Loading } from "./loader";

// first-time and recovery screens: most visits never show them
const Setup = lazy(() => import("./screens").then((m) => m.Setup));
const Invite = lazy(() => import("./screens").then((m) => m.Invite));
const Recover = lazy(() => import("./screens").then((m) => m.Recover));
const RecoveryKey = lazy(() => import("./screens").then((m) => m.RecoveryKey));

type Screen =
  | { n: "boot" } | { n: "setup" } | { n: "login" } | { n: "recover" } | { n: "unlock" } | { n: "home" }
  | { n: "invite"; token: string }
  | { n: "keys"; pending: auth.PendingKey; then: "home" | "login"; title?: string; replacing?: boolean };

/** Drops every key and decrypted byte this tab holds: locking, an ended session. */
function forgetKeys() {
  dropRequests(); // answers still on their way belong to the keys going now
  dropMasterKey();
  forgetKept(); // a lock asks for the password again, also after a reload
  forgetDecrypted();
  clearCaches();
  clearPeople();
  clearPlayer();
  clearUploadMemory();
}

const TITLES: Partial<Record<Screen["n"], string>> = { setup: "Set up", login: "Sign in", recover: "Reset password", unlock: "Unlock", invite: "Create your account", keys: "Recovery key" };

function App() {
  const [screen, setScreen] = useState<Screen>({ n: "boot" });
  const [notice, setNotice] = useState("");

  const route = async () => {
    const path = location.pathname;
    const inv = path.match(/^\/invite\/([^/]+)$/);
    if (inv) {
      try {
        return setScreen({ n: "invite", token: decodeURIComponent(inv[1]) });
      } catch {
        return setScreen({ n: "invite", token: "invalid" }); // malformed %-escape: show the "invite not valid" card
      }
    }
    if (path === "/recover") return setScreen({ n: "recover" });
    if (await auth.loadSession()) return setScreen(mem.masterKey ? { n: "home" } : { n: "unlock" });
    try {
      setScreen({ n: (await auth.needsSetup()) ? "setup" : "login" });
    } catch {
      setScreen({ n: "login" });
    }
  };
  useEffect(() => {
    const ended = () => {
      // a 401 for a request that was already on its way when this tab signed out: nothing is left to end
      if (!mem.me) return;
      // an ended session is a sign-out by the server: the same is forgotten (kept keys, search models, upload notes)
      forgetKeys();
      auth.forgetLocal();
      setNotice("Your session has ended. Sign in again.");
      history.replaceState(null, "", "/");
      setScreen({ n: "login" });
    };
    const revoked = () => {
      forgetKeys();
      auth.forgetLocal();
      setNotice("This browser was signed out from another device. Its copy of your library was deleted.");
      history.replaceState(null, "", "/");
      setScreen({ n: "login" });
    };
    const deleted = () => {
      forgetKeys();
      auth.forgetLocal();
      setNotice("Your account and everything in it were deleted from this server.");
      history.replaceState(null, "", "/");
      setScreen({ n: "login" });
    };
    window.addEventListener("cf-session-ended", ended);
    window.addEventListener("cf-session-revoked", revoked);
    window.addEventListener("cf-account-deleted", deleted);
    return () => {
      window.removeEventListener("cf-session-ended", ended);
      window.removeEventListener("cf-session-revoked", revoked);
      window.removeEventListener("cf-account-deleted", deleted);
    };
  }, []);
  useEffect(() => { route(); window.onpopstate = () => { if (mem.masterKey && location.pathname === "/") return; route(); }; }, []);

  const nav = (to: string) => { history.pushState(null, "", to); route(); };
  const keys = (pending: auth.PendingKey, then: "home" | "login", title?: string, replacing?: boolean) => setScreen({ n: "keys", pending, then, title, replacing });
  // the library sets its own title; every other screen says what it is, not the last library page
  useEffect(() => { const t = TITLES[screen.n]; if (t) document.title = `${t} · Cipherfilm`; }, [screen.n]);
  // lock: the session stays, the keys go; the password opens the library again
  const lock = () => { forgetKeys(); setScreen({ n: "unlock" }); };
  // straight to the sign-in screen: the keys are gone before the server hears of it (auth.logout), and asking the
  // server which screen to show could still find the session it hasn't ended yet
  const signOut = () => {
    auth.logout().catch(() => {});
    setNotice("");
    history.pushState(null, "", "/");
    setScreen({ n: "login" });
  };

  if (!isSecure()) {
    return <Shell><Card title="Open Cipherfilm over https"><p>Encryption only works over a secure connection. Open this server's https address.</p></Card></Shell>;
  }

  return (
    <Shell app={screen.n === "home"}>
      {screen.n === "boot" && <Loading label="Opening Cipherfilm…" />}
      {screen.n === "setup" && <Setup onKeys={(k) => keys(k, "home")} />}
      {screen.n === "login" && <Login nav={nav} notice={notice} onDone={() => { setNotice(""); history.replaceState(null, "", "/"); setScreen({ n: "home" }); }} />}
      {screen.n === "unlock" && <Unlock onDone={() => setScreen({ n: "home" })} onSignOut={signOut} />}
      {screen.n === "invite" && <Invite token={screen.token} nav={nav} onKeys={(k) => keys(k, "home")} />}
      {screen.n === "recover" && <Recover nav={nav} onKeys={(k) => keys(k, "login", "Save your new recovery key", true)} />}
      {screen.n === "keys" && (
        <RecoveryKey pending={screen.pending} title={screen.title} replacing={screen.replacing}
          onDone={() => { history.replaceState(null, "", "/"); screen.then === "home" ? setScreen({ n: "home" }) : nav("/"); }} />
      )}
      {screen.n === "home" && mem.me && <Library email={mem.me.user.email} admin={mem.me.user.role === "admin"} onSignOut={signOut} onLock={lock} />}
    </Shell>
  );
}

function Shell(p: { children: any; app?: boolean }) {
  return (
    <>
      {/* focus directly: following #main would add a history entry, which the in-app navigation reacts to */}
      <a class="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }}>Skip to content</a>
      {!p.app && <header class="bar"><Logo /><span class="brandname">Cipherfilm</span></header>}
      {p.app ? p.children : <main id="main" tabIndex={-1}>{p.children}</main>}
    </>
  );
}

render(<App />, document.getElementById("app")!);
