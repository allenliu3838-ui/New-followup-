// @ts-check
const { test, expect } = require("@playwright/test");

test.describe("Public pages — anonymous access", () => {
  test("Homepage: project count is not blank", async ({ page }) => {
    await page.goto("/");
    const heading = page.locator("[data-testid=project-heading]");
    await expect(heading).toBeVisible();

    // The count should be a number > 0 or the heading should be simplified
    const text = await heading.textContent();
    // Must NOT contain "·  个" (empty count with unit)
    expect(text).not.toMatch(/·\s*个/);
    // Either shows a number or hides the count entirely
    const count = page.locator("[data-testid=project-count]");
    const countText = await count.textContent();
    if (countText) {
      expect(parseInt(countText)).toBeGreaterThan(0);
    }
  });

  test("Homepage: core CTAs point to /signup and /login, not /staff", async ({ page }) => {
    await page.goto("/");
    // "开始 30 天试用" button links to /signup?trial=1
    const trialBtn = page.locator('a.btn.primary[href="/signup?trial=1"]').first();
    await expect(trialBtn).toBeVisible();
    expect(await trialBtn.getAttribute("href")).toBe("/signup?trial=1");
    // No trial CTA should point to /staff
    const staffTrialBtns = page.locator('a.btn.primary[href="/staff"]');
    await expect(staffTrialBtns).toHaveCount(0);
  });

  test("/demo: no success state on initial load", async ({ page }) => {
    await page.goto("/demo");
    const form = page.locator("[data-testid=demo-form]");
    const success = page.locator("[data-testid=demo-success]");

    await expect(form).toBeVisible();
    await expect(success).not.toBeVisible();
  });

  test("/pricing: price matches config", async ({ page }) => {
    await page.goto("/pricing");
    const priceEl = page.locator("[data-testid=pricing-pro-price]");
    await expect(priceEl).toBeVisible();
    const text = await priceEl.textContent();
    // Should contain ¥499 (from config default)
    expect(text).toContain("¥499");
    expect(text).toContain("3");
  });

  test("Homepage and /pricing prices match", async ({ page }) => {
    await page.goto("/");
    const indexPrice = await page
      .locator("[data-testid=index-pro-price]")
      .textContent();

    await page.goto("/pricing");
    const pricingPrice = await page
      .locator("[data-testid=pricing-pro-price]")
      .textContent();

    // Both should contain the same base price
    expect(indexPrice).toContain("¥499");
    expect(pricingPrice).toContain("¥499");
  });
});
