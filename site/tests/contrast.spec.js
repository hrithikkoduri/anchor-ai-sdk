import { test, expect } from "@playwright/test";

for (const [path, selectors] of [
  [
    "/",
    [
      ".hero-copy > p",
      ".hero .primary",
      ".demo-key",
      ".hero-meta",
      ".eyebrow",
      ".feature-tags span",
      ".runtime .trace-key",
      ".code-header",
      ".syntax-muted",
      ".footer-bottom",
    ],
  ],
  [
    "/docs.html",
    [
      ".doc-intro > p",
      ".doc-nav-group a",
      ".doc-nav-group > span",
      ".doc-section > p",
      ".agent-definitions dd",
      ".code-header",
      ".syntax-muted",
    ],
  ],
  [
    "/benchmarks.html",
    [
      ".ledger td",
      ".ledger .outcome.resolved",
      ".ledger .outcome.unresolved",
      ".ledger .divergent th",
      ".metric-panel > p",
      ".dashboard-title",
      ".benchmark-disclosure",
    ],
  ],
]) {
  test(`${path} uses a white base and readable text contrast`, async ({
    page,
  }) => {
    await page.goto(path);
    expect(
      await page
        .locator("body")
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe("rgb(255, 255, 255)");
    for (const selector of selectors) {
      const ratios = await page.locator(selector).evaluateAll((elements) => {
        const channels = (value) => value.match(/[\d.]+/g).map(Number);
        function luminance(rgb) {
          const linear = rgb
            .slice(0, 3)
            .map((c) => c / 255)
            .map((c) =>
              c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
            );
          return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
        }
        return elements
          .filter((el) => el.getClientRects().length)
          .map((el) => {
            let ancestor = el;
            let background = [255, 255, 255];
            while (ancestor) {
              const color = channels(
                getComputedStyle(ancestor).backgroundColor,
              );
              if (color.length === 3 || color[3] === 1) {
                background = color;
                break;
              }
              ancestor = ancestor.parentElement;
            }
            const foreground = channels(getComputedStyle(el).color);
            const a = luminance(foreground),
              b = luminance(background);
            return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          });
      });
      expect(
        ratios.length,
        `${selector} must have visible samples`,
      ).toBeGreaterThan(0);
      for (const ratio of ratios)
        expect(ratio, `${path} ${selector} contrast`).toBeGreaterThanOrEqual(
          4.5,
        );
    }
  });
}
