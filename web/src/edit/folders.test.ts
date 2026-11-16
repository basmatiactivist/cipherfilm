import { describe, expect, it } from "vitest";
import { archived, folderOf, isArchived, isLocked, mainGrid, normFolders, splitLocked, withFolder } from "./folders";

const item = (id: string, meta: Record<string, unknown> | undefined, broken = false) => ({ id, meta, broken });

describe("folders", () => {
  it("reads only true as set", () => {
    expect(folderOf({})).toBe("library");
    expect(folderOf({ archived: true })).toBe("archive");
    expect(folderOf({ locked: true })).toBe("locked");
    expect(folderOf({ locked: true, archived: true })).toBe("locked");
    expect(isArchived({ locked: true, archived: true })).toBe(false);
    for (const v of ["true", 1, "yes", {}, null]) {
      expect(isLocked({ locked: v })).toBe(false);
      expect(isArchived({ archived: v })).toBe(false);
    }
    expect(isLocked(undefined)).toBe(false);
  });

  it("normFolders drops values that aren't true", () => {
    expect(normFolders({ name: "a", locked: "true", archived: 1 })).toEqual({ name: "a" });
    expect(normFolders({ name: "a", locked: true })).toEqual({ name: "a", locked: true });
  });

  it("withFolder sets one flag, keeps every other field and doesn't change the input", () => {
    const meta = { name: "a.jpg", gps: { lat: 1, lon: 2 }, mv: 3, future: { x: 1 }, archived: true };
    expect(withFolder(meta, "locked")).toEqual({ name: "a.jpg", gps: { lat: 1, lon: 2 }, mv: 3, future: { x: 1 }, locked: true });
    expect(withFolder(meta, "library")).toEqual({ name: "a.jpg", gps: { lat: 1, lon: 2 }, mv: 3, future: { x: 1 } });
    expect(withFolder({ locked: true }, "archive")).toEqual({ archived: true });
    expect(meta.archived).toBe(true);
  });

  it("a locked item never reaches the open list, an unreadable one stays there", () => {
    const list = [item("1", {}), item("2", { locked: true }), item("3", { archived: true }), item("4", undefined, true), item("5", { locked: true, archived: true })];
    const { open, locked } = splitLocked(list);
    expect(open.map((i) => i.id)).toEqual(["1", "3", "4"]);
    expect(locked.map((i) => i.id)).toEqual(["2", "5"]);
    expect(mainGrid(list).map((i) => i.id)).toEqual(["1", "4"]);
    expect(archived(list).map((i) => i.id)).toEqual(["3"]);
  });
});
