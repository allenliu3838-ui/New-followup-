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

test.describe("Pre-launch: Protected routes — DOM isolation", () => {
  test("/staff anonymous: login card visible, auth-gated content NOT in DOM", async ({ page }) => {
    await page.goto("/staff");
    const loginCard = page.locator("[data-testid=login-card]");
    await expect(loginCard).toBeVisible({ timeout: 10000 });

    // authGatedContainer should be empty (template not injected)
    const containerHtml = await page.evaluate(() => {
      const el = document.getElementById("authGatedContainer");
      return el ? el.innerHTML.trim() : null;
    });
    expect(containerHtml).toBe("");
  });

  test("/staff anonymous: protected element IDs not in DOM", async ({ page }) => {
    await page.goto("/staff");
    await page.waitForTimeout(2000);

    // These element IDs should NOT exist in the rendered DOM (they're inside <template>)
    const protectedIds = ["profileCard", "appCard", "projName", "patCode", "btnExportBaseline",
                          "btnPaperPack", "importType", "tokenOut", "labTestCode"];
    for (const id of protectedIds) {
      const exists = await page.evaluate((elemId) => document.getElementById(elemId) !== null, id);
      expect(exists).toBe(false);
    }
  });

  test("/staff anonymous: no workspace module titles in DOM at all", async ({ page }) => {
    await page.goto("/staff");
    await page.waitForTimeout(2000);

    // These module titles should NOT exist anywhere in the active DOM (only inside template)
    const moduleTitles = ["研究者资料", "我的项目列表", "患者（去标识化）", "导出论文包", "批量导入"];
    const bodyText = await page.evaluate(() => {
      // Get text from all elements EXCEPT template content
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll("template").forEach(t => t.remove());
      return clone.textContent;
    });
    for (const title of moduleTitles) {
      expect(bodyText).not.toContain(title);
    }
  });

  test("/staff anonymous: no data requests made (no Supabase RPC calls before auth)", async ({ page }) => {
    const rpcCalls = [];
    await page.route("**/rest/v1/rpc/**", (route) => {
      rpcCalls.push(route.request().url());
      route.continue();
    });
    await page.goto("/staff");
    await page.waitForTimeout(3000);
    // No RPC calls should be made for anonymous users (data loads only after auth)
    expect(rpcCalls.length).toBe(0);
  });
});

test.describe("Pre-launch: Checkout guest state — DOM isolation", () => {
  test("Guest: shows login prompt, checkout main is empty", async ({ page }) => {
    await page.goto("/checkout");
    const loginPrompt = page.locator("[data-testid=checkout-login-prompt]");
    await expect(loginPrompt).toBeVisible({ timeout: 10000 });
    // checkoutMain should exist but be empty (template not injected)
    const mainHtml = await page.evaluate(() => {
      const el = document.getElementById("checkoutMain");
      return el ? el.innerHTML.trim() : null;
    });
    expect(mainHtml).toBe("");
  });

  test("Guest: no order form, payment, or order status elements in DOM", async ({ page }) => {
    await page.goto("/checkout");
    await page.waitForTimeout(2000);
    // These IDs should NOT exist in DOM for guest (inside template)
    const protectedIds = ["step1", "step2", "step3", "step4", "myOrdersCard",
                          "payerName", "planCode", "proofFile", "s4OrderNo"];
    for (const id of protectedIds) {
      const exists = await page.evaluate((elemId) => document.getElementById(elemId) !== null, id);
      expect(exists).toBe(false);
    }
  });

  test("Guest: no checkout keywords in active DOM", async ({ page }) => {
    await page.goto("/checkout");
    await page.waitForTimeout(2000);
    const bodyText = await page.evaluate(() => {
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll("template").forEach(t => t.remove());
      return clone.textContent;
    });
    expect(bodyText).not.toContain("凭证已提交");
    expect(bodyText).not.toContain("我的订单");
    expect(bodyText).not.toContain("订单号");
    expect(bodyText).not.toContain("当前状态");
    expect(bodyText).not.toContain("加载中");
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
