import { test, expect } from "@playwright/test";

test("the guide is discoverable without displacing the quickstart", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation", exact: true }).getByRole("link", { name: "Philosophy", exact: true }).click();
  await expect(page).toHaveURL(/philosophy.html$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Let the model reason.");
  await expect(page.locator(".ph-page figure")).toHaveCount(8);
  await expect(page.getByRole("navigation", { name: "Main navigation", exact: true }).getByRole("link", { name: "Philosophy", exact: true })).toHaveAttribute("aria-current", "page");
  await page.goto("/docs.html");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Quickstart");
  await expect(page.getByRole("link", { name: "visual guide to Anchor's philosophy" })).toHaveAttribute("href", "/philosophy.html");
});

test("chapter links resolve and the ownership boundary is explicit", async ({ page }) => {
  await page.goto("/philosophy.html");
  const missing = await page.locator('a[href^="#"]').evaluateAll(links => links.map(link => link.getAttribute("href")).filter(href => !document.getElementById(href.slice(1))));
  expect(missing).toEqual([]);
  await page.getByRole("navigation", { name: "Philosophy chapters" }).getByRole("link", { name: /Keep the seam visible/ }).click();
  await expect(page.locator("#ownership-title")).toBeInViewport();
  const trust = page.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "Trust", exact: true }) });
  await expect(trust).toContainText("whether anything may be published");
  await expect(page.locator("#memory")).toContainText("In-memory stores are not crash-durable");
  await expect(page.locator("#continuity")).toContainText("does not create a durable scheduler or exactly-once delivery");
});

test("phase illustration explains revisiting and direct completion without model calls", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/philosophy.html#agency");
  const tabs = page.getByRole("tablist", { name: "Illustrative approaches, not enforced phase sequences" });
  await tabs.getByRole("tab", { name: "Revisit", exact: true }).click();
  const activeRoute = page.locator('.ph-example-tabs [role="tabpanel"][data-state="active"] .ph-phase-route');
  await expect(activeRoute.locator(":scope > span")).toHaveText(["understand", "act", "validate", "act", "respond"]);
  await tabs.getByRole("tab", { name: "Just answer", exact: true }).click();
  await expect(activeRoute).toHaveText("respond");
  await expect(page.locator("#agency")).toContainText("do not run an agent");
  expect(errors).toEqual([]);
});

test("source accordions connect philosophy to real public contracts", async ({ page }) => {
  await page.goto("/philosophy.html#continuity");
  const section = page.locator("#continuity");
  await section.getByRole("button", { name: /From principle to contract/ }).click();
  await expect(section).toContainText("resumeJobs");
  await expect(section.getByRole("link", { name: "Inbox contract", exact: true })).toHaveAttribute("href", "https://github.com/hrithikkoduri/anchor-ai-sdk/blob/main/src/engine/inbox.ts");
  await page.locator("#evidence").getByRole("button", { name: /From principle to contract/ }).click();
  await expect(page.locator("#evidence")).toContainText("Snapshots may still commit changed work");
});

for (const width of [320, 375, 768, 1440]) {
  test(`philosophy remains readable without page overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 });
    await page.goto("/philosophy.html");
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.getByRole("tab", { name: "Revisit", exact: true }).click();
    for (const button of await page.locator(".ph-source button").all()) await button.click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await page.locator(".ph-principle > p").first().evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
    if (width === 1440 || width === 375) {
      await page.goto("/philosophy.html");
      await page.screenshot({ path: `test-results/philosophy-${width}.png`, fullPage: true });
    }
  });
}
