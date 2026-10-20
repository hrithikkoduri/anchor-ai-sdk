import { readFile, writeFile, mkdir, readdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import React from "react";
import { renderToString } from "react-dom/server";
import { createServer } from "vite";
import TurndownService from "turndown";
import { sandboxExamples, completeSandboxExample } from "../src/sandbox-examples.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist");
const origin = "https://anchor-sdk.dev";
const manifest = JSON.parse(await readFile(join(dist, ".vite/manifest.json"), "utf8"));
const assets = new Map(Object.values(manifest)
  .filter(item => item.src && !item.isEntry)
  .map(item => ["/" + item.src, "/" + item.file]));
const server = await createServer({
  root, configFile: false, appType: "custom",
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});
const pages = [
  { html: "index.html", entry: "/src/main.jsx", markdown: "index.md", url: "/" },
  { html: "docs.html", entry: "/src/docs.jsx", markdown: "docs.md", url: "/docs.html" },
  { html: "philosophy.html", entry: "/src/philosophy.jsx", markdown: "philosophy.md", url: "/philosophy.html" },
  { html: "benchmarks.html", entry: "/src/benchmarks.jsx", markdown: "benchmarks.md", url: "/benchmarks.html" },
];
const markdownPages = [];
try {
  for (const page of pages) {
    const { default: Component } = await server.ssrLoadModule(page.entry);
    let markup = renderToString(React.createElement(Component));
    // SSR's source asset URLs must match the production client build at hydration.
    markup = markup.replace(/\b(src|href)="([^"]+)"/g, (match, attribute, url) =>
      assets.has(url) ? `${attribute}="${assets.get(url)}"` : match);
    const template = await readFile(join(dist, page.html), "utf8");
    if (!template.includes('<div id="root"></div>')) throw new Error("Missing root in " + page.html);
    await writeFile(join(dist, page.html), template.replace('<div id="root"></div>', () => `<div id="root">${markup}</div>`));

    const main = markup.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1];
    if (!main) throw new Error("Missing main content in " + page.html);
    const converter = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
    converter.remove(["nav", "aside", "button", "svg", "style", "script"]);
    converter.addRule("code-blocks", {
      filter: "pre",
      replacement: (_, node) => "\n\n```\n" + node.textContent.trim() + "\n```\n\n",
    });
    converter.addRule("absolute-links", {
      filter: "a",
      replacement(content, node) {
        const href = node.getAttribute("href");
        if (!href) return content;
        if (href.startsWith("data:")) {
          const filename = node.getAttribute("download");
          return filename ? `[${content}](${origin}/examples/${filename})` : content;
        }
        return `[${content}](${new URL(href, origin + page.url).href})`;
      },
    });
    const markdown = `Source: ${origin}${page.url}\nPackage: anchor-ai-sdk@0.1.7\n\n${converter.turndown(main)}\n`;
    await writeFile(join(dist, page.markdown), markdown);
    markdownPages.push(markdown);
    console.log(`Prerendered ${page.html} and ${page.markdown}`);
  }
  await writeFile(join(dist, "llms-full.txt"), markdownPages.join("\n\n---\n\n"));
  await mkdir(join(dist, "examples"), { recursive: true });
  for (const filename of await readdir(join(root, "src/examples"))) {
    if (filename.endsWith(".mjs")) await copyFile(join(root, "src/examples", filename), join(dist, "examples", filename));
  }
  for (const example of sandboxExamples) {
    await writeFile(join(dist, "examples", example.id + "-agent.mjs"), completeSandboxExample(example));
  }
} finally {
  await server.close();
}
