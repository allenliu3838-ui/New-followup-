// @ts-check
const { test, expect } = require("@playwright/test");

test.describe("Checkout page state machine", () => {
  test("Anonymous: no payment info in DOM at all", async ({ page }) => {
    await page.goto("/checkout");
    await page.waitForTimeout(2000);

    // Step 3 content should be a placeholder
    const step3Html = await page.evaluate(() => {
      const el = document.getElementById("step3Content");
      return el ? el.innerHTML : "";
    });
    expect(step3Html).not.toContain("微信支付");
    expect(step3Html).not.toContain("支付宝");
    expect(step3Html).not.toContain("对公转账");
    expect(step3Html).not.toContain("upload-zone");
  });

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

    // Step 3 should not yet contain payment info (no order created)
    const step3Html = await page.evaluate(() => {
      const el = document.getElementById("step3Content");
      return el ? el.innerHTML : "";
    });
    expect(step3Html).not.toContain("pay-tab");
    expect(step3Html).toContain("请先完成前两步");
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

  test("Consent checkbox required before order creation", async ({ page }) => {
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

    // Consent checkbox should be visible on step 2
    await page.click("#btnToStep2");
    const checkbox = page.locator("#agreeTermsCheckout");
    await expect(checkbox).toBeVisible();
  });
});
