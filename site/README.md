# anchor-sdk.dev — the site

Static, zero-build on purpose: three pages, one stylesheet, one small script.
No dependencies, no framework, no build step — it can be served from anywhere.

```
site/
  index.html        landing
  docs.html         documentation (single page, anchored sections)
  benchmarks.html   the eval story + results table
  styles.css        the whole design (light + dark, system)
  app.js            copy buttons + current-page nav
  assets/           the anchor mark (light + dark)
```

## Preview

```bash
python3 -m http.server 4173 -d site
# → http://localhost:4173
```

## Deploy (when the domain is pointed)

Any static host works — Cloudflare Pages, GitHub Pages, Netlify, S3. Serve
the `site/` directory as the root. No redirects, no functions, no headers
needed.

## Keeping it honest

Content is kept in sync by hand with:

- `README.md` — positioning, features, quickstart copy
- `evals/results/comparison.md` — the benchmarks table (Round 2 on Opus 5.5
  updates the page when it lands)
- `DECISIONS.md` — anything architectural the pages assert

If the code and the site disagree, the code is right — fix the site in the
same PR that changed the code.
