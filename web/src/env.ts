/** Crypto APIs need a secure context (https or localhost). */
export function isSecure(): boolean {
  return globalThis.isSecureContext === true;
}
