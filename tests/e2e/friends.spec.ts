import { expect, test } from "@playwright/test";
import { register, tapMove } from "./helpers";

test.describe("Scenario B — friends", () => {
  test("quick add, accept, challenge to 10 minutes, draw, rematch", async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "runs once on desktop");
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const ctxB = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true });
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    const nameA = await register(a, "fa");
    const nameB = await register(b, "fb");
    await a.goto("/friends");
    await b.goto("/friends");
    await a.getByPlaceholder("Search by username…").fill(nameB.slice(0, 6));
    await a.getByRole("button", { name: "Add friend" }).first().click();
    await expect(b.locator("main").getByText(nameA)).toBeVisible();
    await b.locator("main").getByRole("button", { name: "Accept" }).first().click();
    await expect(a.locator("main").getByText("Online").first()).toBeVisible();

    await a.locator("main").getByRole("button", { name: "Challenge" }).first().click();
    await a.getByRole("button", { name: /10\+0/ }).click();
    await a.getByRole("button", { name: "Send challenge" }).click();
    await b.goto("/challenges");
    await b.locator("main").getByRole("button", { name: "Accept" }).first().click();
    await Promise.all([a.waitForURL(/\/game\//, { timeout: 30_000 }), b.waitForURL(/\/game\//, { timeout: 30_000 })]);
    expect(a.url()).toBe(b.url());
    await a.waitForSelector("text=/Make your first move|Waiting for opponent/");
    const aIsWhite = /Make your first move/.test((await a.locator(".card.flex.items-center.justify-between span").first().textContent()) ?? "");
    const white = aIsWhite ? a : b;
    const black = aIsWhite ? b : a;
    await tapMove(white, "d2d4", "white", false);
    await expect(black.locator('[data-ply="1"]')).toHaveText("d4");
    await tapMove(black, "d7d5", "black", false);
    await expect(white.locator('[data-ply="2"]')).toHaveText("d5");
    await white.getByRole("button", { name: "Offer draw" }).click();
    await black.getByRole("button", { name: "Accept draw" }).click();
    await expect(white.getByText("Draw", { exact: true })).toBeVisible();
    const prev = a.url();
    await b.getByRole("button", { name: "Rematch" }).click();
    await a.getByRole("button", { name: "Accept rematch" }).click();
    await Promise.all([a.waitForURL((u) => u.toString() !== prev && /\/game\//.test(u.toString())), b.waitForURL((u) => u.toString() !== prev && /\/game\//.test(u.toString()))]);
    expect(a.url()).toBe(b.url());
    await a.getByRole("button", { name: "Abort" }).click();
    await ctxA.close();
    await ctxB.close();
  });
});
