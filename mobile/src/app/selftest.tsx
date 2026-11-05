// Development check: the app's crypto (shared web code on native libsodium) must read exactly what the web client
// wrote. Decrypts the committed test vectors (made by the web app) and round-trips fresh data. Open cipherfilm://selftest.
import { useEffect, useState } from "react";
import { ScrollView } from "react-native";
import { Text } from "react-native-paper";
import { getSodium, unb64 } from "@crypto/sodium";
import { loginProof, recoveryProof, unlockMasterKey, unlockWithRecovery } from "@crypto/account";
import { decryptAlbumName, decryptMeta, newItemKey, unwrapItemKey } from "@crypto/item";
import { decryptSegment, encryptSegment, segmentCount } from "@crypto/file";
import N from "../../modules/cf-native/src/CfNativeModule";
import { Screen, Title } from "../ui";

const V = require("../../../tools/decrypt/testdata/vectors.json");

async function run(log: (s: string) => void) {
  const s = await getSodium();
  log(`libsodium ${N.sodium_version_string()}`);
  const t0 = Date.now();
  const { kek } = await loginProof(s, V.password, V.kdf);
  log(`argon2id (${V.kdf.ops} passes, ${V.kdf.mem >> 20} MiB): ${Date.now() - t0} ms`);
  const master = unlockMasterKey(s, V.email, kek, V.wrapped_master_pw);
  const p = await recoveryProof(s, V.recovery_words);
  const viaRec = unlockWithRecovery(s, V.email, p.recWrap, V.wrapped_master_recovery);
  if (!s.memcmp(master, viaRec)) throw new Error("password and recovery key unlock different keys");
  log("master key: password and recovery key agree");
  if (decryptAlbumName(s, unb64(s, V.album.name_enc), master, V.album.id) !== V.album.name) throw new Error("album name");
  log(`album name: ${V.album.name}`);
  for (const f of V.files) {
    const key = unwrapItemKey(s, unb64(s, f.wrapped_item_key), master, f.id);
    const meta = decryptMeta<{ name: string; size: number }>(s, unb64(s, f.meta_enc), key, f.id);
    const plain = decryptSegment(s, key, f.id, 0, f.count, f.size, unb64(s, f.segment0));
    const sha = s.to_hex(s.crypto_hash_sha256(plain));
    if (meta.name !== f.name || meta.size !== f.size || sha !== f.sha256) throw new Error(`file ${f.name}`);
    log(`${f.name}: ${f.size} bytes, sha256 matches`);
  }
  // fresh data through encrypt and decrypt, and a tampered byte must fail
  const id = "0123456789abcdef0123456789abcdef";
  const data = s.randombytes_buf(200000);
  const k = newItemKey(s);
  const ct = encryptSegment(s, k, id, 0, segmentCount(data.length), data.length, data);
  if (!s.memcmp(decryptSegment(s, k, id, 0, 1, data.length, ct), data)) throw new Error("round trip");
  ct[ct.length - 5] ^= 1;
  let caught = false;
  try { decryptSegment(s, k, id, 0, 1, data.length, ct); } catch { caught = true; }
  if (!caught) throw new Error("tampered segment was accepted");
  log("round trip ok; a tampered byte is refused");
}

export default function SelfTest() {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    const log = (l: string) => { console.log("SELFTEST " + l); setLines((x) => [...x, l]); };
    run(log).then(() => log("PASS"), (e) => log("FAIL " + (e as Error).message));
  }, []);
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 24 }}>
        <Title>Crypto self-test</Title>
        {lines.map((l, i) => <Text key={i} variant="bodyMedium" style={{ marginBottom: 6 }}>{l}</Text>)}
      </ScrollView>
    </Screen>
  );
}
