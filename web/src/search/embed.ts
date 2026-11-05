import * as ort from "onnxruntime-web/wasm";
import type { Tokenizer } from "./tokenizer";
import { CONTEXT, normalize, padIds } from "./rank";

/** The normalised text vector for a query, made as Vision.kt's textVector makes it: ids padded with 0 to 77. */
export async function embed(s: ort.InferenceSession, t: Tokenizer, q: string, int32: boolean): Promise<Float32Array> {
  const ids = padIds(t.encode(q));
  const input = int32 ? new ort.Tensor("int32", Int32Array.from(ids), [1, CONTEXT]) : new ort.Tensor("int64", BigInt64Array.from(ids, (x) => BigInt(x)), [1, CONTEXT]);
  const out = await s.run({ [s.inputNames[0]]: input });
  return normalize(out[s.outputNames[0]].data as Float32Array);
}
