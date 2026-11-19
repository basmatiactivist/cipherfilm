import { describe, expect, it } from "vitest";
import { appLink, PLAY_LISTING, shareMessage, WEBSITE } from "./shareApp";
import { IDEA_FORM } from "./report";

describe("share the app", () => {
  it("links the store listing from the Play build and the website from the GitHub build", () => {
    expect(appLink(true)).toBe(PLAY_LISTING);
    expect(appLink(false)).toBe(WEBSITE);
    expect(PLAY_LISTING).toBe("https://play.google.com/store/apps/details?id=app.cipherfilm");
  });

  it("puts the link into the message and nothing else of the person's", () => {
    expect(shareMessage(true)).toContain(PLAY_LISTING);
    expect(shareMessage(false)).toContain(WEBSITE);
    expect(shareMessage(true)).not.toMatch(/@|\{link\}/);
  });
});

describe("suggest an idea", () => {
  it("opens the feature request form for Android, without details", () => {
    expect(IDEA_FORM).toBe("https://github.com/basmatiactivist/cipherfilm/issues/new?template=feature_request.yml&app=Android");
  });
});
