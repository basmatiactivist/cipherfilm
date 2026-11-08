import { describe, expect, it } from "vitest";
import { RunProgress, fmtSpeed } from "./backupProgress";

// The backup's "n of m" and speed, with a clock the test moves.
describe("backup progress", () => {
  it("never goes back while files under way finish out of order", () => {
    let t = 0;
    const p = new RunProgress(5, () => t);
    const seen: number[] = [];
    for (const k of ["1", "2", "3"]) { p.take(); p.start(k); seen.push(p.get().position); }
    // the third finishes first, then the first reports progress: the number stays
    p.finish("3"); seen.push(p.get().position);
    p.sent("1", 0.5, 100); seen.push(p.get().position);
    p.take(); p.start("4"); seen.push(p.get().position);
    p.finish("1"); p.finish("2"); seen.push(p.get().position);
    p.drop("4"); seen.push(p.get().position); // a file that stops without being done takes nothing back
    expect(seen).toEqual([1, 1, 1, 2, 2, 2, 4, 4]);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(p.get().left).toBe(2);
  });

  it("counts files skipped as already in the library, and grows when new photos come during the run", () => {
    const p = new RunProgress(2);
    p.take(); p.finish(); // already in the library
    p.take(); p.start("b");
    expect(p.get()).toMatchObject({ position: 2, total: 2, left: 1 });
    p.take(); p.start("c"); // a photo taken while the run went on
    expect(p.get()).toMatchObject({ position: 2, total: 3, left: 2 });
    p.finish("b"); p.finish("c");
    expect(p.get()).toMatchObject({ position: 3, total: 3, left: 0, fraction: 1 });
  });

  it("the overall fraction moves with the bytes and never goes back, also when a file starts again", () => {
    const p = new RunProgress(2, () => 0);
    p.take(); p.start("a"); p.sent("a", 0.5, 10);
    expect(p.get().fraction).toBe(0.25);
    p.sent("a", 0, 0); // the file's upload starts over after a wait for the server
    expect(p.get().fraction).toBe(0.25);
  });

  it("the speed is over the last seconds, across the files under way, and only once there is enough to tell", () => {
    let t = 0;
    const p = new RunProgress(3, () => t);
    p.take(); p.start("a"); p.take(); p.start("b");
    t = 1000; p.sent("a", 0.5, 1_000_000); p.sent("b", 0.5, 1_000_000);
    expect(p.get().speed).toBeUndefined(); // one second in: not yet
    t = 2000; p.sent("a", 1, 2_000_000);
    expect(p.get().speed).toBe(2_000_000); // 4 MB in 2 s
    t = 8000; p.sent("b", 1, 2_000_000);
    expect(p.get().speed).toBe(750_000); // 6 MB over the 8 s window
    t = 17_000; // nothing sent for 9 s: a stall shows as such
    expect(p.get().speed).toBe(0);
    expect(fmtSpeed(2_400_000)).toBe("2.4 MB/s");
    expect(fmtSpeed(850_000)).toBe("850 KB/s");
  });
});
