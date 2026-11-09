// A video's location by the reader the web app uses (web/src/places/videoLocation.ts), through the native file reads:
// for the iPhone's form, which Android's own reader (MediaMetadataRetriever, ©xyz only) doesn't know.
import { videoLocation } from "@places/videoLocation";
import N from "../modules/cf-native/src/CfNativeModule";
import { bounded } from "./bounded";

export async function videoLocationOf(uri: string, size: number): Promise<{ lat: number; lon: number } | null> {
  if (!(size > 0)) return null;
  try {
    return await bounded(videoLocation(size, (offset, length) => N.readRange(uri, offset, Math.min(length, size - offset))), 30_000);
  } catch {
    return null;
  }
}
