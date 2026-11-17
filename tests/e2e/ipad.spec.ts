import { expect, test } from "@playwright/test";
import { register, squareCenter, tapMove } from "./helpers";

test.describe("Scenario D — iPad gestures", () => {
  test("touch tap-to-move, arrow drawing, flip and promotion dialog on the analysis board", async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith("ipad"), "iPad projects only");
    await register(page, "ipad");
    await page.goto("/analysis");
    const board = page.getByRole("application", { name: "Chess board" });
    await expect(board).toBeVisible();
    // No horizontal overflow and the board fits the viewport.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const box = await board.boundingBox();
    const vp = page.viewportSize()!;
    expect(box!.width).toBeLessThanOrEqual(vp.width);

    // Tap-to-move with the touchscreen.
    await tapMove(page, "e2e4", "white", true);
    await expect(page.locator('[data-ply="1"]')).toHaveText("e4");
    await tapMove(page, "e7e5", "white", true); // board orientation is still white
    await expect(page.locator('[data-ply="2"]')).toHaveText("e5");

    // Drawing an arrow with the right mouse button (desktop) is replaced on touch by annotation mode on the live game.
    // Here we test the SVG overlay via right-button drag which pointer events map identically.
    const from = await squareCenter(page, "g1", "white");
    const to = await squareCenter(page, "f3", "white");
    await page.mouse.move(from.x, from.y);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await page.mouse.up({ button: "right" });
    await expect(board.locator("svg polygon")).toHaveCount(1);

    // Flip the board.
    await page.getByRole("button", { name: "Flip" }).click();
    const a1 = await squareCenter(page, "a1", "black");
    expect(a1.x).toBeGreaterThan(box!.x + box!.width / 2); // a1 is now on the right

    // Promotion dialog by touch: set up a position with a pawn about to promote.
    await page.getByRole("button", { name: "Import" }).click();
    await page.getByPlaceholder("Or paste a FEN").fill("8/P7/8/8/8/8/8/K6k w - - 0 1");
    await page.getByRole("button", { name: "Load FEN" }).click();
    await page.getByRole("button", { name: "Flip" }).click(); // back to white orientation
    await tapMove(page, "a7a8", "white", true);
    await expect(page.getByRole("dialog", { name: "Choose promotion piece" })).toBeVisible();
    const knight = page.getByRole("button", { name: "Knight" });
    const kb = await knight.boundingBox();
    await page.touchscreen.tap(kb!.x + kb!.width / 2, kb!.y + kb!.height / 2);
    await expect(page.locator('[data-ply="1"]')).toHaveText(/a8=N/);
  });
});
