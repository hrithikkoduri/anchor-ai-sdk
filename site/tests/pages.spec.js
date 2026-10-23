import { test, expect } from "@playwright/test";

test("docs supports deep links, code copy and guardrail disclosure", async ({
  page,
  context,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/docs.html#memory");
  await expect(
    page.getByRole("heading", { name: "Filesystem memory", exact: true }),
  ).toBeInViewport();
  await expect(
    page
      .getByRole("navigation", { name: "Documentation sections", exact: true })
      .getByRole("link", { name: "Filesystem memory" }),
  ).toHaveAttribute("aria-current", "location");
  await page
    .getByRole("navigation", { name: "Documentation sections", exact: true })
    .getByRole("link", { name: "Your first agent" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your first agent" }),
  ).toBeInViewport();
  await page.getByRole("button", { name: "Copy chat.mjs" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "llmFromCatalog",
  );
  await page
    .getByRole("button", { name: "Repetition, silence, and verbosity" })
    .click();
  await expect(
    page.getByText("Repeated identical tool calls trigger", { exact: false }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("mobile documentation contents closes after choosing a topic", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/docs.html");
  await page.getByRole("button", { name: "On this page" }).click();
  await page
    .getByRole("navigation", { name: "Documentation sections mobile" })
    .getByRole("link", { name: "Revival & resume" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Revival & resume" }),
  ).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "On this page" }),
  ).toHaveAttribute("aria-expanded", "false");
});

test("benchmark page exposes the complete v0.1.7 record", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/benchmarks.html");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Both arms",
  );
  await expect(page.locator(".v017-summary")).toContainText("11/17");
  await expect(page.locator(".v017-summary")).toContainText("15/20");
  await expect(page.locator(".v017-summary")).toContainText("8/20");
  await expect(page.locator(".v017-table").first().locator("tbody tr")).toHaveCount(6);
  await expect(
    page.getByRole("region", { name: "SWE Lite DeepSeek v0.1.7 per-task ledger" })
      .locator("tbody tr"),
  ).toHaveCount(10);
  await expect(page.getByText("v0.1.8 has no recorded benchmark result", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "The accounting caveat" }).click();
  await expect(
    page.getByText("External SWE-agent did not report cache or cost", { exact: false }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

for (const path of ["/docs.html", "/benchmarks.html"]) {
  for (const width of [320, 375, 768, 1024, 1440]) {
    test(`${path} fits ${width}px with no page-level overflow`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path);
      await page.evaluate(() => document.fonts.ready);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      const pageName = path.includes("docs") ? "Docs" : "Benchmarks";
      if (width > 800)
        await expect(
          page
            .getByRole("navigation", { name: "Main navigation" })
            .getByRole("link", { name: pageName }),
        ).toHaveAttribute("aria-current", "page");
      if (width === 1440 || width === 375)
        await page.screenshot({
          path: `test-results/${pageName.toLowerCase()}-${width}.png`,
          fullPage: true,
        });
    });
  }
}

test("every documentation section link resolves to an anchor", async ({
  page,
}) => {
  await page.goto("/docs.html");
  const missing = await page
    .locator('a[href^="#"]')
    .evaluateAll((links) =>
      links
        .map((link) => link.getAttribute("href"))
        .filter((href) => !document.getElementById(href.slice(1))),
    );
  expect(missing).toEqual([]);
});
test("sidebar labels align with padded active rows", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/docs.html#custom-agents");
  const link = page
    .getByRole("navigation", { name: "Documentation sections", exact: true })
    .getByRole("link", { name: "Custom agents" });
  await expect(link).toHaveAttribute("aria-current", "location");
  const spacing = await link.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el.firstChild);
    const heading = el.closest(".doc-nav-group").querySelector(":scope > span");
    return {
      rowLeft: el.getBoundingClientRect().left,
      textLeft: range.getBoundingClientRect().left,
      headingLeft:
        heading.getBoundingClientRect().left +
        parseFloat(getComputedStyle(heading).paddingLeft),
      marginLeft: getComputedStyle(el).marginLeft,
    };
  });
  expect(spacing.textLeft - spacing.rowLeft).toBeGreaterThanOrEqual(12);
  expect(Math.abs(spacing.textLeft - spacing.headingLeft)).toBeLessThan(1);
  expect(spacing.marginLeft).toBe("0px");
});
