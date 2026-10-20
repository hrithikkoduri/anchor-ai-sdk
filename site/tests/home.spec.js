import { test, expect } from "@playwright/test";

test("capability tabs and FAQ expose the right content", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "A loop is easy.",
  );
  for (const [tab, heading] of [
    ["Course correction", "Off course is not the end of the run."],
    ["Budget revival", "Out of budget. Not out of context."],
    ["Execution evidence", "Execution records, not just an answer."],
    ["Filesystem memory", "A context window is not a memory."],
  ]) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(
      page
        .locator(".capabilities")
        .getByRole("tabpanel")
        .filter({ visible: true }),
    ).toHaveCount(1);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }
  await page
    .getByRole("button", { name: "Does revival happen automatically?" })
    .click();
  await expect(
    page.getByText("No. Opt in to budget warnings", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Pause runtime animation" }).click();
  await expect(
    page.getByRole("button", { name: "Play runtime animation" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("tabs support keyboard navigation", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Filesystem memory" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Course correction" }),
  ).toBeFocused();
  await expect(
    page.getByRole("heading", {
      name: "Off course is not the end of the run.",
    }),
  ).toBeVisible();
});

test("install button copies the actual command", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "Clipboard permission is Chromium-specific",
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByRole("button", { name: "Copy command", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Copied", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "npm install anchor-ai-sdk",
  );
});

for (const width of [320, 375, 569, 768, 1024, 1440]) {
  test(`fits a ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    if (width < 480) {
      await page.getByRole("button", { name: "Menu" }).click();
      await expect(
        page.getByRole("navigation", { name: "Mobile navigation" }),
      ).toBeVisible();
    }
    if (width === 1440)
      await page.screenshot({
        path: "test-results/home-desktop.png",
        fullPage: true,
      });
    if (width === 375)
      await page.screenshot({
        path: "test-results/home-mobile.png",
        fullPage: true,
      });
  });
}

test("reduced motion stops the looping illustration", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  expect(
    await page
      .locator(".loop-connector i")
      .first()
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe("none");
});

test("existing documentation and benchmark routes still load", async ({
  page,
}) => {
  for (const path of ["/docs.html", "/benchmarks.html"]) {
    const response = await page.goto(path);
    expect(response.status()).toBe(200);
    await expect(page.locator("body")).toContainText("Anchor");
  }
});
