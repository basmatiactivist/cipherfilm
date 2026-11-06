
// WebCrypto, not libsodium: the main thread loads libsodium's standard build, which has no SHA-256.
const checksum = async (key: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", key as BufferSource))[0];

/** 256-bit key + 8-bit checksum (first byte of SHA-256) = 264 bits = 24 words of 11 bits. */
export async function keyToWords(key: Uint8Array): Promise<string[]> {
  const { WORDLIST } = await import("./wordlist"); // only account setup and recovery need it
  if (key.length !== 32) throw new Error("recovery key must be 32 bytes");
  const data = new Uint8Array(33);
  data.set(key);
  data[32] = await checksum(key);
  const words: string[] = [];
  for (let i = 0; i < 24; i++) {
    let v = 0;
    for (let b = 0; b < 11; b++) {
      const bit = i * 11 + b;
      v = (v << 1) | ((data[bit >> 3] >> (7 - (bit & 7))) & 1);
    }
    words.push(WORDLIST[v]);
  }
  return words;
}

export async function wordsToKey(input: string): Promise<Uint8Array> {
  const { WORDLIST } = await import("./wordlist");
  const words = input.trim().toLowerCase().split(/\s+/);
  if (words.length !== 24) throw new Error("A recovery key has 24 words.");
  const data = new Uint8Array(33);
  words.forEach((w, i) => {
    const v = WORDLIST.indexOf(w);
    if (v < 0) throw new Error(`“${w}” isn't a recovery key word. Check for typos.`);
    for (let b = 0; b < 11; b++) {
      if ((v >> (10 - b)) & 1) {
        const bit = i * 11 + b;
        data[bit >> 3] |= 1 << (7 - (bit & 7));
      }
    }
  });
  const key = data.slice(0, 32);
  if ((await checksum(key)) !== data[32]) throw new Error("Some words are wrong. Check for typos.");
  return key;
}
