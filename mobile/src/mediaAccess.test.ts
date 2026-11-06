import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ PermissionsAndroid: { requestMultiple: vi.fn(), RESULTS: {} } }));
vi.mock("../modules/cf-native/src/CfNativeModule", () => ({ default: {} }));
vi.mock("./autolock", () => ({ away: (f: () => unknown) => f(), expectAway: () => {} }));
const { mediaPermissions } = await import("./mediaAccess");

const short = (sdk: number, loc: boolean) => mediaPermissions(sdk, loc).map((p) => p.replace("android.permission.", ""));

describe("mediaPermissions", () => {
  it("asks for storage up to Android 12, without location before Android 10", () => {
    expect(short(24, true)).toEqual(["READ_EXTERNAL_STORAGE"]);
    expect(short(28, true)).toEqual(["READ_EXTERNAL_STORAGE"]);
    expect(short(29, true)).toEqual(["READ_EXTERNAL_STORAGE", "ACCESS_MEDIA_LOCATION"]);
    expect(short(32, false)).toEqual(["READ_EXTERNAL_STORAGE"]);
  });
  it("asks for photos and videos from Android 13, and offers limited access from Android 14", () => {
    expect(short(33, true)).toEqual(["READ_MEDIA_IMAGES", "READ_MEDIA_VIDEO", "ACCESS_MEDIA_LOCATION"]);
    expect(short(34, false)).toEqual(["READ_MEDIA_IMAGES", "READ_MEDIA_VIDEO", "READ_MEDIA_VISUAL_USER_SELECTED"]);
    expect(short(36, true)).toEqual(["READ_MEDIA_IMAGES", "READ_MEDIA_VIDEO", "READ_MEDIA_VISUAL_USER_SELECTED", "ACCESS_MEDIA_LOCATION"]);
  });
});
