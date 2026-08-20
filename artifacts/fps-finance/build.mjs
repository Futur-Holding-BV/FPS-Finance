import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(artifactDir, "dist");

await rm(path.join(distDir, "server.mjs"), { force: true });

await build({
  entryPoints: [path.join(artifactDir, "src/server/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: path.join(distDir, "server.mjs"),
  sourcemap: "linked",
  logLevel: "info",
  external: ["pg-native"],
  banner: {
    js: `import { createRequire as __createRequire } from "node:module";
globalThis.require = __createRequire(import.meta.url);`,
  },
});

await build({
  entryPoints: [path.join(artifactDir, "src/server/sync-core.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: path.join(distDir, "sync-core.mjs"),
  logLevel: "silent",
});