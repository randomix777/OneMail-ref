import { expect } from "@playwright/test";
import { test } from "../playwright-test";

for (const path of ["/login/email", "/login/options"]) {
  test(`routes ${path} to the JYI sign-in page`, async ({ page }) => {
    await page.route("**/api/auth/sign-in/oauth2", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          message: "Sign-in is unavailable in this test",
        }),
      }),
    );
    await page.context().clearCookies();

    const response = await page.goto(`${path}?next=%2Fsettings`);

    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings$/);
    await expect(
      page.getByRole("heading", { name: /Sign in to/ }),
    ).toBeVisible();
  });
}

test("legacy email-code endpoints are rejected", async ({ page }) => {
  await page.route("**/api/auth/sign-in/oauth2", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        message: "Sign-in is unavailable in this test",
      }),
    }),
  );
  await page.goto("/login");

  const statuses = await page.evaluate(async () => {
    const endpoints = [
      "/api/auth/email-otp/send-verification-otp",
      "/api/auth/sign-in/email-otp",
    ];
    const responses = await Promise.all(
      endpoints.map((endpoint) =>
        fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: "owner@example.com",
            type: "sign-in",
            otp: "123456",
          }),
        }),
      ),
    );
    return responses.map((response) => response.status);
  });

  expect(statuses).toEqual([403, 403]);
});
