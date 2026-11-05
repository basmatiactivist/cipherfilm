// Keeps uploads going when the app leaves the screen: the foreground service (TransferService.kt) keeps the process,
// and a headless JS task (JsTimers.kt) keeps React Native's timers. Without the task a retry's wait or a request's
// time limit would hang until the app is opened again. Its JS side waits here until the last letGo.
import { AppRegistry } from "react-native";
import N from "../modules/cf-native/src/CfNativeModule";

const keepers: (() => void)[] = [];
AppRegistry.registerHeadlessTask("cipherfilm-keep-timers", () => () => new Promise<void>((done) => { keepers.push(done); }));
const holders = new Map<string, number>();
/** Starts holding for one more upload; false if Android didn't allow the service (the timers are kept either way). */
export function keepRunning(holder: string, title: string, text: string): boolean {
  holders.set(holder, (holders.get(holder) ?? 0) + 1);
  return N.keepRunning(holder, title, text);
}
/** One upload is done; each keepRunning needs its letGo. */
export function letGo(holder: string) {
  const n = (holders.get(holder) ?? 1) - 1;
  if (n > 0) holders.set(holder, n); else holders.delete(holder);
  N.letGo(holder);
  if (!holders.size) keepers.splice(0).forEach((done) => done());
}
/** Whether only this holder keeps the service: then its progress may show in the notification (the backup's wins). */
export const onlyHolder = (holder: string) => holders.size === 1 && holders.has(holder);
