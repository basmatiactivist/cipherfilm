import { describe, expect, it, vi } from "vitest";
import { existingChoice, folderLine, headline, lastLine, liveLine, tooLarge } from "./backupText";

vi.mock("react-native", () => ({ AppState: { addEventListener: () => ({ remove: () => {} }) }, Platform: { constants: {} } }));

// What the Backup screen says, in each state. The reported case: a phone that never had backup set up was told how
// many photos "aren't in Cipherfilm", and offered "Back up these too".
describe("Backup screen wording", () => {
  const base = { on: true, running: false, live: null, waiting: 0, includeExisting: false, older: 0, partial: false };

  it("first setup: a choice between only new ones and the ones already there, with how many, and nothing missing", () => {
    const c = existingChoice({ on: false, includeExisting: false, inFolders: 1234, older: 0 });
    expect(c.all).toBe("Also the 1234 photos and videos already in these folders");
    expect(c.hint).toMatch(/already in your library .* are skipped/);
    expect(`${c.all} ${c.hint}`).not.toMatch(/not in Cipherfilm|aren't in|not backed up|these too/i);
    expect(existingChoice({ on: false, includeExisting: false, inFolders: 1, older: 0 }).all).toBe("Also the 1 photo or video already in these folders");
    expect(existingChoice({ on: false, includeExisting: false, inFolders: 0, older: 0 }).all).toBe("Also the ones already in these folders");
    expect(headline({ ...base, on: false })).toBe("Off");
  });

  it("on with only new ones: what was chosen is up to date, and the older ones not in the library can still be added", () => {
    expect(headline({ ...base, older: 52 })).toBe("Up to date. New photos and videos are backed up as they come.");
    expect(existingChoice({ on: true, includeExisting: false, inFolders: 500, older: 52 }).all).toBe("Also the 52 older ones that aren't in your library yet");
    expect(existingChoice({ on: true, includeExisting: false, inFolders: 500, older: 1 }).all).toBe("Also the 1 older one that isn't in your library yet");
    // all of them already in the library: no number, and it says so
    const none = existingChoice({ on: true, includeExisting: false, inFolders: 500, older: 0 });
    expect(none.all).toBe("Also the ones already in these folders");
    expect(none.hint).toMatch(/already in your library/);
    expect(headline(base)).toBe("Everything is backed up");
  });

  it("while a run goes on, after it, and with nothing to do", () => {
    const live = { position: 23, total: 60, left: 38, fraction: 0.38, speed: 2_400_000 };
    expect(headline({ ...base, running: true, live })).toBe("Backing up 23 of 60");
    expect(liveLine(live)).toBe("2.4 MB/s · 38 left");
    expect(liveLine({ ...live, speed: undefined, left: 1 })).toBe("1 left");
    expect(headline({ ...base, running: true })).toBe("Backing up…");
    expect(headline({ ...base, waiting: 12 })).toBe("12 photos and videos waiting");
    expect(headline({ ...base, waiting: 1 })).toBe("1 photo or video waiting");
    expect(headline({ ...base, includeExisting: true, partial: true })).toBe("Everything Cipherfilm can see is backed up");
    const fmt = (t: number) => `t${t}`;
    expect(lastLine({ uploaded: 0 }, fmt)).toBe("Not run yet");
    expect(lastLine({ lastRun: 5, uploaded: 0 }, fmt)).toBe("Last checked: t5");
    expect(lastLine({ lastRun: 5, lastDone: 4, uploaded: 3 }, fmt)).toBe("Last complete: t4 · 3 photos and videos backed up from this phone");
  });

  it("folders and files too large for the background", () => {
    expect(folderLine("DCIM/Camera/", 1)).toBe("DCIM/Camera · 1 photo or video");
    expect(folderLine("DCIM/Camera/", 40)).toBe("DCIM/Camera · 40 photos and videos");
    expect(tooLarge([{ name: "VID_1.mp4" }])).toBe("VID_1.mp4 is too large to upload in the background. Tap Back up now to upload it.");
    expect(tooLarge([{ name: "a" }, { name: "b" }])).toBe("2 videos are too large to upload in the background. Tap Back up now to upload them.");
  });
});

describe("Run in the background", () => {
  it("Android's default (Optimized, background usage on) is allowed; only Restricted isn't", async () => {
    const { backgroundUse } = await import("./deviceState");
    expect(backgroundUse({ batteryExempt: true, backgroundRestricted: false })).toBe("unrestricted");
    expect(backgroundUse({ batteryExempt: false, backgroundRestricted: false })).toBe("allowed");
    expect(backgroundUse({ batteryExempt: false, backgroundRestricted: true })).toBe("restricted");
  });
});
