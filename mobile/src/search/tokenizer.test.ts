// @ts-nocheck: runs in Node (vitest), where the app's types have no node:fs
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Tokenizer, words } from "./tokenizer";

// Ids from Hugging Face's own tokenizers library for the same tokenizer.json (Xenova/mobileclip_s2). The file is 2 MB
// and not in the repository: set CF_TOKENIZER to its path to check the ids; the pre-tokenizer is always checked.
const expected: Record<string, number[]> = {
  "a dog": [49406, 320, 1929, 49407],
  "A photo of a DOG on the beach!": [49406, 320, 1125, 539, 320, 1929, 525, 518, 2117, 256, 49407],
  "sunset over mountains": [49406, 3424, 962, 5873, 49407],
  "birthday cake 2023": [49406, 1166, 2972, 273, 271, 273, 274, 49407],
  "it's mom's car": [49406, 585, 568, 2543, 568, 1615, 49407],
  "Café in Zürich": [49406, 15304, 530, 89, 6522, 4021, 49407],
  "  multiple   spaces\tand tabs": [49406, 6470, 9006, 537, 29163, 49407],
  "snow-covered trees, 3 kids": [49406, 2583, 268, 5603, 4682, 267, 274, 1911, 49407],
  "emoji 🎉 party": [49406, 16327, 3986, 1580, 49407],
};

describe("CLIP tokenizer", () => {
  it("splits like CLIP's pre-tokenizer", () => {
    expect(words("It's  Mom's CAR, 2023!")).toEqual(["it", "'s", "mom", "'s", "car", ",", "2", "0", "2", "3", "!"]);
    expect(words("snow-covered")).toEqual(["snow", "-", "covered"]);
  });

  const file = process.env.CF_TOKENIZER;
  it.skipIf(!file || !existsSync(file))("gives the same ids as the reference tokenizer", () => {
    const t = new Tokenizer(JSON.parse(readFileSync(file!, "utf8")));
    for (const [text, ids] of Object.entries(expected)) expect(t.encode(text), text).toEqual(ids);
    expect(t.encode("word ".repeat(200))).toHaveLength(77);
  });

  it("never takes an id from an object's built-in keys", () => {
    // merges that build "constructor" as one part of a longer word; it is not in the vocabulary
    const merges = ["c o", "co n", "con s", "cons t", "const r", "constr u", "constru c", "construc t", "construct o", "constructo r"];
    const t = new Tokenizer({ model: { vocab: { "x</w>": 7 }, merges } });
    expect(t.encode("constructorx")).toEqual([49406, 7, 49407]);
  });
});
