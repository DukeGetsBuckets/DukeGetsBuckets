import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

export async function register(page: Page, prefix: string): Promise<string> {
  const name = `${prefix}_${Math.random().toString(36).slice(2, 7)}`;
  await page.goto("/register");
  await page.getByLabel("Username").fill(name);
  await page.getByLabel("Email").fill(`${name}@example.com`);
  await page.getByLabel("Password").fill("correct-horse-battery");
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.getByRole("button", { name: "Create account" }).click();
    const outcome = await Promise.race([
      page.waitForURL(/\/play/, { timeout: 30_000 }).then(() => "ok" as const),
      page.getByText("Too many requests").waitFor({ timeout: 30_000 }).then(() => "limited" as const),
    ]);
    if (outcome === "ok") return name;
    await page.waitForTimeout(20_000); // sign-up rate limit; wait for the window to pass
  }
  throw new Error("could not register (rate limited)");
}

export async function squareCenter(page: Page, square: string, orientation: "white" | "black"): Promise<{ x: number; y: number; size: number }> {
  const board = page.getByRole("application", { name: "Chess board" });
  await board.scrollIntoViewIfNeeded();
  // Keep the board clear of the sticky header and the bottom tab bar.
  await board.evaluate((el) => {
    const r = el.getBoundingClientRect();
    if (r.top < 72) window.scrollBy(0, r.top - 72);
    else if (r.bottom > window.innerHeight - 70) window.scrollBy(0, r.bottom - (window.innerHeight - 70));
  });
  const box = await board.boundingBox();
  if (!box) throw new Error("board not found");
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  const x = orientation === "white" ? file : 7 - file;
  const y = orientation === "white" ? 7 - rank : rank;
  const size = box.width / 8;
  return { x: box.x + (x + 0.5) * size, y: box.y + (y + 0.5) * size, size };
}

/** Tap-to-move using touch when the context supports it, otherwise mouse clicks. */
export async function tapMove(page: Page, uci: string, orientation: "white" | "black", touch: boolean): Promise<void> {
  const from = await squareCenter(page, uci.slice(0, 2), orientation);
  const to = await squareCenter(page, uci.slice(2, 4), orientation);
  if (touch) {
    await page.touchscreen.tap(from.x, from.y);
    await page.waitForTimeout(120);
    await page.touchscreen.tap(to.x, to.y);
  } else {
    await page.mouse.click(from.x, from.y);
    await page.waitForTimeout(120);
    await page.mouse.click(to.x, to.y);
  }
  await page.waitForTimeout(150);
}

export async function dragMove(page: Page, uci: string, orientation: "white" | "black"): Promise<void> {
  const from = await squareCenter(page, uci.slice(0, 2), orientation);
  const to = await squareCenter(page, uci.slice(2, 4), orientation);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

export async function startMatch(browser: Browser, opts: { a: BrowserContext; b: BrowserContext; category: "Bullet" | "Blitz" | "Rapid" }): Promise<{ a: Page; b: Page; white: Page; black: Page; nameA: string; nameB: string; gameId: string; touchA: boolean; touchB: boolean }> {
  void browser;
  const a = await opts.a.newPage();
  const b = await opts.b.newPage();
  const nameA = await register(a, "pa");
  const nameB = await register(b, "pb");
  await a.getByRole("button", { name: new RegExp(opts.category) }).click();
  await b.getByRole("button", { name: new RegExp(opts.category) }).click();
  await Promise.all([a.waitForURL(/\/game\//, { timeout: 30_000 }), b.waitForURL(/\/game\//, { timeout: 30_000 })]);
  expect(a.url()).toBe(b.url());
  await a.waitForSelector("text=/Make your first move|Waiting for opponent/", { timeout: 15_000 });
  const status = await a.locator(".card.flex.items-center.justify-between span").first().textContent();
  const aIsWhite = /Make your first move/.test(status ?? "");
  const gameId = a.url().split("/game/")[1]!;
  const touchA = Boolean(opts.a.pages()[0]?.context().browser()) && (await a.evaluate(() => "ontouchstart" in window));
  const touchB = await b.evaluate(() => "ontouchstart" in window);
  return { a, b, white: aIsWhite ? a : b, black: aIsWhite ? b : a, nameA, nameB, gameId, touchA, touchB };
}

export async function statusText(page: Page): Promise<string> {
  return (await page.locator(".card.flex.items-center.justify-between span").first().textContent()) ?? "";
}
