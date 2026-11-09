// The app shares the web client's crypto code (../web/src/crypto) instead of having its own copy, and
// libsodium there ("libsodium-wrappers", and "-sumo" in the sign-in worker) resolves to the native bindings
// (src/crypto/libsodium.ts).
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const webCrypto = path.resolve(__dirname, "../web/src/crypto");
const vectors = path.resolve(__dirname, "../tools/decrypt/testdata");
// the search models' list (models.json), shared with the server and the other apps
const server = path.resolve(__dirname, "../server");
// the place names for the map (web/src/places: the reader and its .bin, bundled as an asset)
const webPlaces = path.resolve(__dirname, "../web/src/places");

config.watchFolders = [webCrypto, vectors, server, webPlaces];
config.resolver.assetExts = [...config.resolver.assetExts, "bin"];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];
const resolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, name, platform) => {
  if (name === "libsodium-wrappers" || name === "libsodium-wrappers-sumo") return { type: "sourceFile", filePath: path.resolve(__dirname, "src/crypto/libsodium.ts") };
  // the browser version starts a Web Worker; the app derives keys natively
  if (name === "./kdf-async" && context.originModulePath.startsWith(webCrypto)) return { type: "sourceFile", filePath: path.resolve(__dirname, "src/crypto/kdf-async.ts") };
  // the self-test's vectors stay out of release builds
  if (name.endsWith("testdata/vectors.json") && process.env.NODE_ENV === "production") return { type: "empty" };
  return (resolve ?? context.resolveRequest)(context, name, platform);
};

module.exports = config;
