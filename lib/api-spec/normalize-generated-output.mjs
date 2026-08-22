import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const generatedRoots = [
  path.resolve(here, "../api-client-react/src/generated"),
  path.resolve(here, "../api-zod/src/generated"),
];

async function normalize(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await normalize(filePath);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;

    const content = await readFile(filePath, "utf8");
    const normalized = `${content.trimEnd()}\n`;
    if (normalized !== content) {
      await writeFile(filePath, normalized, "utf8");
    }
  }
}

await Promise.all(generatedRoots.map(normalize));