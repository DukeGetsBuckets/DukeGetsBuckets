import { expect, test } from "@playwright/test";
import { register, tapMove } from "./helpers";

/**
 * Play-the-bot: on-device Stockfish at ~2000 Elo that shows its thinking. Runs on every project so the
 * layout is exercised on desktop and both iPad orientations.
 */
test.describe("Scenario E — play the bot", () => {
  test("bot replies within a couple of seconds and explains its thinking", async ({ page }, testInfo) => {
    const touch = testInfo.project.name.startsWith("ipad");
    await register(page, "bot");
    await page.getByRole("link", { name: /Play the bot/ }).click();
    await expect(page).toHaveURL(/\/play\/bot$/);
    await expect(page.getByRole("tab", { name: "2000" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "Start game" }).click();

    const status = page.getByTestId("bot-status");
    await expect(status).toHaveText("Your move", { timeout: 30_000 }); // includes the one-off engine download
    // Full-strength look at the start position feeds the eval bar text.
    await expect(page.getByTestId("bot-eval")).not.toHaveText("Evaluating…", { timeout: 15_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

    // Hint shows the engine's move for the player with an arrow on the board.
    await page.getByTestId("bot-hint").click();
    await expect(page.getByTestId("bot-thinking")).toContainText(/\(([+−]\d\.\d\d|0\.00), depth \d+\)/);
    await expect(page.getByRole("application", { name: "Chess board" }).locator("svg polygon")).not.toHaveCount(0);
    await page.getByTestId("bot-hint").click();

    // Play 1.e4 and time the bot's reply; while it thinks its candidates are listed.
    const t0 = Date.now();
    await tapMove(page, "e2e4", "white", touch);
    await expect(page.locator('[data-ply="1"]')).toHaveText("e4");
    await expect(page.getByTestId("bot-thinking")).toContainText("What the bot is considering");
    await expect(page.locator('[data-ply="2"]')).toBeVisible({ timeout: 10_000 });
    const replyMs = Date.now() - t0;
    testInfo.annotations.push({ type: "bot reply ms", description: String(replyMs) });
    expect(replyMs).toBeLessThan(5_000);

    // The thought card: its reasoning, candidates, expected line, and a verdict on 1.e4.
    const card = page.getByTestId("bot-thought").first();
    await expect(card).toContainText("Considered:");
    await expect(card).toContainText("depth");
    await expect(card).toContainText("Your 1.e4");
    await expect(card.locator("li")).not.toHaveCount(0);
    await expect(status).toHaveText("Your move");

    // The game survives a reload (Safari often reloads background tabs).
    await page.reload();
    await expect(page.locator('[data-ply="2"]')).toBeVisible();
    await expect(page.getByTestId("bot-thought")).toHaveCount(1);

    // Take back returns to the position before 1.e4 and drops the bot's thought.
    await page.getByRole("button", { name: "Take back" }).click();
    await expect(page.locator('[data-ply="1"]')).toHaveCount(0);
    await expect(page.getByTestId("bot-thought")).toHaveCount(0);
    await expect(status).toHaveText("Your move");

    // Resign ends the game.
    await page.getByRole("button", { name: "Resign" }).click();
    await expect(page.getByTestId("bot-outcome")).toContainText("You resigned");
  });

  test("as Black the bot opens and the board is flipped", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "orientation logic is shared; one project is enough");
    await register(page, "botb");
    await page.goto("/play/bot");
    await page.getByRole("tab", { name: "Black" }).click();
    await page.getByRole("tab", { name: "1400" }).click();
    await page.getByRole("button", { name: "Start game" }).click();
    await expect(page.locator('[data-ply="1"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("bot-thought")).toHaveCount(1);
    await expect(page.getByText("Tempo Bot · 1400")).toBeVisible();
    await expect(page.getByText("You (Black)")).toBeVisible();
    // a1 is in the top-right corner when viewing from Black's side.
    const board = page.getByRole("application", { name: "Chess board" });
    const box = (await board.boundingBox())!;
    const a8 = await page.evaluate(() => {
      const el = document.querySelector('[data-square="a8"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (a8) expect(a8.y).toBeGreaterThan(box.y + box.height / 2); // a8 is at the bottom for Black
  });
});
