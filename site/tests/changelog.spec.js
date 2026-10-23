import { test, expect } from "@playwright/test";
import releases from "../src/releases.json" with { type: "json" };

test("timeline renders every tag with benefits, limits, and GitHub links", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/changelog.html");
  await expect(page.locator(".release-entry")).toHaveCount(releases.length);
  for (const release of releases) {
    const entry = page.locator(`[id="v${release.version}"]`);
    await expect(entry.getByRole("heading", { level: 2 })).toHaveText(release.title);
    await expect(entry).toContainText(release.offers);
    await expect(entry.getByRole("link", { name: "Release notes" })).toHaveAttribute(
      "href", `https://github.com/hrithikkoduri/anchor-ai-sdk/releases/tag/v${release.version}`,
    );
  }
  const latest = page.locator('[id="v0.1.8"]');
  await latest.getByText("Limits & compatibility", { exact: true }).click();
  await expect(latest.getByText(/Abortable one-shot exec/)).toBeVisible();
  expect(errors).toEqual([]);
});

for (const width of [320, 375, 768, 1024, 1440]) {
  test(`changelog navigation and layout at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/changelog.html#v0.1.3");
    await expect(page.locator('[id="v0.1.3"]')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (width > 800) {
      await expect(page.getByRole("navigation", { name: "Main navigation" })
        .getByRole("link", { name: "Changelog" })).toHaveAttribute("aria-current", "page");
    } else {
      await page.getByRole("button", { name: "Menu" }).click();
      await expect(page.getByRole("navigation", { name: "Mobile navigation" })
        .getByRole("link", { name: "Changelog" })).toBeVisible();
      await page.getByRole("button", { name: "Close", exact: true }).click();
    }
    if (width === 1440 || width === 375) {
      await page.goto("/changelog.html");
      await page.screenshot({ path: `test-results/changelog-${width}.png`, fullPage: true });
    }
  });
}

test("new feature docs have deep links and honest provider limits", async ({ page }) => {
  await page.goto("/docs.html#verification");
  await expect(page.getByRole("heading", { name: "Ledger & verification", exact: true })).toBeInViewport();
  for (const id of [
    "verification", "structured-output", "operations",
    "process-streams", "image-publishing", "lsp", "images", "preview-ports",
    "prompt-caching", "composition", "philosophy",
    "thread-store", "inbox-store", "operation-store", "sandbox-store",
    "compaction-contract",
  ]) {
    await expect(page.locator(`#${id}`)).toHaveCount(1);
  }
  await expect(page.locator("#providers")).toContainText("E2B is exported since v0.1.6");
  await expect(page.locator("#image-publishing")).toContainText("live registry publication has not been verified");
  await expect(page.locator("#lsp")).toContainText("raw-byte behavior is unverified");
  await expect(page.locator("#thread-store")).toContainText("PostgresThreadStore");
  await expect(page.locator("#inbox-store")).toContainText("for update skip locked");
  await expect(page.locator("#operation-store")).toContainText("operationId");
  await expect(page.locator("#compaction-contract")).toContainText("CompactionHandoff");
  await expect(page.locator("#images")).toContainText("ImageAttachment");
  await expect(page.locator("#preview-ports")).toContainText("previewPort");
  await expect(page.locator("#prompt-caching")).toContainText("cache_control");
  await expect(page.locator("#composition")).toContainText("createAnchor");
});
