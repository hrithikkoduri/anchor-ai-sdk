import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("sandbox configuration covers each implemented provider", async ({
  page,
}) => {
  await page.goto("/docs.html#machine");
  const defaults = page.getByRole("tablist", {
    name: "Sandbox provider configuration",
  });
  await expect(defaults.getByRole("tab").first()).toHaveText("Heyo");
  await expect(
    defaults.getByRole("tab", { name: "Heyo", exact: true }),
  ).toHaveAttribute("data-state", "active");
  const tabs = page.getByRole("tablist", {
    name: "Sandbox provider configuration",
  });
  for (const [label, expected] of [
    ["E2B", "E2B_TEMPLATE"],
    ["Heyo", "imageKind"],
    ["Docker", "anchor-node:local"],
    ["Local", "rootDir"],
  ]) {
    await tabs.getByRole("tab", { name: label, exact: true }).click();
    await expect(
      page.locator(".sandbox-config [role=tabpanel][data-state=active]"),
    ).toContainText(expected);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
  }
});

test("provider examples download as complete runnable files", async ({
  page,
}, testInfo) => {
  await page.goto("/docs.html#machine");
  await page
    .getByRole("tablist", { name: "Sandbox provider configuration" })
    .getByRole("tab", { name: "E2B", exact: true })
    .click();
  const downloadPromise = page.waitForEvent("download");
  await page
    .locator("#machine")
    .getByRole("link", { name: "Download .mjs" })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("e2b-agent.mjs");
  const file = testInfo.outputPath("e2b-agent.mjs");
  await download.saveAs(file);
  const source = await readFile(file, "utf8");
  expect(source).toContain('from "anchor-ai-sdk/sandbox/e2b"');
  expect(source).toContain("function requiredEnv");
  expect(source).toContain("await sandbox.start()");
  expect(source).toContain("await sandbox.destroy()");
});

test("toolchain preparation and evidence limits are explained", async ({
  page,
}) => {
  await page.goto("/docs.html#machine");
  await page
    .getByRole("button", { name: "Prepare an E2B template or Docker image" })
    .click();
  await expect(page.locator("#machine")).toContainText("Template.build");
  await expect(page.locator("#machine")).toContainText("Dockerfile.anchor");
  await expect(page.locator("#evidence")).toContainText("post-run");
  await expect(page.locator("#evidence")).toContainText(
    "does not require a full-suite command",
  );
  await expect(page.locator("#providers")).toContainText("E2B cloud sandboxes");
});

test("homepage presents provider adapters without changing the agent interface", async ({
  page,
}) => {
  await page.goto("/");
  const tabs = page.getByRole("tablist", { name: "Sandbox adapter examples" });
  await expect(tabs.getByRole("tab").first()).toHaveText("Heyo");
  for (const label of ["E2B", "Heyo", "Docker"]) {
    await tabs.getByRole("tab", { name: label, exact: true }).click();
    await expect(
      page.locator(".sandbox-home-tabs [role=tabpanel][data-state=active]"),
    ).toContainText("provider.create");
  }
  await expect(page.locator("#sandboxes")).toContainText(
    "shared conformance suite",
  );
});

for (const width of [320, 375, 768, 1440]) {
  test(`sandbox examples fit ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/docs.html#machine");
    await page
      .getByRole("tablist", { name: "Sandbox provider configuration" })
      .getByRole("tab", { name: "Heyo", exact: true })
      .click();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  });
}
