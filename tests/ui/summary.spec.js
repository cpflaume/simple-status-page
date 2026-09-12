// UI tests: verify the data published as JSON is correctly reflected on the page.
//
// The page (public/index.html + assets/app.js) fetches data/summary.json and
// renders it. serve.mjs feeds it the deterministic dataset from dataset.mjs,
// and these tests assert every rendered value traces back to that JSON.

const { test, expect } = require("@playwright/test");
const { buildDataset, STATUS_LABEL } = require("./dataset.js");

const { summary, histories } = buildDataset();

// Wait until app.js has finished the first render (rows exist).
async function gotoRendered(page) {
  await page.goto("/");
  await expect(page.locator("#groups .row")).toHaveCount(summary.checks.length);
}

test.describe("summary.json reflected on the page", () => {
  test("header, description and repo link come from the JSON", async ({ page }) => {
    await gotoRendered(page);
    await expect(page.locator("#site-name")).toHaveText(summary.name);
    await expect(page.locator("#site-desc")).toHaveText(summary.description);
    // generated_at is formatted into the footer; at minimum it is no longer "—".
    await expect(page.locator("#updated")).not.toHaveText("—");
    await expect(page.locator("#repo-link")).toHaveAttribute("href", /github\.com/);
  });

  test("overall banner reflects overall_status and overall_text", async ({ page }) => {
    await gotoRendered(page);
    const banner = page.locator("#banner");
    await expect(banner).toHaveClass(new RegExp(`banner--${summary.overall_status}`));
    await expect(page.locator("#banner-text")).toHaveText(summary.overall_text);
  });

  test("checks are grouped in config order with correct titles", async ({ page }) => {
    await gotoRendered(page);
    const expectedGroups = [];
    for (const c of summary.checks) {
      if (!expectedGroups.includes(c.group)) expectedGroups.push(c.group);
    }
    await expect(page.locator(".group__title")).toHaveText(expectedGroups);

    // Each group card holds exactly the checks assigned to it.
    for (const groupName of expectedGroups) {
      const count = summary.checks.filter((c) => c.group === groupName).length;
      const group = page.locator(".group", { has: page.getByRole("heading", { name: groupName }) });
      await expect(group.locator(".row")).toHaveCount(count);
    }
  });

  test("every check renders name, status pill, detail and uptime", async ({ page }) => {
    await gotoRendered(page);

    for (const check of summary.checks) {
      const row = page.locator(".row", { has: page.locator(".row__name", { hasText: check.name }) });
      await expect(row).toHaveCount(1);

      // Status pill: exact label text and status modifier class.
      const pill = row.locator(".pill");
      await expect(pill).toHaveText(STATUS_LABEL[check.status]);
      await expect(pill).toHaveClass(new RegExp(`pill--${check.status}`));

      // Detail line carries the check's detail text.
      const detail = row.locator(".row__detail");
      await expect(detail).toContainText(check.detail);

      // Latency is shown for reachable checks, hidden when the check is down.
      if (check.status !== "down") {
        await expect(detail).toContainText(`${check.latency_ms} ms`);
      } else {
        await expect(detail).not.toContainText("ms");
      }

      // 90-day uptime is shown in the bar legend, formatted to 2 decimals.
      await expect(row.locator(".bar__legend")).toContainText(
        `${check.uptime_90d.toFixed(2)}%`
      );
    }
  });

  test("today's daily-bar cell matches each check's latest day status", async ({ page }) => {
    await gotoRendered(page);

    for (const check of summary.checks) {
      const latest = check.days[check.days.length - 1]; // dataset's last entry is today
      const row = page.locator(".row", { has: page.locator(".row__name", { hasText: check.name }) });
      // The bar is drawn oldest-first, so the last cell is today.
      const todayCell = row.locator(".bar .bar__cell").last();
      await expect(todayCell).toHaveClass(new RegExp(`bar__cell--${latest.status}`));
    }
  });

  test("expanding a check loads its history samples into the spark strip", async ({ page }) => {
    await gotoRendered(page);

    const check = summary.checks.find((c) => histories[c.id]);
    const expectedSamples = histories[check.id].samples.length;

    const row = page.locator(".row", { has: page.locator(".row__name", { hasText: check.name }) });
    const head = row.locator(".row__head");

    await expect(head).toHaveAttribute("aria-expanded", "false");
    await head.click();
    await expect(head).toHaveAttribute("aria-expanded", "true");

    // One spark column per raw sample, plus meta text describing the range.
    const detail = row.locator(".detail");
    await expect(detail.locator(".spark__col")).toHaveCount(expectedSamples);
    await expect(detail.locator(".detail__meta")).toContainText(`${expectedSamples} probes`);
  });

  test("a check with no history shows a graceful fallback", async ({ page }) => {
    await gotoRendered(page);

    const check = summary.checks.find((c) => !histories[c.id]);
    const row = page.locator(".row", { has: page.locator(".row__name", { hasText: check.name }) });
    await row.locator(".row__head").click();

    // No spark columns; the panel explains history could not be loaded.
    await expect(row.locator(".detail .spark__col")).toHaveCount(0);
    await expect(row.locator(".detail")).toContainText(/could not load|no recent samples/i);
  });
});
