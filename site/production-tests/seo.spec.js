import { test, expect } from "@playwright/test";

for (const [path, canonical, heading] of [
  ["/", "https://anchor-sdk.dev/", "A loop is easy."],
  ["/docs.html", "https://anchor-sdk.dev/docs.html", "Quickstart"],
  ["/benchmarks.html", "https://anchor-sdk.dev/benchmarks.html", "Nine of ten"],
]) {
  test(`${path} has crawler-readable content and metadata without JavaScript`, async ({ browser, request, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
    const page = await context.newPage();
    const response = await page.goto(path);
    expect(response.status()).toBe(200);
    await expect(page.locator("main")).toContainText(heading);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", canonical);
    await expect(page).toHaveTitle(/Anchor SDK/);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /.+/);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /index, follow/);
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", canonical);
    const schemas = await page.locator('script[type="application/ld+json"]').allTextContents();
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) expect(JSON.parse(schema)["@context"]).toBe("https://schema.org");
    for (const src of await page.locator("img[src]").evaluateAll(images => images.map(image => image.getAttribute("src")))) {
      if (src.startsWith("/")) expect((await request.get(src)).status()).toBe(200);
    }
    await context.close();
  });
}

test("production markup hydrates cleanly and all three pages remain interactive", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/");
  await page.getByRole("tab", { name: "Course correction", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Off course is not the end of the run." })).toBeVisible();
  await page.goto("/docs.html#phases");
  await expect(page.locator('.doc-sidebar a[href="#phases"]')).toHaveAttribute("aria-current", "location");
  await page.goto("/benchmarks.html");
  await page.getByRole("tab", { name: "Usage", exact: true }).click();
  await expect(page.locator(".metric-panel").filter({ visible: true })).toContainText("Not reported");
  expect(errors).toEqual([]);
});

test("robots, sitemap and agent entry points expose canonical readable resources", async ({ request }) => {
  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toContain("Sitemap: https://anchor-sdk.dev/sitemap.xml");
  expect(await robots.text()).not.toContain("Disallow: /");
  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  const xml = await sitemap.text();
  expect([...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1])).toEqual([
    "https://anchor-sdk.dev/", "https://anchor-sdk.dev/docs.html", "https://anchor-sdk.dev/benchmarks.html",
  ]);
  const llms = await request.get("/llms.txt");
  expect(llms.status()).toBe(200);
  expect(await llms.text()).toContain("anchor-ai-sdk");
  expect(await llms.text()).toContain("https://anchor-sdk.dev/docs.md");
  for (const path of ["/index.md", "/docs.md", "/benchmarks.md", "/llms-full.txt"]) {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('<div id="root">');
    expect(text).toContain("anchor-ai-sdk");
    for (const match of text.matchAll(/https:\/\/anchor-sdk\.dev(\/examples\/[^\s)]+)/g)) {
      expect((await request.get(match[1])).status(), match[1]).toBe(200);
    }
  }
  const docs = await (await request.get("/docs.md")).text();
  expect(docs).toContain("policyPhases");
  expect(docs).toContain("MemoryInboxStore");
  expect(docs).toContain("resumeJobs");
  const image = await request.get("/social-card.png");
  expect(image.status()).toBe(200);
  expect(image.headers()["content-type"]).toContain("image/png");
});
