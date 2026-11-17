import { expect, test } from "@playwright/test";
import { register, tapMove } from "./helpers";

test.describe("Scenario C — Stockfish game review", () => {
  test("scholar's mate is analysed, blunder explained, practised and tracked", async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "runs once on desktop");
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await register(a, "ra");
    const nameB = await register(b, "rb");
    await a.goto(`/profile/${nameB}`);
    await a.getByRole("button", { name: "Challenge" }).click();
    await a.getByRole("tab", { name: "White" }).click();
    await a.getByRole("button", { name: "Send challenge" }).click();
    await b.goto("/challenges");
    await b.locator("main").getByRole("button", { name: "Accept" }).first().click();
    await Promise.all([a.waitForURL(/\/game\//, { timeout: 30_000 }), b.waitForURL(/\/game\//, { timeout: 30_000 })]);
    await a.waitForSelector("text=Make your first move");
    const script = ["e2e4", "e7e5", "d1h5", "b8c6", "f1c4", "g8f6", "h5f7"];
    for (let i = 0; i < script.length; i++) {
      const mover = i % 2 === 0 ? a : b;
      const other = i % 2 === 0 ? b : a;
      await tapMove(mover, script[i]!, i % 2 === 0 ? "white" : "black", false);
      await expect(other.locator(`[data-ply="${i + 1}"]`)).toBeVisible();
    }
    await expect(a.getByText("Victory")).toBeVisible();
    await expect(b.getByText("Defeat")).toBeVisible();

    await b.getByRole("link", { name: "Game Review" }).click();
    await b.waitForURL(/\/review\//);
    await b.getByRole("button", { name: "Start Game Review" }).click();
    await expect(b.getByText("Stockfish", { exact: false }).first()).toBeVisible({ timeout: 180_000 });
    await expect(b.locator("text=/Blunder/").first()).toBeVisible({ timeout: 180_000 });
    await b.locator('[data-ply="6"]').click();
    await expect(b.getByText(/allows a forced mate/)).toBeVisible();
    await expect(b.getByRole("img", { name: "Evaluation graph" })).toBeVisible();
    await b.getByRole("tab", { name: "Coach" }).click();
    await expect(b.getByText("What you did well")).toBeVisible();
    await expect(b.getByText("Biggest mistakes")).toBeVisible();

    await b.goto("/improve/mistakes");
    await expect(b.getByText(/find a better move than Nf6/)).toBeVisible();
    await tapMove(b, "g7g6", "black", false);
    await expect(b.getByText(/exactly what the engine|also strong/)).toBeVisible({ timeout: 30_000 });
    await b.goto("/improve");
    await expect(b.getByText(/1 solved/)).toBeVisible();
    await ctxA.close();
    await ctxB.close();
  });
});
