import { describe, expect, it } from "vitest";

// The backup's and the uploads' progress notification names the file under way: never on the lock screen, whatever
// the phone's setting for notification content (BackupNative.kt build, also the upload service's).
describe("the progress notification on the lock screen", () => {
  it("is secret (not private), with a public version without the file name", async () => {
    // @ts-ignore: runs in Node (vitest), where the app's types have no node:fs
    const { readFileSync } = await import("node:fs");
    const kt: string = readFileSync(new URL("../modules/cf-native/android/src/main/java/app/cipherfilm/cfnative/BackupNative.kt", import.meta.url), "utf8");
    expect(kt).toContain(".setVisibility(NotificationCompat.VISIBILITY_SECRET)");
    expect(kt).toContain("lockscreenVisibility = NotificationCompat.VISIBILITY_SECRET");
    expect(kt).not.toContain("VISIBILITY_PRIVATE");
    expect(kt).toContain(".setPublicVersion(public)");
    // the public version has the title (how many of how many), never the text with the file name
    const pub = /val public = (.*)/.exec(kt)?.[1] ?? "";
    expect(pub).toContain("setContentTitle(title)");
    expect(pub).not.toContain("setContentText");
  });
});
