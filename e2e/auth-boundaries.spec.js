// @ts-check
const { test, expect } = require("@playwright/test");

test.describe("Auth boundaries — anonymous access", () => {
  test("/staff anonymous: shows login, workspace NOT in DOM at all", async ({ page }) => {
    await page.goto("/staff");

    // Login card should be visible
    const loginCard = page.locator("[data-testid=login-card]");
    await expect(loginCard).toBeVisible({ timeout: 10000 });

    // Workspace card should NOT exist in DOM (inside template, not injected)
    const workspaceExists = await page.evaluate(() => document.getElementById("appCard") !== null);
    expect(workspaceExists).toBe(false);

    // Admin card should NOT exist in DOM
    const adminExists = await page.evaluate(() => document.getElementById("adminCard") !== null);
    expect(adminExists).toBe(false);
  });

  test("/staff anonymous: admin card NOT in DOM, no sales content", async ({ page }) => {
    await page.goto("/staff");
    await page.waitForTimeout(2000);

    // Admin card should NOT exist in DOM for anonymous (inside template)
    const adminCardExists = await page.evaluate(() => document.getElementById("adminCard") !== null);
    expect(adminCardExists).toBe(false);

    // Double-check: no sales/pricing keywords anywhere in active DOM
    const bodyText = await page.evaluate(() => {
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll("template").forEach(t => t.remove());
      return clone.textContent;
    });
    expect(bodyText).not.toContain("销售参考定价");
    expect(bodyText).not.toContain("¥12,800");
  });

  test("/staff anonymous: auth-gated container is empty (no protected content)", async ({ page }) => {
    await page.goto("/staff");
    await page.waitForTimeout(2000);

    // The authGatedContainer should be completely empty
    const containerHtml = await page.evaluate(() => {
      const el = document.getElementById("authGatedContainer");
      return el ? el.innerHTML.trim() : "";
    });
    expect(containerHtml).toBe("");
    // No protected keywords in active DOM
    const bodyText = await page.evaluate(() => {
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll("template").forEach(t => t.remove());
      return clone.textContent;
    });
    expect(bodyText).not.toContain("我的项目列表");
    expect(bodyText).not.toContain("研究者资料");
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

  test("/checkout anonymous: checkout steps/orders NOT in DOM", async ({ page }) => {
    await page.goto("/checkout");
    await page.waitForTimeout(2000);

    // checkoutMain should be empty (template not injected for guests)
    const mainHtml = await page.evaluate(() => {
      const el = document.getElementById("checkoutMain");
      return el ? el.innerHTML.trim() : "";
    });
    expect(mainHtml).toBe("");

    // No payment/order elements should exist in active DOM
    const bodyText = await page.evaluate(() => {
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll("template").forEach(t => t.remove());
      return clone.textContent;
    });
    expect(bodyText).not.toContain("我的订单");
    expect(bodyText).not.toContain("凭证已提交");
    expect(bodyText).not.toContain("加载中");
  });

  test("/login page loads correctly", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator("#email")).toBeVisible({ timeout: 5000 });
    await expect(page.locator("#password")).toBeVisible();
    await expect(page.locator("#btnLogin")).toBeVisible();
  });

  test("/signup page loads correctly", async ({ page }) => {
    await page.goto("/signup");
    await expect(page.locator("#email")).toBeVisible({ timeout: 5000 });
    await expect(page.locator("#password")).toBeVisible();
    await expect(page.locator("#btnRegister")).toBeVisible();
    await expect(page.locator("#agreeTerms")).toBeVisible();
  });

  test("Legal pages accessible", async ({ page }) => {
    for (const path of ["/privacy", "/terms"]) {
      await page.goto(path);
      await expect(page.locator(".card")).toBeVisible({ timeout: 5000 });
    }
  });

  test("Homepage CTAs point to /signup and /login", async ({ page }) => {
    await page.goto("/");
    const trialBtn = page.locator('a[data-track="click_start_trial"]');
    const loginBtn = page.locator('a[data-track="click_login"]');
    await expect(trialBtn).toHaveAttribute("href", "/signup?trial=1");
    await expect(loginBtn).toHaveAttribute("href", "/login");
  });

  test("Checkout login link includes returnTo", async ({ page }) => {
    await page.goto("/checkout");
    await page.waitForTimeout(2000);
    const link = page.locator("[data-testid=checkout-login-link]");
    await expect(link).toHaveAttribute("href", "/login?returnTo=/checkout");
  });

  test("Footer contains privacy and terms links", async ({ page }) => {
    await page.goto("/");
    const footer = page.locator(".site-footer");
    await expect(footer.locator('a[href="/privacy"]')).toBeVisible();
    await expect(footer.locator('a[href="/terms"]')).toBeVisible();
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

    // Admin card should still be hidden for normal user (empty DOM)
    const adminCard = page.locator("[data-testid=admin-card]");
    await expect(adminCard).not.toBeVisible();

    // Verify admin card content is still empty for non-admin
    const adminContent = await page.evaluate(() => {
      const el = document.getElementById("adminCard");
      return el ? el.innerHTML.trim() : "";
    });
    expect(adminContent).toBe("");

    // Sign-out button should be visible
    const signoutBtn = page.locator("[data-testid=signout-btn]");
    await expect(signoutBtn).toBeVisible();
  });
});
