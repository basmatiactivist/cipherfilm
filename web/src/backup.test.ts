import { describe, expect, it } from "vitest";
import { backupState } from "./backup";

const now = 1_800_000_000;
const h = 3600;

describe("off-site backup state", () => {
  it("says nothing was reported when nothing ever was, without raising a problem", () => {
    const s = backupState({}, now);
    expect(s.problem).toBeUndefined();
    expect(s.text).toMatch(/Nothing reported/);
  });
  it("is fine after a recent success", () => {
    expect(backupState({ backup_ok_at: now - 2 * h }, now).problem).toBeUndefined();
  });
  it("warns when the last run failed, and names the step", () => {
    const s = backupState({ backup_ok_at: now - 26 * h, backup_failed_at: now - 2 * h, backup_failed_in: "upload" }, now);
    expect(s.problem).toMatch(/failed.*backup tool couldn't save/);
    expect(s.problem).toMatch(/Last successful one/);
    expect(backupState({ backup_failed_at: now, backup_failed_in: "snapshot" }, now).problem).toMatch(/snapshot couldn't be written.*None has succeeded yet/);
  });
  it("a success after a failure clears the warning", () => {
    expect(backupState({ backup_ok_at: now - h, backup_failed_at: now - 25 * h, backup_failed_in: "upload" }, now).problem).toBeUndefined();
  });
  it("warns when the nightly run has gone quiet for more than a day and a half", () => {
    expect(backupState({ backup_ok_at: now - 37 * h }, now).problem).toMatch(/No off-site backup since/);
    expect(backupState({ backup_ok_at: now - 35 * h }, now).problem).toBeUndefined();
  });
});
