import { useEffect, useState } from "preact/hooks";
import { api } from "./api";
import { fmtGB } from "./components";
import { Icon } from "./icons";
import { Loading } from "./loader";
import { AccountStorage, ServerStorage, StorageDevice, foldDevices, lastUploadText, quotaPct, splitParts, staleCount, staleText } from "./storage";

const seen = (sec: number) => {
  const d = Math.floor((Date.now() / 1000 - sec) / 86400);
  return d <= 0 ? "seen today" : d === 1 ? "seen yesterday" : `seen ${d} days ago`;
};

/** Used against the limit, then what it is made of: a stacked bar with a legend that says the sizes in words. */
export function StorageBreakdown({ acc }: { acc: AccountStorage }) {
  const pct = quotaPct(acc);
  const parts = splitParts(acc.split);
  return (
    <div class="storagebreak">
      {pct !== null && <div class="meterbar big" role="img" aria-label={`${fmtGB(acc.used_bytes)} of ${fmtGB(acc.quota_bytes)} used`}><div style={{ width: `${pct}%` }} /></div>}
      <p class="usage">
        {fmtGB(acc.used_bytes)} used{acc.unlimited ? ", no limit" : ` of ${fmtGB(acc.quota_bytes)}`} · {acc.item_count} {acc.item_count === 1 ? "item" : "items"}
      </p>
      {parts.length > 0 && (
        <>
          <div class="splitbar" aria-hidden="true">{parts.map((p) => <span key={p.key} class={"seg " + p.key} style={{ width: `${p.pct}%` }} />)}</div>
          <ul class="splitlegend">
            {parts.map((p) => <li key={p.key}><span class={"sw " + p.key} aria-hidden="true" />{p.label} <span class="small">{fmtGB(p.bytes)}</span></li>)}
          </ul>
        </>
      )}
    </div>
  );
}

/** Each signed-in device with when it last uploaded, and a warning for a phone whose backup seems to have stopped. */
export function BackupDevices({ acc, mine }: { acc: AccountStorage; mine?: boolean }) {
  // every browser that ever signed in can make a long list: folded to this one and what needs a look first
  const [open, setOpen] = useState(false);
  if (acc.devices_hidden) return <p class="hint small">A shared demo login: the devices of the people trying it are not listed.</p>;
  if (acc.devices.length === 0) return <p class="hint small">Not signed in on any device.</p>;
  const fold = foldDevices(acc.devices, open);
  return (
    <>
    <ul class="backupdevs">
      {fold.shown.map((d: StorageDevice) => {
        const warn = staleText(d);
        return (
          <li key={d.id} class={warn ? "stale" : undefined}>
            <div class="devtext">
              <strong>{d.device || "Unknown device"}</strong>
              <span class="small">{mine && d.current ? "This browser" : seen(d.last_seen)} · {lastUploadText(d)}</span>
              {warn && <span class="warnline" role="note"><Icon name="info" size={16} />{warn}</span>}
            </div>
          </li>
        );
      })}
    </ul>
    {(fold.hidden > 0 || open) && acc.devices.length > 3 && (
      <button type="button" class="btn secondary small" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Show fewer devices" : `Show ${fold.hidden} more device${fold.hidden === 1 ? "" : "s"}`}
      </button>
    )}
    </>
  );
}

/** Account › Storage: the person's own overview. */
export function MyStorage() {
  const [acc, setAcc] = useState<AccountStorage | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { api<AccountStorage>("GET", "/api/me/storage").then(setAcc, () => setFailed(true)); }, []);
  if (failed) return <p class="usage small">Couldn't load the storage overview.</p>;
  if (!acc) return <div class="usage"><Loading inline label="Checking…" /></div>;
  return (
    <>
      <StorageBreakdown acc={acc} />
      <p class="hint small">Items in the trash count until they're deleted. Thumbnails and previews are the small copies for browsing.</p>
      <h3 class="subhead">Backup by device</h3>
      <BackupDevices acc={acc} mine />
    </>
  );
}

/** Admin › Storage: every account, the server's total and the disk's free space. */
export function AdminStorage() {
  const [st, setSt] = useState<ServerStorage | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { api<ServerStorage>("GET", "/api/admin/storage").then(setSt, () => setFailed(true)); }, []);
  if (failed) return <p class="error" role="alert">Couldn't load the storage overview.</p>;
  if (!st) return <Loading inline label="Loading storage…" />;
  const stale = staleCount(st.accounts);
  const diskUsed = st.disk_total_bytes - st.disk_free_bytes;
  return (
    <>
      <p class="lead privacy">Sizes, counts and when each device last uploaded: what the server needs to store the files anyway. Nobody's photos, names, dates or places.</p>
      {stale > 0 && <p class="warning small" role="alert">{stale === 1 ? "One phone seems to have stopped backing up." : `${stale} phones seem to have stopped backing up.`} Details below.</p>}
      <section class="panel" aria-labelledby="sto-h">
        <h2 id="sto-h"><Icon name="cloud" />This server</h2>
        {st.disk_total_bytes > 0 && <div class="meterbar big" role="img" aria-label={`Disk ${fmtGB(diskUsed)} of ${fmtGB(st.disk_total_bytes)} used`}><div style={{ width: `${Math.round((diskUsed / st.disk_total_bytes) * 100)}%` }} /></div>}
        <dl class="facts">
          <dt>All accounts</dt><dd>{fmtGB(st.used_bytes)} · {st.item_count} {st.item_count === 1 ? "item" : "items"}</dd>
          {st.disk_total_bytes > 0 && <><dt>Disk free</dt><dd>{fmtGB(st.disk_free_bytes)} of {fmtGB(st.disk_total_bytes)}</dd></>}
        </dl>
      </section>
      {st.accounts.map((a) => (
        <section key={a.id} class="panel storageacct" aria-label={`Storage of ${a.email}`}>
          <h2><span class="email">{a.email}</span>{a.status === "disabled" && <span class="pill disabled">disabled</span>}</h2>
          <StorageBreakdown acc={a} />
          <BackupDevices acc={a} />
        </section>
      ))}
    </>
  );
}
