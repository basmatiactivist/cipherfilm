declare module "libheif-js/wasm-bundle" {
  interface HeifImage {
    get_width(): number;
    get_height(): number;
    display(target: { data: Uint8ClampedArray; width: number; height: number }, cb: (r: unknown) => void): void;
  }
  const lib: { HeifDecoder: new () => { decode(data: ArrayBuffer | Uint8Array): HeifImage[] } };
  export default lib;
}
declare module "exifr/dist/full.esm.mjs" {
  const exifr: {
    parse(input: Blob | ArrayBuffer, opts?: unknown): Promise<Record<string, any> | undefined>;
    gps(input: Blob | ArrayBuffer): Promise<{ latitude: number; longitude: number } | undefined>;
  };
  export default exifr;
}

declare module "*.css";
