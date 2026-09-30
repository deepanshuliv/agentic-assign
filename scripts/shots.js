import { chromium } from "playwright";
const base = process.env.BASE || "http://localhost:3000";
const out = process.argv[2];
const pages = [["home", "#/"], ["pool", "#/pool"], ["profile", "#/p/3"], ["join", "#/join"], ["how", "#/how"]];
const browser = await chromium.launch();
for (const [vw, vh, tag, scheme] of [[1440, 900, "desk", "light"], [390, 844, "mob", "light"], [1440, 900, "dark", "dark"]]) {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, colorScheme: scheme, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  for (const [name, hash] of pages) {
    if (tag === "dark" && name !== "profile" && name !== "home") continue;
    await page.goto(base + "/" + hash); await page.waitForTimeout(1800);
    await page.screenshot({ path: `${out}/${tag}-${name}.png`, fullPage: tag !== "dark" });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (overflow) console.log("HORIZONTAL OVERFLOW", tag, name);
  }
  if (errs.length) console.log(tag, "errors:", errs);
  await ctx.close();
}
await browser.close();
