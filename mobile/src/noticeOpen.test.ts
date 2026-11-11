import { describe, expect, it } from "vitest";
import { isNoticeLink, onNoticeOpen, openFromNotice, takeNoticeOpen } from "./noticeOpen";
import { redirectSystemPath } from "./app/+native-intent";

describe("a tap on a notice's notification", () => {
  it("goes to the start and leaves Devices to open once, after unlocking", () => {
    expect(isNoticeLink("cipherfilm://notice")).toBe(true);
    expect(isNoticeLink("cipherfilm://expo-sharing")).toBe(false);
    expect(isNoticeLink("not a url")).toBe(false);
    let told = 0;
    const off = onNoticeOpen(() => told++);
    expect(takeNoticeOpen()).toBe(false);
    expect(redirectSystemPath({ path: "cipherfilm://notice", initial: false })).toBe("/");
    expect(told).toBe(1);
    expect(takeNoticeOpen()).toBe(true);
    expect(takeNoticeOpen()).toBe(false);
    off();
    openFromNotice();
    expect(told).toBe(1);
    takeNoticeOpen();
    expect(redirectSystemPath({ path: "cipherfilm://expo-sharing?x=1", initial: true })).toBe("/share");
    expect(takeNoticeOpen()).toBe(false);
  });
});
