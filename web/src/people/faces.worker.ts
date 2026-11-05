// Groups faces off the main thread, so the page stays smooth with tens of thousands of faces.
import { FaceIndex, type FaceFound } from "./faces";

export type Req =
  | { t: "put"; entries: { item: string; faces: FaceFound[] }[] }
  | { t: "remove"; items: string[] }
  | { t: "clear" }
  | { t: "cluster"; id: number; threshold: number; anchors: [string, string[]][]; rejects: Record<string, string[]>; minFaces: number };

const idx = new FaceIndex();

self.onmessage = (e: MessageEvent<Req>) => {
  const r = e.data;
  if (r.t === "put") for (const x of r.entries) idx.put(x.item, x.faces);
  else if (r.t === "remove") for (const x of r.items) idx.remove(x);
  else if (r.t === "clear") idx.clear();
  else {
    try {
      self.postMessage({ id: r.id, ok: true, groups: idx.cluster(r.threshold, r.anchors, r.rejects, r.minFaces) });
    } catch (err) {
      self.postMessage({ id: r.id, ok: false, error: String(err) });
    }
  }
};
