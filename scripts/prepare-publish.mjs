/**
 * Flip the package's entry points from source to built output:
 *
 *   main    ./src/index.ts  →  ./dist/index.js
 *   types   ./src/index.ts  →  ./dist/index.d.ts
 *   exports every ./src/... →  ./dist/...  (types → .d.ts, else .js)
 *
 * Run in the extracted repo's first commit, or in a temporary publish copy:
 *
 *   node scripts/prepare-publish.mjs [package-dir]
 *
 * The monorepo must keep pointing at src (tsx and the consumer aliases
 * resolve through the exports map), so do NOT run this there.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir =
  process.argv[2] ?? path.join(fileURLToPath(new URL("..", import.meta.url)));
const file = path.join(dir, "package.json");
const pkg = JSON.parse(readFileSync(file, "utf8"));

const toJs = (target) =>
  target.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, ".js");
const toDts = (target) =>
  target.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, ".d.ts");

if (typeof pkg.main === "string") pkg.main = toJs(pkg.main);
if (typeof pkg.types === "string") pkg.types = toDts(pkg.types);
for (const value of Object.values(pkg.exports ?? {})) {
  if (typeof value === "string") continue; // handled below via entries
  for (const [condition, target] of Object.entries(value ?? {})) {
    if (typeof target !== "string") continue;
    value[condition] = condition === "types" ? toDts(target) : toJs(target);
  }
}
for (const [key, value] of Object.entries(pkg.exports ?? {})) {
  if (typeof value === "string") pkg.exports[key] = toJs(value);
}
writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`flipped ${file} to built output`);
