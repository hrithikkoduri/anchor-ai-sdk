/**
 * Refuses to publish while the package's entry points still reference source
 * files. The monorepo resolves through ./src (tsx plus the consumer aliases),
 * but a published tarball must point at ./dist — run
 * `node scripts/prepare-publish.mjs` (the extraction flip) first.
 *
 * Wired into prepublishOnly, so a mistaken `npm publish` fails loudly here
 * instead of shipping a package whose every import breaks.
 */
import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const problems = [];
if (typeof pkg.main === "string" && pkg.main.includes("/src/"))
  problems.push(`main → ${pkg.main}`);
if (typeof pkg.types === "string" && pkg.types.includes("/src/"))
  problems.push(`types → ${pkg.types}`);
for (const [key, value] of Object.entries(pkg.exports ?? {})) {
  if (typeof value === "string") {
    if (value.includes("/src/")) problems.push(`exports["${key}"] → ${value}`);
    continue;
  }
  for (const [condition, target] of Object.entries(value ?? {})) {
    if (typeof target === "string" && target.includes("/src/"))
      problems.push(`exports["${key}"].${condition} → ${target}`);
  }
}
if (problems.length) {
  console.error(
    "refusing to publish: entry points still reference source files:\n  " +
      problems.join("\n  ") +
      "\nRun node scripts/prepare-publish.mjs first (it flips src → dist).",
  );
  process.exit(1);
}
console.log("publishable: entry points reference built output");
