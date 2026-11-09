import { t } from "./i18n";

/** A native decode or read that never answers (a file that makes Android's decoder hang) must not hold the upload,
 *  and with it every later backup, forever: after ms it counts as failed. The native call itself can't be stopped. */
export function bounded<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(t("Android took too long to read this file."))), ms); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
