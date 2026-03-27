// @ts-check
const { test, expect } = require("@playwright/test");

test.describe("Pre-launch: CTA links unified — no trial CTAs point to /staff", () => {
  test("Homepage hero CTA → /signup?trial=1", async ({ page }) => {
    await page.goto("/");
    const heroCta = page.locator('a[data-track="click_start_trial"][data-track-source="hero"]');
    await expect(heroCta).toHaveAttribute("href", "/signup?trial=1");
  });

  test("Homepage login CTA → /login", async ({ page }) => {
    await page.goto("/");
    const loginCta = page.locator('a[data-track="click_login"][data-track-source="hero"]');
    await expect(loginCta).toHaveAttribute("href", "/login");
  });

  test("Homepage onboarding trial CTA → /signup?trial=1", async ({ page }) => {
    await page.goto("/");
    const cta = page.locator('a[data-track="click_start_trial"][data-track-source="onboarding"]');
    await expect(cta).toHaveAttribute("href", "/signup?trial=1");
  });

  test("Homepage pricing trial CTA → /signup?trial=1", async ({ page }) => {
    await page.goto("/");
    const cta = page.locator('a[data-track="click_start_trial"][data-track-source="pricing"]');
    await expect(cta).toHaveAttribute("href", "/signup?trial=1");
  });

  test("/pricing: no trial CTA points to /staff", async ({ page }) => {
    await page.goto("/pricing");
    const staffLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href="/staff"]')).map(a => a.textContent.trim());
    });
    // There should be no links to /staff on pricing page
    expect(staffLinks.length).toBe(0);
  });

  test("/security: no trial CTA points to /staff", async ({ page }) => {
    await page.goto("/security");
    const staffLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href="/staff"]')).map(a => a.textContent.trim());
    });
    expect(staffLinks.length).toBe(0);
  });

  test("/deployment: no trial CTA points to /staff", async ({ page }) => {
    await page.goto("/deployment");
    const staffLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href="/staff"]')).map(a => a.textContent.trim());
    });
    expect(staffLinks.length).toBe(0);
  });

  test("/slides: no CTA points to /staff", async ({ page }) => {
    await page.goto("/slides");
    const staffLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href="/staff"]')).map(a => a.textContent.trim());
    });
    expect(staffLinks.length).toBe(0);
  });
});

test.describe("Pre-launch: Auth callback page", () => {
  test("/auth/callback loads and shows loading state", async ({ page }) => {
    await page.goto("/auth/callback");
    // Should show the loading or error state (no tokens → error)
    const errorCard = page.locator("[data-testid=auth-callback-error]");
    await expect(errorCard).toBeVisible({ timeout: 10000 });
  });

  test("/auth/callback error state has resend button", async ({ page }) => {
    await page.goto("/auth/callback");
    const resendBtn = page.locator("[data-testid=auth-callback-resend]");
    await expect(resendBtn).toBeVisible({ timeout: 10000 });
    await expect(resendBtn).toHaveAttribute("href", "/login");
  });

  test("/auth/callback shows error message for no tokens", async ({ page }) => {
    await page.goto("/auth/callback");
    const errorMsg = page.locator("[data-testid=auth-callback-error-msg]");
    await expect(errorMsg).toBeVisible({ timeout: 10000 });
    const text = await errorMsg.textContent();
    expect(text.length).toBeGreaterThan(5);
  });
});

test.describe("Pre-launch: Protected routes", () => {
  test("/staff anonymous: login card visible, authGated hidden", async ({ page }) => {
    await page.goto("/staff");
    const loginCard = page.locator("[data-testid=login-card]");
    await expect(loginCard).toBeVisible({ timeout: 10000 });

    // authGated wrapper should have hidden attribute
    const authGatedHidden = await page.evaluate(() => {
      const el = document.getElementById("authGated");
      return el ? el.hidden : null;
    });
    expect(authGatedHidden).toBe(true);
  });

  test("/staff anonymous: no workspace module titles visible", async ({ page }) => {
    await page.goto("/staff");
    await page.waitForTimeout(2000);

    // These module titles should NOT be visible
    const moduleTitles = ["研究者资料", "我的项目列表", "患者（去标识化）", "导出论文包"];
    for (const title of moduleTitles) {
      const visibleText = await page.evaluate((t) => {
        const els = document.querySelectorAll("#authGated h2, #authGated h3");
        return Array.from(els).some(el => el.offsetParent !== null && el.textContent.includes(t));
      }, title);
      expect(visibleText).toBe(false);
    }
  });
});

test.describe("Pre-launch: Checkout guest state", () => {
  test("Guest: shows login prompt, hides checkout main", async ({ page }) => {
    await page.goto("/checkout");
    const loginPrompt = page.locator("[data-testid=checkout-login-prompt]");
    const mainContent = page.locator("[data-testid=checkout-main]");
    await expect(loginPrompt).toBeVisible({ timeout: 10000 });
    await expect(mainContent).not.toBeVisible();
  });

  test("Guest: no order details, no proof status, no my orders loading", async ({ page }) => {
    await page.goto("/checkout");
    await page.waitForTimeout(2000);
    const pageText = await page.textContent("body");
    expect(pageText).not.toContain("凭证已提交");
    expect(pageText).not.toContain("加载中");
    // "我的订单" header is inside checkoutMain which is hidden
    const myOrdersVisible = await page.evaluate(() => {
      const el = document.getElementById("myOrdersCard");
      return el ? el.offsetParent !== null : false;
    });
    expect(myOrdersVisible).toBe(false);
  });

  test("Guest: step3 has no payment info", async ({ page }) => {
    await page.goto("/checkout");
    await page.waitForTimeout(1000);
    const step3Html = await page.evaluate(() => {
      const el = document.getElementById("step3Content");
      return el ? el.innerHTML : "";
    });
    expect(step3Html).not.toContain("pay-tab");
    expect(step3Html).not.toContain("upload-zone");
    expect(step3Html).toContain("请先完成前两步");
  });
});

test.describe("Pre-launch: Data storage copy consistency", () => {
  test("slides.html does not mention Singapore", async ({ page }) => {
    await page.goto("/slides");
    const content = await page.content();
    expect(content).not.toContain("新加坡");
    expect(content).not.toContain("Singapore");
  });

  test("slides.html mentions 中国区域", async ({ page }) => {
    await page.goto("/slides");
    const content = await page.content();
    expect(content).toContain("中国区域");
  });
});

test.describe("Pre-launch: Compliance footer", () => {
  const pagesToCheck = ["/", "/login", "/signup", "/pricing", "/security", "/deployment", "/checkout"];

  for (const path of pagesToCheck) {
    test(`${path}: footer has 隐私政策 + 用户协议 + 免责声明`, async ({ page }) => {
      await page.goto(path);
      const footer = page.locator(".site-footer");
      await expect(footer.locator('a[href="/privacy"]')).toBeVisible();
      await expect(footer.locator('a[href="/terms"]')).toBeVisible();
      await expect(footer.locator('a[href="/disclaimer"]')).toBeVisible();
    });
  }
});

test.describe("Pre-launch: Public docs do not expose internals", () => {
  test("/user-manual-cn does not contain deployment secrets", async ({ page }) => {
    await page.goto("/user-manual-cn");
    const content = await page.content();
    expect(content).not.toContain("run_all_migrations.sql");
    expect(content).not.toContain("SUPABASE_ANON_KEY");
    expect(content).not.toContain("Redirect URLs");
    expect(content).not.toContain("Publish directory");
    // site/config.js should not appear as a deployment instruction
    expect(content).not.toContain("site/config.js");
  });
});

test.describe("Pre-launch: Signup has consent checkbox", () => {
  test("/signup: terms consent checkbox exists", async ({ page }) => {
    await page.goto("/signup");
    const checkbox = page.locator("#agreeTerms");
    await expect(checkbox).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Pre-launch: Checkout has consent checkbox", () => {
  test("/checkout: terms consent checkbox exists in DOM", async ({ page }) => {
    await page.goto("/checkout");
    // The checkbox is inside checkoutMain (hidden for guests) but should exist in DOM
    const checkbox = await page.evaluate(() => {
      const el = document.getElementById("agreeTermsCheckout");
      return el !== null;
    });
    expect(checkbox).toBe(true);
  });
});
