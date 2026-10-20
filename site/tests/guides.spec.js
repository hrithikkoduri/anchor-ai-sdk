import { test, expect } from "@playwright/test";

test("compaction shows catalog, explicit and disabled configuration", async ({
  page,
}) => {
  await page.goto("/docs.html#compaction");
  await expect(
    page.getByRole("heading", { name: "Context compaction" }),
  ).toBeInViewport();
  const tabs = page.getByRole("tablist", { name: "Compaction configuration" });
  await tabs.getByRole("tab", { name: "Explicit limits" }).click();
  await expect(
    page.locator(".compaction-config [role=tabpanel][data-state=active]"),
  ).toContainText("keepRecentTokens: 15_000");
  await tabs.getByRole("tab", { name: "Disabled", exact: true }).click();
  await expect(
    page.locator(".compaction-config [role=tabpanel][data-state=active]"),
  ).toContainText("compaction: false");
  await tabs.getByRole("tab", { name: "From catalog" }).click();
  await expect(
    page.locator(".compaction-config [role=tabpanel][data-state=active]"),
  ).toContainText("fallbackCompaction");
});

test("course correction documents real knobs without imaginary retry switches", async ({
  page,
}) => {
  await page.goto("/docs.html#correction");
  const tabs = page.getByRole("tablist", {
    name: "Course correction configuration",
  });
  await tabs.getByRole("tab", { name: "Disable controls" }).click();
  await expect(
    page.locator(".correction-config [role=tabpanel][data-state=active]"),
  ).toContainText("toolOnlyNudgeLimit: false");
  await expect(page.locator("#correction")).toContainText("reasoningTokens");
  await expect(page.locator("#correction")).toContainText("not a public");
});

test("revival shows host-side planning and queue responsibilities", async ({
  page,
}) => {
  await page.goto("/docs.html#revival");
  await expect(
    page.locator(".revival-config [role=tabpanel][data-state=active]"),
  ).toContainText("planRevival({ result, task, threadBudget })");
  await expect(
    page.locator(".revival-config [role=tabpanel][data-state=active]"),
  ).toContainText("threadBudget.record");
  await page
    .getByRole("tablist", { name: "Revival orchestration" })
    .getByRole("tab", { name: "Worker / queue" })
    .click();
  await expect(
    page.locator(".revival-config [role=tabpanel][data-state=active]"),
  ).toContainText("saveAndEnqueueOnce");
  await expect(page.locator("#revival")).toContainText(
    "startPhase alone restores no files",
  );
});

test("streaming examples cover live events, full records, sinks and UI projection", async ({
  page,
}) => {
  await page.goto("/docs.html#traces");
  const tabs = page.getByRole("tablist", {
    name: "Streaming and trace examples",
  });
  for (const [label, code] of [
    ["Live events", "llm_text_delta"],
    ["NDJSON", "new JsonlTrace"],
    ["Custom sink", "async record({ seq, ts, event })"],
    ["UI stream", "createLiveProjector"],
  ]) {
    await tabs.getByRole("tab", { name: label, exact: true }).click();
    await expect(
      page.locator(".trace-config [role=tabpanel][data-state=active]"),
    ).toContainText(code);
  }
  await expect(page.locator("#traces")).toContainText("not a packet capture");
});

test("tools explain schemas, validation and sandbox-backed execution", async ({
  page,
}) => {
  await page.goto("/docs.html#tools");
  await expect(
    page.locator(".tools-config [role=tabpanel][data-state=active]"),
  ).toContainText('required: ["query"]');
  await expect(
    page.locator(".tools-config [role=tabpanel][data-state=active]"),
  ).toContainText("additionalProperties: false");
  await page
    .getByRole("tablist", { name: "Custom tool examples" })
    .getByRole("tab", { name: "Sandbox-backed tool" })
    .click();
  await expect(
    page.locator(".tools-config [role=tabpanel][data-state=active]"),
  ).toContainText("requireSandbox(ctx)");
  await expect(page.locator("#tools")).toContainText(
    "does not enforce the whole JSON Schema",
  );
});

test("provider logos load locally on homepage and docs with Heyo first", async ({
  page,
}) => {
  for (const path of ["/", "/docs.html#machine"]) {
    await page.goto(path);
    const list = page.getByRole("tablist", {
      name:
        path === "/"
          ? "Sandbox adapter examples"
          : "Sandbox provider configuration",
    });
    await expect(list.getByRole("tab").first()).toHaveText("Heyo");
    await expect(list.locator("img.provider-logo")).toHaveCount(3);
    await expect
      .poll(() =>
        list
          .locator("img.provider-logo")
          .evaluateAll((images) =>
            images.every((image) => image.complete && image.naturalWidth > 0),
          ),
      )
      .toBe(true);
  }
});

test("provider strip has uniform logo frames and the Heyo Computer label", async ({
  page,
}) => {
  await page.goto("/");
  const strip = page.locator(".compatibility");
  await expect(strip).toContainText("Heyo Computer");
  await expect(strip).not.toContainText("Heyo microVMs");
  const frames = await strip
    .locator(".provider-logo-frame")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
    );
  expect(frames).toHaveLength(4);
  for (const frame of frames) expect(frame).toEqual({ width: 28, height: 28 });
  await strip.screenshot({ path: "test-results/provider-strip.png" });
});

test("native inbox documents SDK-owned chaining and host-owned durability", async ({ page }) => {
  await page.goto("/docs.html#messages");
  await expect(page.getByRole("heading", { name: "Messages, context & inbox" })).toBeInViewport();
  const section = page.locator("#messages");
  await expect(section.locator("[role=tabpanel][data-state=active]")).toContainText("new MemoryInboxStore()");
  await section.getByRole("tab", { name: "Push messages" }).click();
  await expect(section.locator("[role=tabpanel][data-state=active]")).toContainText('delivery: "interject"');
  await section.getByRole("tab", { name: "Batch rendering" }).click();
  await expect(section.locator("[role=tabpanel][data-state=active]")).toContainText("render(batch)");
  await section.getByRole("tab", { name: "Context & UI" }).click();
  await expect(section.locator("[role=tabpanel][data-state=active]")).toContainText('message.origin === "runtime"');
  await expect(section).toContainText("not exactly-once delivery");
  await expect(section).toContainText("per-run usage deltas");
});

test("background guide provides public custom-tool code, resume and delivery caveats", async ({ page }) => {
  await page.goto("/docs.html#background");
  const section = page.locator("#background");
  await expect(page.getByRole("heading", { name: "Background tools & results" })).toBeInViewport();
  await expect(section.locator("[role=tabpanel][data-state=active]")).toContainText("backgroundAfterSecs: 15");
  await section.getByRole("tab", { name: "Custom tool", exact: true }).click();
  await expect(section.locator("[role=tabpanel][data-state=active]")).toContainText("ctx.backgroundAllowed === true");
  await expect(section.locator("[role=tabpanel][data-state=active]")).toContainText("meta: { command, timeoutSecs, background: result.background }");
  const download = section.getByRole("link", { name: "Download tool" });
  const source = decodeURIComponent((await download.getAttribute("href")).split(",").slice(1).join(","));
  expect(source).toContain("export const projectChecksTool");
  expect(source).not.toMatch(/import\s*\{[^}]*execPolicy/);
  await section.getByRole("tab", { name: "Resume jobs" }).click();
  await expect(section.locator("[role=tabpanel][data-state=active]")).toContainText("resumeJobs: continuation.pendingJobs");
  await expect(section).toContainText("not the full output body");
});

for (const width of [320, 375, 768]) {
  test(`configuration guides retain readable code without overflow at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/docs.html#traces");
    await page
      .getByRole("tablist", { name: "Streaming and trace examples" })
      .getByRole("tab", { name: "Custom sink" })
      .click();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    for (const id of ["messages", "background"]) {
      const section = page.locator("#" + id);
      for (const tab of await section.getByRole("tab").all()) {
        await tab.click();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      }
    }
  });
}
