# Search and coding-agent discovery

## Implemented in the site

- `npm run build` prerenders the three canonical HTML pages from the actual React
  components. Text, code, links and default-tab examples can be read without JS;
  the browser hydrates that content for tabs, copy controls and navigation.
- Each page has a distinct title/description, an absolute canonical URL,
  index/follow metadata, Open Graph/Twitter previews and JSON-LD. Schema identifies
  the package as Anchor SDK / `anchor-ai-sdk`; it does not invent ratings or awards.
- `/robots.txt` allows crawling and points to `/sitemap.xml`. The sitemap lists
  only the three canonical pages, not fragments or the legacy redirect.
- `/index.html` permanently redirects to `/` on Vercel. `/build.html` redirects to
  the existing custom-agent guide and remains noindex on other static hosts.
- `/llms.txt` is an agent-facing index, linked from the footer. `/docs.md`,
  `/index.md`, `/benchmarks.md` and `/llms-full.txt` are generated from the same
  prerendered content. Default tabs are included; complete example modules are
  served at `/examples/*.mjs`. This is a discovery aid, not a universal agent standard.
- `social-card.png` is a real 1200×630 image; `social-card.svg` is its editable source.

Run `npm run test:production --prefix site` to build and test the actual static
output, including no-JS readability, hydration, assets, metadata and agent links.
The regular browser tests alone run against the dev server and do not verify SSG.

## Owner actions after deploying

1. Open [Google Search Console](https://search.google.com/search-console/).
2. Add a **Domain property** for `anchor-sdk.dev`. Verify ownership with the
   exact TXT record Google supplies at the authoritative DNS provider. Do not
   guess a verification value or change nameservers just for verification.
3. Submit `https://anchor-sdk.dev/sitemap.xml` under **Sitemaps**.
4. Use **URL inspection** for `/`, `/docs.html` and `/benchmarks.html`. Run the
   live test, check the selected canonical and indexing eligibility, then request
   indexing. Resolve any reported issue rather than repeatedly resubmitting.
5. Check the Pages/Indexing report and branded queries such as “Anchor SDK” and
   “anchor-ai-sdk” over time. A successful fetch is not proof of index inclusion.
6. Optionally submit the same sitemap in Bing Webmaster Tools. Keep the npm
   package and GitHub repository homepage links pointing to the canonical site.

Keep the public custom domain accessible without authentication and without an
`X-Robots-Tag: noindex` header. Preview deployments may remain protected/noindex.
Do not disable protection on unrelated deployments to make a crawler test pass.

## What this does not guarantee

Technical SEO makes pages eligible to be crawled and understood. Indexing and
ranking also depend on discovery, relevance, established references and search
engine decisions. No exact position or indexing deadline is promised.

Coding agents vary: some use web search, some fetch explicit URLs, some read npm
or GitHub, and some have no web access at all. `llms.txt` cannot update model
training or force an agent to recommend Anchor. Give an agent the package name
and documentation URL when integrating it, for example:

> Use anchor-ai-sdk@0.1.7. Read https://anchor-sdk.dev/llms.txt and
> https://anchor-sdk.dev/docs.md before writing the integration. The source and
> runnable examples are linked there; check the public APIs for this version.

This works only when that agent is allowed to fetch URLs. Without web access,
provide the relevant Markdown/example files directly. Use accurate public
documentation and useful independent references, not hidden instructions or
keyword stuffing.
