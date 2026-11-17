import { expect, test } from "@playwright/test";
import { dragMove, startMatch, tapMove } from "./helpers";

test.describe("Scenario A — random multiplayer", () => {
  test("two accounts match, play with taps and drags, premove, finish and review", async ({ browser }, testInfo) => {
    const isTouch = testInfo.project.name.startsWith("ipad");
    const ctxA = await browser.newContext({ ...testInfo.project.use, viewport: testInfo.project.use.viewport ?? undefined });
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const m = await startMatch(browser, { a: ctxA, b: ctxB, category: "Blitz" });
    const whiteTouch = m.white === m.a ? isTouch : false;
    const blackTouch = m.black === m.a ? isTouch : false;

    // Board is fully visible: not clipped by the viewport in this layout.
    const box = await m.a.getByRole("application", { name: "Chess board" }).boundingBox();
    const vp = m.a.viewportSize()!;
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height + 1);
    expect(await m.a.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

    await tapMove(m.white, "e2e4", "white", whiteTouch);
    await expect(m.black.locator('[data-ply="1"]')).toHaveText("e4");
    await tapMove(m.black, "e7e5", "black", blackTouch);
    await expect(m.white.locator('[data-ply="2"]')).toHaveText("e5");
    // Drag-and-drop (pointer events) from the desktop side.
    const dragger = m.white === m.b ? m.white : m.black; // b is always desktop
    if (dragger === m.white) {
      await dragMove(m.white, "g1f3", "white");
      await expect(m.black.locator('[data-ply="3"]')).toHaveText("Nf3");
    } else {
      await tapMove(m.white, "g1f3", "white", whiteTouch);
      await expect(m.black.locator('[data-ply="3"]')).toHaveText("Nf3");
    }
    // Premove: black queues Nc6 while white is to move? No — black is to move now. White premoves d2d3 while black thinks.
    await tapMove(m.white, "d2d3", "white", whiteTouch); // sets a premove (not white's turn)
    await expect(m.white.locator("text=/premove|Opponent's move/i").first()).toBeVisible();
    await tapMove(m.black, "b8c6", "black", blackTouch);
    await expect(m.white.locator('[data-ply="5"]')).toHaveText("d3", { timeout: 10_000 });
    await expect(m.black.locator('[data-ply="5"]')).toHaveText("d3");

    // Clocks are running and displayed for both.
    await expect(m.a.locator('[aria-label="white clock"]:visible').first()).toBeVisible();
    await expect(m.a.locator('[aria-label="black clock"]:visible').first()).toBeVisible();

    // Black resigns (confirmation dialog), both see the same result and rating change.
    await m.black.getByRole("button", { name: "Resign", exact: true }).first().click();
    await m.black.getByRole("dialog").getByRole("button", { name: "Resign" }).click();
    await expect(m.white.getByText("Victory")).toBeVisible();
    await expect(m.black.getByText("Defeat")).toBeVisible();
    await expect(m.white.getByText(/→/)).toBeVisible();
    await expect(m.black.getByText(/→/)).toBeVisible();

    // Game review page opens for the finished game and can be requested.
    await m.white.getByRole("link", { name: "Game Review" }).click();
    await m.white.waitForURL(/\/review\//);
    await expect(m.white.getByRole("button", { name: "Start Game Review" })).toBeVisible();
    await ctxA.close();
    await ctxB.close();
  });
});
