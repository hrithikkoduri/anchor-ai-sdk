/** Render a GitHub release body from the same data as the website timeline.
 * Usage: node scripts/release-notes.mjs v0.1.8
 * This only prints Markdown. It does not create releases or change tags.
 */
import { readFileSync } from "node:fs";

const releases = JSON.parse(
  readFileSync(new URL("../site/src/releases.json", import.meta.url), "utf8"),
);
const version = process.argv[2]?.replace(/^v/, "");
const index = releases.findIndex((release) => release.version === version);
if (index < 0) {
  console.error("Usage: node scripts/release-notes.mjs <existing-tag>");
  process.exitCode = 1;
} else {
  const release = releases[index];
  const previous = releases[index + 1];
  const repo = "https://github.com/hrithikkoduri/anchor-ai-sdk";
  const sections = [
    release.summary,
    "## What changed",
    ...release.added.map((item) => `- ${item}`),
    "## What this offers",
    release.offers,
    "## Limits and compatibility",
    ...release.limits.map((item) => `- ${item}`),
    "## Install this version",
    `\`\`\`sh\nnpm install anchor-ai-sdk@${version}\n\`\`\``,
    "These notes describe the Git tag. Publishing a GitHub Release does not publish the npm package.",
    `[Documentation](https://anchor-sdk.dev/docs.html) · [Changelog](https://anchor-sdk.dev/changelog.html#v${version}) · [Source at tag](${repo}/tree/v${version})`,
  ];
  if (previous) {
    sections.push(`[Full diff](${repo}/compare/v${previous.version}...v${version})`);
  }
  console.log(sections.join("\n\n"));
}
