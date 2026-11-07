// The loading badge: the mark ("Photo lock") on a round seal whose outer edge is the loading ring, a teal arc that
// turns around it. The large one also seals the mark, like the website's hero: tiles pass over the photo, then the
// shackle closes. With reduced motion the ring only fades in and out. Geometry on the 48 grid, the same on Android and
// the Mac (mobile/src/Loader.tsx, mac/Sources/Cipherfilm/Loader.swift).

/** The mark on the 48 grid, the 24-grid mark centred: half the badge tall on the large one (like the website's seal),
 *  a little more on the small one, whose thicker ring would otherwise leave it a speck. */
const MARK = { large: "translate(9.6 9.84) scale(1.2)", small: "translate(8.4 8.66) scale(1.3)" };
/** Tiles over the photo body (x 3.6 to 20.4, y 9.4 to 22 on the 24 grid): 4 by 3. */
const CELLS = Array.from({ length: 12 }, (_, i) => ({ c: i % 4, r: Math.floor(i / 4) }));

/** The badge alone. Inside something that already says what is happening (a button with "Signing in…"), it is
 *  decoration; on its own use `Loading`, which gives it a label. */
export function Loader({ large }: { large?: boolean }) {
  // the ring is thicker on the small badge, so it still reads at 20 px
  const w = large ? 2.5 : 5;
  const r = 24 - w / 2;
  return (
    <svg class={"loader" + (large ? " large" : "")} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <circle class="ld-disc" cx="24" cy="24" r="24" />
      <circle class="ld-track" cx="24" cy="24" r={r} stroke-width={w} />
      <circle class="ld-arc" cx="24" cy="24" r={r} stroke-width={w} pathLength={100} />
      <g transform={large ? MARK.large : MARK.small}>
        <path class="ld-shackle" d="M6.6 10V7A5.4 5.4 0 0 1 17.4 7V10H14.4V7A2.4 2.4 0 0 0 9.6 7V10Z" />
        <path class="ld-body" fill-rule="evenodd" d="M5.8 9.4H18.2A2.2 2.2 0 0 1 20.4 11.6V19.8A2.2 2.2 0 0 1 18.2 22H5.8A2.2 2.2 0 0 1 3.6 19.8V11.6A2.2 2.2 0 0 1 5.8 9.4ZM6.2 19.8L6.2 18L10.2 13.6L13.6 17.2L17.8 14.4L17.8 19.8ZM13.7 12.6A1.7 1.7 0 1 0 17.1 12.6A1.7 1.7 0 1 0 13.7 12.6Z" />
        {/* in the badge's own color: over the cut-outs and the corners they don't show, over the teal they glint */}
        {large && <g class="ld-cells">{CELLS.map(({ c, r }) => <rect key={c + r * 4} class={`c${c + r}`} x={3.6 + c * 4.2} y={9.4 + r * 4.2} width="4.2" height="4.2" />)}</g>}
      </g>
    </svg>
  );
}

/** Something is loading: the large badge alone, centred where the content will be (it says enough; what is happening
 *  goes to screen readers). `inline` is the small badge in a status line, with its words ("Checking…"). */
export function Loading({ label = "Loading…", inline, stage }: { label?: string; inline?: boolean; stage?: boolean }) {
  if (inline) return <p class="small pending" role="status"><Loader /><span>{label}</span></p>;
  return (
    <div class={"loading" + (stage ? " onstage" : "")} role="status" aria-label={label}>
      <Loader large />
    </div>
  );
}
