// @ts-check
const { test, expect } = require("@playwright/test");

test.describe("Checkout page state machine", () => {
  test("Step 1 is active by default when logged in", async ({ page }) => {
    // This test requires login; skip if no credentials
    const email = process.env.E2E_TEST_EMAIL;
    const password = process.env.E2E_TEST_PASSWORD;
    test.skip(!email || !password, "Skipped: credentials not set");

    await page.goto("/staff");
    await page.fill("#email", email);
    await page.fill("#password", password);
    await page.click("#btnSendLink");
    await page.waitForTimeout(3000);

    await page.goto("/checkout");
    const main = page.locator("[data-testid=checkout-main]");
    await expect(main).toBeVisible({ timeout: 10000 });

    // Step 1 should be active
    const step1 = page.locator("#step1");
    await expect(step1).toHaveClass(/active/);

    // Step 4 (confirmation) should NOT be active
    const step4 = page.locator("#step4");
    await expect(step4).not.toHaveClass(/active/);
  });

  test("Mutual exclusivity: only one step visible at a time", async ({
    page,
  }) => {
    const email = process.env.E2E_TEST_EMAIL;
    const password = process.env.E2E_TEST_PASSWORD;
    test.skip(!email || !password, "Skipped: credentials not set");

    await page.goto("/staff");
    await page.fill("#email", email);
    await page.fill("#password", password);
    await page.click("#btnSendLink");
    await page.waitForTimeout(3000);

    await page.goto("/checkout");
    await page.waitForSelector("[data-testid=checkout-main]", {
      state: "visible",
    });

    // Count visible steps
    const visibleSteps = await page.evaluate(() => {
      return document.querySelectorAll(".step.active").length;
    });
    expect(visibleSteps).toBe(1);
  });
});
