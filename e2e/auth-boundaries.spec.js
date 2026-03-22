// @ts-check
const { test, expect } = require("@playwright/test");

test.describe("Auth boundaries — anonymous access", () => {
  test("/staff anonymous: shows login, hides workspace", async ({ page }) => {
    await page.goto("/staff");

    // Login card should be visible
    const loginCard = page.locator("[data-testid=login-card]");
    await expect(loginCard).toBeVisible({ timeout: 10000 });

    // Workspace card should NOT be visible
    const workspaceCard = page.locator("[data-testid=workspace-card]");
    await expect(workspaceCard).not.toBeVisible();

    // Admin card should NOT be visible
    const adminCard = page.locator("[data-testid=admin-card]");
    await expect(adminCard).not.toBeVisible();
  });

  test("/staff anonymous: cannot see admin-only elements", async ({ page }) => {
    await page.goto("/staff");
    // Wait for auth to resolve
    await page.waitForTimeout(2000);

    // Should not see any of these texts in visible elements
    const body = await page.locator("body").textContent();
    const visibleText = await page.evaluate(() => {
      // Get text from only visible elements
      const visible = [];
      document.querySelectorAll('[id="adminCard"], [id="appCard"]').forEach((el) => {
        if (el.offsetParent !== null || getComputedStyle(el).display !== "none") {
          visible.push(el.textContent);
        }
      });
      return visible.join(" ");
    });

    expect(visibleText).not.toContain("平台管理员");
    expect(visibleText).not.toContain("我的项目列表");
  });

  test("/checkout anonymous: shows login prompt, hides main content", async ({
    page,
  }) => {
    await page.goto("/checkout");

    const loginPrompt = page.locator("[data-testid=checkout-login-prompt]");
    const mainContent = page.locator("[data-testid=checkout-main]");

    await expect(loginPrompt).toBeVisible({ timeout: 10000 });
    await expect(mainContent).not.toBeVisible();
  });

  test("/checkout anonymous: no order data visible", async ({ page }) => {
    await page.goto("/checkout");
    await page.waitForTimeout(2000);

    const ordersEl = page.locator("[data-testid=my-orders]");
    // Should not contain "加载中…" since user is not logged in
    const text = await ordersEl.textContent();
    expect(text).not.toContain("加载中");
  });
});

test.describe("Auth boundaries — logged in (requires E2E_TEST_EMAIL)", () => {
  const email = process.env.E2E_TEST_EMAIL;
  const password = process.env.E2E_TEST_PASSWORD;

  test.skip(!email || !password, "Skipped: E2E_TEST_EMAIL/PASSWORD not set");

  test("/staff logged in: workspace visible, admin hidden for normal user", async ({
    page,
  }) => {
    await page.goto("/staff");

    // Login
    await page.fill("#email", email);
    await page.fill("#password", password);
    await page.click("#btnSendLink");

    // Wait for workspace to appear
    const workspaceCard = page.locator("[data-testid=workspace-card]");
    await expect(workspaceCard).toBeVisible({ timeout: 15000 });

    // Admin card should still be hidden for normal user
    const adminCard = page.locator("[data-testid=admin-card]");
    await expect(adminCard).not.toBeVisible();

    // Sign-out button should be visible
    const signoutBtn = page.locator("[data-testid=signout-btn]");
    await expect(signoutBtn).toBeVisible();
  });
});
