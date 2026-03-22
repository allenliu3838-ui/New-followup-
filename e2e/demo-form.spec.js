// @ts-check
const { test, expect } = require("@playwright/test");

test.describe("/demo form flow", () => {
  test("Initial state: form visible, success hidden", async ({ page }) => {
    await page.goto("/demo");

    const form = page.locator("[data-testid=demo-form]");
    const success = page.locator("[data-testid=demo-success]");
    const error = page.locator("[data-testid=demo-error]");

    await expect(form).toBeVisible();
    await expect(success).not.toBeVisible();
    await expect(error).not.toBeVisible();
  });

  test("Submit button disabled during submission", async ({ page }) => {
    await page.goto("/demo");

    // Fill required fields
    await page.fill("#f_name", "测试用户");
    await page.fill("#f_institution", "测试医院");
    await page.fill("#f_email", "test@example.com");
    await page.selectOption("#f_inquiry_type", "预约演示");

    // Intercept the Supabase request to delay it
    await page.route("**/rest/v1/demo_requests**", async (route) => {
      // Delay response to test button state
      await new Promise((r) => setTimeout(r, 1000));
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: "[]",
      });
    });

    const submitBtn = page.locator("[data-testid=demo-submit]");
    await submitBtn.click();

    // Button should be disabled during submission
    await expect(submitBtn).toBeDisabled();
    await expect(submitBtn).toHaveText("提交中…");
  });

  test("Failed submission shows error, allows retry", async ({ page }) => {
    await page.goto("/demo");

    // Fill required fields
    await page.fill("#f_name", "测试用户");
    await page.fill("#f_institution", "测试医院");
    await page.fill("#f_email", "test@example.com");
    await page.selectOption("#f_inquiry_type", "预约演示");

    // Mock a failed response
    await page.route("**/rest/v1/demo_requests**", async (route) => {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ message: "Test error" }),
      });
    });

    await page.locator("[data-testid=demo-submit]").click();
    await page.waitForTimeout(2000);

    // Error should be shown
    const error = page.locator("[data-testid=demo-error]");
    await expect(error).toBeVisible();

    // Button should be re-enabled for retry
    const submitBtn = page.locator("[data-testid=demo-submit]");
    await expect(submitBtn).toBeEnabled();
    await expect(submitBtn).toHaveText("提交申请");

    // Success should NOT be shown
    const success = page.locator("[data-testid=demo-success]");
    await expect(success).not.toBeVisible();
  });
});
