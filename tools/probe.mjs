// Boot one disc through the page's ?disc= path the way the site does, and sample the HUD
// and the disc counters every second while pressing A now and then — enough input to get
// from the strap screen into a title's menus. Prints a one-line summary and leaves
// samples.json, console.log and canvas screenshots in the output directory.
//
//   node tools/probe.mjs --base-url http://127.0.0.1:8085/ --disc mkw.rvz --out ./probe-out
//                        [--duration 120] [--extra "fastsw=2&metrics=1"] [--profile <dir>]
//                        [--record [file]] [--playwright <path to playwright/index.mjs>] [--headed]
//
// --profile keeps the browser profile between runs (IndexedDB: the JIT cache, the saves),
// which is how a "second session" is measured and how a prebuilt JIT cache is grown.
// --record opens the page with ?recordreads=1 and, at the end, saves the order the core
// read the disc's blocks in (window.__discReadOrder) to <file>, by default
// <out>/<GAMEID>.reads.json — block numbers and times, nothing of the game. Kept beside the
// disc as <disc file>.reads.json, it puts those blocks first in a first launch's background
// download (the fork's src/remote-disc.js). The summary's disc90 is the disc counters at
// 90 s: the waits of a launch's first minute and a half.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).reduce((out, a, i, all) => {
  if (a.startsWith("--")) out.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "1"]);
  return out;
}, []));
const baseUrl = args["base-url"] || "http://127.0.0.1:8085/";
const disc = args.disc; if (!disc) throw new Error("--disc <name under the server's /disc/> is required");
const outDir = path.resolve(args.out || "./probe-out");
const duration = Number(args.duration || 120);
await mkdir(outDir, { recursive: true });
const { chromium } = await import(args.playwright ? pathToFileURL(path.resolve(args.playwright)).href : "playwright");

const url = new URL("index.html", baseUrl);
url.searchParams.set("disc", new URL(`disc/${disc}`, baseUrl).href);
url.searchParams.set("metrics", "1");
url.searchParams.set("jitwarmup", "700");
for (const kv of (args.extra || "").split("&").filter(Boolean)) { const [k, v] = kv.split("="); url.searchParams.set(k, v ?? ""); }
if (args.record) url.searchParams.set("recordreads", "1");

const lines = [], samples = [], t0 = Date.now();
const log = (s) => { const l = `[probe +${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`; console.log(l); lines.push(l); };
const mb = (b) => (b == null ? "?" : (b / 1048576).toFixed(0));
const launch = { channel: process.env.BROWSER_CHANNEL || "chrome", headless: !args.headed };
const context = args.profile
  ? await chromium.launchPersistentContext(path.resolve(args.profile), { ...launch, viewport: { width: 1280, height: 900 } })
  : await (await chromium.launch(launch)).newContext({ viewport: { width: 1280, height: 900 } });
const browser = context.browser?.();
const page = await context.newPage();
page.on("console", (m) => lines.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => lines.push(`[pageerror] ${e.stack || e.message}`));
page.on("worker", (w) => { const tag = `worker:${w.url()?.split("/").pop() || "?"}`; w.on("console", (m) => lines.push(`[${tag}:${m.type()}] ${m.text()}`)); });

const read = (sel) => document.querySelector(sel)?.textContent?.trim() ?? "";
try {
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.evaluate(() => { const p = document.querySelector("#debugPanel"); if (p?.hidden) document.querySelector("#debugToggle")?.click(); });
  for (let i = 0; i < 240; i++) {
    const badge = await page.evaluate(() => document.querySelector("#dropBadge")?.textContent?.trim() ?? "").catch(() => "");
    if (/^Start /.test(badge)) break;
    await page.waitForTimeout(250);
  }
  await page.click("#dropZone");
  for (let s = 0; ; s++) {
    const st = await page.evaluate(() => ({ coreMode: document.querySelector("#coreMode")?.textContent?.trim() ?? "", note: document.querySelector("#mountNote")?.textContent?.trim() ?? "", status: document.querySelector("#statusPill")?.textContent?.trim() ?? "" }));
    if (st.coreMode === "Dolphin") { log(`mounted: ${st.status} | ${st.note}`); break; }
    if (s >= 120) throw new Error(`mount timeout: ${st.status}`);
    await page.waitForTimeout(1000);
  }
  const box = await page.locator("#screen").boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  const shot = (tag) => page.locator("#screen").screenshot({ path: path.join(outDir, `canvas-${tag}.png`) }).catch(() => {});
  const tStart = Date.now();
  for (let s = 0; s <= duration; s++) {
    const x = await page.evaluate(() => {
      const info = window.__lastFrameInfo || {};
      const rd = (sel) => document.querySelector(sel)?.textContent?.trim() ?? "";
      const d = window.__discStats || {};
      return { frame: info.frame, gameSpeed: info.gameSpeed, coreFps: info.coreFps, presentFps: info.presentationFps ?? info.fps,
               visualFps: info.visualChangeFps, jitCompiled: info.ppcWasmBlockCompileCount ?? null, mountNote: rd("#mountNote"), status: rd("#statusPill"),
               // the tiered reader's counters (remote-disc.js): bytes from the server, waits on it and for how long,
               // bytes kept on the device, whether the whole image is there, hits served from the device
               disc: { bytes: d.bytes ?? null, waits: d.waits ?? null, waitMs: d.waitMs ?? null, storedBytes: d.storedBytes ?? null,
                       complete: d.complete ?? null, l2Hits: d.l2Hits ?? null, mode: d.mode ?? null,
                       readOrder: d.readOrder ?? null, recorded: d.recorded ?? null, sequential: d.sequential ?? null },
               helper: typeof info.ppcWasmHelperStats === "string" ? info.ppcWasmHelperStats.slice(0, 8000) : null };
    });
    x.t = (Date.now() - tStart) / 1000;
    samples.push(x);
    if (s % 10 === 0) log(`t=${s} frame=${x.frame} speed=${x.gameSpeed}% core=${x.coreFps} visual=${x.visualFps} jit=${x.jitCompiled}`
      + ` | disc ${mb(x.disc.bytes)} MB read, waited ${x.disc.waits ?? "?"}× (${((x.disc.waitMs ?? 0) / 1000).toFixed(1)} s), on device ${mb(x.disc.storedBytes)} MB${x.disc.complete ? " (all)" : ""}`);
    if (s % 20 === 0) await shot(`t${String(s).padStart(3, "0")}`);
    // From 20 s on: A on the Wii Remote (a click on the game) and A / Start on the GameCube pad
    // (X / Enter), every 4 s, with the pointer wandering a little — strap screen, title, licence,
    // into the menus; nothing a title could mistake for play.
    if (s >= 20 && s % 4 === 0) {
      await page.mouse.move(cx + ((s % 3) - 1) * 40, cy + ((s % 5) - 2) * 20);
      await page.mouse.down(); await page.waitForTimeout(80); await page.mouse.up();
      await page.keyboard.press(s % 8 === 0 ? "Enter" : "KeyX");
    }
    await page.waitForTimeout(Math.max(0, 1000 - 120));
  }
  await shot("final");
  if (args.record) {
    const order = await page.evaluate(() => window.__discReadOrder?.() ?? null);
    if (!order) throw new Error("no read order: the page has no window.__discReadOrder, or it wasn't recording");
    const file = path.resolve(args.record !== "1" ? args.record : path.join(outDir, `${order.game || order.name}.reads.json`));
    await writeFile(file, JSON.stringify(order));
    log(`read order: ${order.blocks.length} blocks of ${Math.ceil(order.size / order.block)} → ${file} (beside the disc as ${order.name}.reads.json)`);
  }
} catch (e) {
  log(`ERROR ${e.stack || e}`);
} finally {
  const spd = samples.filter((x) => x.t > 15).map((x) => Number(x.gameSpeed) || 0);
  const sorted = [...spd].sort((a, b) => a - b), q = (f) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))] : 0;
  const summary = { disc, extra: args.extra || "", samples: spd.length, frames: Number(samples.at(-1)?.frame) || 0,
    speed: { p10: q(0.1), median: q(0.5), p90: q(0.9), min: sorted[0] ?? 0, max: sorted.at(-1) ?? 0, under80: spd.filter((v) => v < 80).length },
    jitCompiled: samples.at(-1)?.jitCompiled ?? null, mountNote: samples.at(-1)?.mountNote ?? "", disc: samples.at(-1)?.disc ?? null,
    disc90: samples.filter((x) => x.t <= 90.5).at(-1)?.disc ?? null };
  log(`SUMMARY ${JSON.stringify(summary)}`);
  await writeFile(path.join(outDir, "samples.json"), JSON.stringify(samples, null, 1));
  await writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  await writeFile(path.join(outDir, "console.log"), lines.join("\n"));
  await context.close(); try { await browser?.close(); } catch {}
}
