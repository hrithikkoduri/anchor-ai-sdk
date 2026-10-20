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
    .getByRole("tablist", { name: "Course correction configuration" })
    .getByRole("tab", { name: "Tuned example" })
    .click();
  await expect(
    page.locator(".correction-config [role=tabpanel][data-state=active]"),
  ).toContainText("toolOnlyNudgeLimit: 5");
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

test("benchmark metric views and ledger expose the completed records", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/benchmarks.html");
  await page.getByRole("tab", { name: "Task wall time" }).click();
  await expect(page.locator(".metric-panel[data-state=active]")).toContainText(
    "6,036s",
  );
  await expect(page.locator(".metric-panel[data-state=active]")).toContainText(
    "6,921s",
  );
  await page.getByRole("tab", { name: "Usage", exact: true }).click();
  await expect(page.locator(".metric-panel[data-state=active]")).toContainText(
    "11.36M",
  );
  await page.getByRole("tab", { name: "Full ledger" }).click();
  const ledger = page.getByRole("region", {
    name: "Full benchmark ledger, scroll horizontally for all columns",
  });
  await expect(ledger).toBeVisible();
  await expect(ledger.locator("tbody tr")).toHaveCount(10);
  await expect(ledger.locator("tfoot")).toContainText("11,363,962");
  await expect(ledger.locator("tfoot")).toContainText("Not reported");
  await expect(ledger.locator("tbody")).toContainText("No patch");
  await page.getByRole("button", { name: "The accounting caveat" }).click();
  await expect(
    page.getByText("Mini per-task results omit usage", { exact: false }),
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

for (const height of [600, 900]) {
  test(`sidebar keeps the active section visible without moving the article at ${height}px height`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/docs.html");
    for (const id of ["background", "status", "phases", "install"]) {
      const scrollY = await page.locator("#" + id).evaluate(section => {
        section.scrollIntoView({ block: "start", behavior: "instant" });
        return window.scrollY;
      });
      const link = page.locator(`.doc-sidebar a[href="#${id}"]`);
      await expect(link).toHaveAttribute("aria-current", "location");
      await expect.poll(() => link.evaluate(row => {
        const bounds = row.closest(".doc-sidebar").getBoundingClientRect();
        const rect = row.getBoundingClientRect();
        return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
      })).toBe(true);
      expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
    }
  });
}
