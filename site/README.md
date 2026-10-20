# anchor-sdk.dev: the site

React + Vite multipage site, using Animate UI's Radix-based animated primitives
for tabs, tooltips, accordions, and collapsible navigation. The SDK has no
dependency on this app. All four pages share navigation, footer, copy controls,
and the orange anchor mark.
The production build is static and can be served from any static host.
Its HTML is prerendered from the React pages, then hydrated for interactivity.
The same build generates Markdown docs and an agent-readable reference bundle.

```
site/
  index.html        landing entry
  src/main.jsx      landing page
  src/docs.jsx      field-guide documentation
  src/philosophy.jsx source-backed design philosophy and reading guide
  src/philosophy-diagrams.jsx conceptual illustrations + phase exploration
  src/philosophy.css reading/diagram layouts with responsive reflow
  src/agent-example.jsx inline custom-agent examples in the docs
  src/composition-guide.jsx primitives → phases/strategy → runtime → assembled harness
  src/sandbox-setup.jsx provider configuration tabs + template/image guidance
  src/sandbox-examples.js shared snippets + generated complete examples
  src/runtime-configuration.jsx compaction, nudges, and host-side revival code
  src/integration-guides.jsx custom tools, schemas, streaming, and trace examples
  src/message-delivery.jsx native queue/interject, context and production store contract
  src/background-guide.jsx background tool opt-in, delivery and retained-job resume
  src/provider-brand.jsx shared provider marks + labels
  src/examples/     downloadable policy agent, repository harness and background tool
  src/benchmarks.jsx benchmark comparisons + full task ledger
  src/ui.jsx        shared layout, copy, and code components
  src/client.jsx    hydrate production HTML / mount the dev app
  scripts/prerender.mjs static HTML, Markdown and example-module generation
  public/           robots, sitemap, agent index and social-preview assets
  production-tests/ crawler readability, metadata, assets and hydration checks
  src/styles.css    shared design + homepage styles
  src/pages.css     documentation + benchmark styles
  src/typography.css shared readable type scale + responsive reflow
  src/theme.css     white/black signal identity + contrast palette
  src/sandbox.css   provider example layout
  src/benchmark-data.js completed Parasail per-arm figures
  src/benchmark-history.js historical OpenRouter baseline
  docs.html         documentation (single page, anchored sections)
  benchmarks.html   the eval story + results table
  build.html        compatibility redirect to docs (not a separate guide)
  assets/           anchor marks (logo.svg is the current orange mark)
```

## Learning path

Quickstart stays first. The main path then teaches how phase data becomes a
strategy, how a tool implements a capability, how strategy + tools become an
agent, and how a model and optional machine enter through run options. A complete
downloadable repository harness assembles these with stores, budgets,
compaction, traces and explicit sandbox lifecycle ownership. Advanced delivery,
backgrounding and recovery guides follow rather than blocking that first
end-to-end picture. Existing public section anchors remain valid.

The simple policy-agent steps and full-file download share one source file;
the repository harness is import-safe, with real Heyo/model boot only in its CLI
entry point. Tests use scripted model/sandbox responses, not paid cloud boots.

## Preview

```bash
npm ci --prefix site
npm run dev --prefix site
# → http://localhost:4173
```

## Deploy (when the domain is pointed)

Run `npm ci --prefix site && npm run build --prefix site`, then publish
`site/dist/`. All four pages and the compatibility redirect are included. No server functions are
needed. Do not serve the source directory with Python: the homepage needs Vite.

## Checks

```bash
npx --prefix site playwright install chromium
npm run test:browser --prefix site
npm run test:production --prefix site
```

If Chrome is already installed, use
`PLAYWRIGHT_CHANNEL=chrome npm run test:browser --prefix site`.
Checks cover animated tabs, keyboard navigation, FAQ, clipboard, reduced motion,
deep links, documentation navigation, benchmark views, and horizontal overflow
at mobile/desktop widths.
Sidebar tests verify that the active row stays visible without scrolling the
article, including a short final section on tall viewports. The production suite
runs the same interactions against prerendered output plus no-JS/SEO checks.
Sampled body, metadata, code, and ledger text also have 4.5:1 contrast checks.

The custom-agent example also has a no-network smoke check against the actual
compiled SDK. Build the SDK at the repository root first, then run
`npm run test:example --prefix site`. To check a different working-tree build:

```bash
ANCHOR_SDK_ENTRY=/absolute/path/to/dist/index.js npm run test:example --prefix site
```

This checks tool input handling, bundle and separate-piece integration, and
startup requirements with a scripted model. It does not measure live model behavior.

`npm run test:sandbox-examples --prefix site` also imports and constructs the
four provider examples against a compiled SDK. It uses fixture credentials and
blocks fetch; it does not boot cloud machines or build templates. Set
`ANCHOR_SDK_ENTRY` to check a different SDK build (including a bundled `.cjs`
entry with matching provider paths).

The detailed docs also have source-backed snippet checks:

```bash
ANCHOR_SDK_ENTRY=/absolute/path/to/dist/index.js npm run test:docs-examples --prefix site
ANCHOR_SDK_SOURCE=/absolute/path/to/anchor-ai-sdk npm run test:eval-records --prefix site
```

To validate against the exact published release without changing this site's
dependencies, install it into a dedicated temporary folder and point the checks
at that entry (run from the repository root):

```bash
SDK_CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/anchor-docs-sdk.XXXXXX")"
npm install --prefix "$SDK_CHECK_DIR" --ignore-scripts --omit=optional --no-audit --no-fund anchor-ai-sdk@0.1.7
ANCHOR_SDK_ENTRY="$SDK_CHECK_DIR/node_modules/anchor-ai-sdk/dist/index.js" npm run test:docs-examples --prefix site
# Provider constructor checks also need their peers (no cloud boot is performed):
npm install --prefix "$SDK_CHECK_DIR" --ignore-scripts --no-audit --no-fund @heyocomputer/hws 'e2b@^2.56'
ANCHOR_SDK_ENTRY="$SDK_CHECK_DIR/node_modules/anchor-ai-sdk/dist/index.js" npm run test:sandbox-examples --prefix site
```

Use a host Node version that satisfies the resolved peers; E2B 2.58.0 requires
Node 22.19+, separate from the SDK's Node 20+ baseline.

The first parses the configuration snippets, checks imported API names, and
exercises tool validation, simulated revival, native inbox/job carry, runtime
fact persistence, pending-job resume, chain accounting, trace sinks/redaction
and replay with a scripted model. Composition checks additionally verify phase
data → strategy → agent identity, phase transitions without enforced sequencing,
and the full repository harness's tools, state, trace records, evidence and
cleanup (including failed startup). The second checks all completed eval rows, metadata,
grader membership, totals, and patch digests. It requires the completed
`glm53-parasail` and `glm53-mini` artifact directories in that SDK source tree.

See [`CLAIMS.md`](CLAIMS.md) for the source-backed claim audit, known evidence
limitations, and the distinction between available conformance suites and live
passes. Provider examples are configuration guidance, not a claim that every
account/image/template has been exercised.

See [`SEO.md`](SEO.md) for search/agent discovery behavior and the remaining
owner steps: Search Console verification, sitemap submission and URL inspection.

## Keeping it honest

Content is kept in sync by hand with:

- `README.md`: positioning, features, quickstart copy
- `evals/benchmarks/swe-bench/results/comparison.md`: the published baseline;
  new rounds are not results until their artifacts are available
- `DECISIONS.md`: anything architectural the pages assert

If the code and the site disagree, the code is right, so fix the site in the
same PR that changed the code.
