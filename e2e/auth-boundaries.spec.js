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

  test("/staff anonymous: admin card DOM is empty (no sales content in public bundle)", async ({ page }) => {
    await page.goto("/staff");
    // Wait for JS to initialize
    await page.waitForTimeout(2000);

    // The admin card should exist but be empty — no internal sales pricing in DOM
    const adminCardContent = await page.evaluate(() => {
      const el = document.getElementById("adminCard");
      return el ? el.innerHTML.trim() : null;
    });
    // Admin card should be empty for anonymous users (content dynamically injected only after RPC check)
    expect(adminCardContent).toBe("");

    // Double-check: no sales/pricing keywords anywhere in the page source
    const pageContent = await page.content();
    expect(pageContent).not.toContain("销售参考定价");
    expect(pageContent).not.toContain("单中心轻定制");
    expect(pageContent).not.toContain("¥12,800");
    expect(pageContent).not.toContain("私有化 / 医院平台版");
    expect(pageContent).not.toContain("销售沟通要点");
  });

  test("/staff anonymous: cannot see admin-only elements", async ({ page }) => {
    await page.goto("/staff");
    // Wait for auth to resolve
    await page.waitForTimeout(2000);

    // Should not see any of these texts in visible elements
    const visibleText = await page.evaluate(() => {
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

  test("/checkout anonymous: no payment info (QR codes, bank details) in DOM", async ({ page }) => {
    await page.goto("/checkout");
    await page.waitForTimeout(2000);

    const pageContent = await page.content();
    // Payment QR images should not be present
    expect(pageContent).not.toContain("wechat-qr");
    expect(pageContent).not.toContain("alipay-qr");
    // Bank account should not be in DOM
    expect(pageContent).not.toContain("09-410901040031935");
    expect(pageContent).not.toContain("农业银行");
  });

  test("/checkout anonymous: no order data visible", async ({ page }) => {
    await page.goto("/checkout");
    await page.waitForTimeout(2000);

    const ordersEl = page.locator("[data-testid=my-orders]");
    // Should not contain "加载中…" since user is not logged in
    const text = await ordersEl.textContent();
    expect(text).not.toContain("加载中");
  });

  test("/checkout: step3 payment info only appears after order creation", async ({ page }) => {
    await page.goto("/checkout");
    await page.waitForTimeout(1000);

    // Step 3 should have placeholder, not payment details
    const step3Content = await page.evaluate(() => {
      const el = document.getElementById("step3Content");
      return el ? el.innerHTML : "";
    });
    expect(step3Content).not.toContain("pay-tab");
    expect(step3Content).not.toContain("upload-zone");
    expect(step3Content).toContain("请先完成前两步");
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
