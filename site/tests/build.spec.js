import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("docs starts with quickstart and keeps custom agents on the same page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/docs.html");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Quickstart",
  );
  await page.evaluate(() => document.fonts.ready);
  const example = await page.locator("#quickstart pre").first().boundingBox();
  expect(example.y).toBeLessThan(750);
  await expect(page.locator('a[href="/build.html"]')).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "Documentation sections", exact: true })
    .getByRole("link", { name: "Custom agents" })
    .click();
  await expect(page).toHaveURL(/docs.html#custom-agents/);
  await expect(
    page.getByRole("heading", { name: "Build your own agent" }),
  ).toBeInViewport();
});

test("custom agent example and reference are available inline", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/docs.html#custom-agents");
  const tabs = page.getByRole("tablist", { name: "Custom agent example" });
  await tabs.getByRole("tab", { name: "Strategy", exact: true }).click();
  await expect(
    page.locator(
      "#custom-agents .custom-agent-tabs [role=tabpanel][data-state=active]",
    ),
  ).toContainText("systemPrompt");
  await tabs.getByRole("tab", { name: "Tool", exact: true }).click();
  await expect(
    page.locator(
      "#custom-agents .custom-agent-tabs [role=tabpanel][data-state=active]",
    ),
  ).toContainText("defineTool");
  await page
    .getByRole("button", { name: "Strategy and phase interfaces" })
    .click();
  await expect(
    page.getByText("An async (sandbox, task) hook returning context text.", {
      exact: false,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Plug an agent into your app" })
    .click();
  await expect(
    page.getByText("An agent from another framework needs an adapter:", {
      exact: false,
    }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("the full example can be copied and downloaded from docs", async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/docs.html#custom-agents");
  await page
    .getByRole("button", { name: "Copy complete policy agent" })
    .click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("export const policyAgent");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download example" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("policy-agent.mjs");
  const destination = testInfo.outputPath("policy-agent.mjs");
  await download.saveAs(destination);
  expect(await readFile(destination, "utf8")).toBe(copied);
});

test("the former build route points into docs", async ({ page }) => {
  await page.goto("/build.html");
  await expect(page).toHaveURL(/docs.html#custom-agents/);
});

test("reading text and code retain usable sizes on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/docs.html");
  expect(
    await page
      .locator("#quickstart > p")
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(15);
  expect(
    await page
      .locator("#quickstart pre")
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(12);
  await page.goto("/benchmarks.html");
  expect(
    await page
      .locator(".ledger tbody td")
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(12);
});

test("learning path teaches phase-to-strategy composition before agent assembly", async ({ page }) => {
  await page.goto("/docs.html#primitives");
  await expect(page.getByRole("heading", { name: "How the pieces fit" })).toBeInViewport();
  await expect(page.getByRole("list", { name: "Agent composition learning path" })).toContainText("Phases → strategy");
  await expect(page.locator("#primitives")).toContainText("strategy + tools → agent");
  const order = await page.locator(".doc-section").evaluateAll(sections => sections.map(section => section.id));
  expect(order.indexOf("phases")).toBeLessThan(order.indexOf("custom-agents"));
  expect(order.indexOf("assembled")).toBeLessThan(order.indexOf("messages"));
  await page.locator("#primitives").getByRole("link", { name: "Phases → strategy" }).click();
  await expect(page.locator("#phases pre").first()).toContainText("export const policyPhases");
  await expect(page.locator("#phases pre").nth(1)).toContainText("phases: policyPhases");
  await expect(page.locator("#phases pre").nth(1)).toContainText("...policyPhases.map");
  await expect(page.locator("#phases")).toContainText("not a fixed pipeline");
  await page.locator("#phases").getByRole("link", { name: /Next: give this strategy/ }).click();
  await expect(page.locator("#custom-agents > .doc-code")).toContainText("lookup_policy");
  await expect(page.locator("#custom-agents [role=tabpanel][data-state=active]")).toContainText("strategy: policyStrategy");
});

test("end-to-end harness is downloadable with all primitive definitions and real boot wiring", async ({ page }) => {
  await page.goto("/docs.html#assembled");
  const section = page.locator("#assembled");
  await expect(page.getByRole("heading", { name: "Assemble the end-to-end harness" })).toBeInViewport();
  await expect(section.locator("pre").first()).toContainText("agent: reviewAgent");
  await expect(section.locator("pre").first()).toContainText("inbox: { store: inboxStore, channel: threadId }");
  const href = await section.getByRole("link", { name: "Download harness" }).getAttribute("href");
  const source = decodeURIComponent(href.slice(href.indexOf(",") + 1));
  for (const expected of ["reviewPhases", "phases: reviewPhases", "strategy: reviewStrategy", "sandbox.start()", "sandbox.destroy()", "const provider = heyo(", "new JsonlTrace"]) expect(source).toContain(expected);
  await section.getByRole("button", { name: "Complete repository harness: primitives through boot" }).click();
  await expect(section.getByRole("region").locator("pre")).toContainText("export const reviewAgent");
  await expect(section).toContainText("not a read-only security boundary");
});
