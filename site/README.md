# anchor-sdk.dev: the site

React + Vite multipage site, using Animate UI's Radix-based animated primitives
for tabs, tooltips, accordions, and collapsible navigation. The SDK has no
dependency on this app. All pages share navigation, footer, copy controls,
and the orange anchor mark.
The production build is static and can be served from any static host.

```
site/
  index.html        landing entry
  src/main.jsx      landing page
  src/docs.jsx      field-guide documentation
  src/agent-example.jsx inline custom-agent examples in the docs
  src/examples/     downloadable, reusable custom-agent example
  src/benchmarks.jsx benchmark comparisons + full task ledger
  src/changelog.jsx version-by-version release timeline
  src/releases.json shared release notes for the site and GitHub
  src/feature-docs.jsx verification, recovery, images, process streams, LSP
  src/ui.jsx        shared layout, copy, and code components
  src/styles.css    shared design + homepage styles
  src/pages.css     documentation + benchmark styles
  src/typography.css shared readable type scale + responsive reflow
  src/theme.css     white/black signal identity + contrast palette
  src/benchmark-data.js complete v0.1.7 combined figures
  docs.html         documentation (single page, anchored sections)
  benchmarks.html   the eval story + results table
  changelog.html    release history, benefits, limits, and tagged source links
  build.html        compatibility redirect to docs (not a separate guide)
  assets/           anchor marks (logo.svg is the current orange mark)
```

## Preview

```bash
npm ci --prefix site
npm run dev --prefix site
# → http://localhost:4173
```

## Deploy (when the domain is pointed)

Run `npm ci --prefix site && npm run build --prefix site`, then publish
`site/dist/`. The landing, docs, benchmarks, changelog, and compatibility redirect are included. No server functions are
needed. Do not serve the source directory with Python: the homepage needs Vite.

## Checks

```bash
npx --prefix site playwright install chromium
npm run test:browser --prefix site
```

If Chrome is already installed, use
`PLAYWRIGHT_CHANNEL=chrome npm run test:browser --prefix site`.
Checks cover animated tabs, keyboard navigation, FAQ, clipboard, reduced motion,
deep links, documentation navigation, benchmark views, and horizontal overflow
at mobile/desktop widths.
Sampled body, metadata, code, and ledger text also have 4.5:1 contrast checks.

The custom-agent example also has a no-network smoke check against the actual
compiled SDK. Build the SDK at the repository root first, then run
`npm run test:example --prefix site`. To check a different working-tree build:

```bash
ANCHOR_SDK_ENTRY=/absolute/path/to/dist/index.js npm run test:example --prefix site
```

This checks tool input handling, bundle and separate-piece integration, and
startup requirements with a scripted model. It does not measure live model behavior.

## Keeping it honest

Release content lives in `src/releases.json`. Add a version there, then render
its GitHub body with `node scripts/release-notes.mjs v0.1.8` from the repository
root. The website timeline reads the same file. Verify each entry against the
actual tag diff; never move a published tag to match the newest docs. Creating
a GitHub Release is separate from publishing to npm.

Content is kept in sync by hand with:

- `README.md`: positioning, features, quickstart copy
- `evals/benchmarks/swe-bench/results/comparison.md`: the published baseline;
  new rounds are not results until their artifacts are available
- `DECISIONS.md`: anything architectural the pages assert

If the code and the site disagree, the code is right, so fix the site in the
same PR that changed the code.
