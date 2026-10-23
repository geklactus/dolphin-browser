// Grow a prebuilt JIT cache per title: for each disc in a library, boot it in a fresh
// browser profile through the package (tools/probe.mjs, which presses A now and then to
// get into the menus), then dump what the PPC→wasm JIT compiled out of the profile's
// IndexedDB with wasm-dolphin's exporter — prebuilt-jit-cache/<GAMEID>.bin, the file the
// page asks for once a disc has said who it is. Entries are compiled wasm translations of
// the game's own code, so the output belongs beside the discs on the server, never in a
// repository.
//
//   node tools/prebuild-jit-cache.mjs --pkg <package dir> --wasm-dolphin <checkout>
//        --library <disc dir> [--library <another>] --out <dir>
//        [--duration 150] [--filter <substring>] [--limit N] [--skip-existing]
//        [--playwright <playwright/index.mjs>] [--port 8089]
//   --playwright defaults to <wasm-dolphin>/.omx/browser-probe/node_modules/playwright/index.mjs
//   (npm install --prefix <wasm-dolphin>/.omx/browser-probe playwright) when that exists.
//
// Writes <out>/<GAMEID>.bin and <out>/index.json (title, file, modules, bytes, duration).
// The package's core decides the fingerprint; rebuild the caches after an engine bump.
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, writeFile, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2), args = {}, libraries = [];
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) continue;
  const key = argv[i].slice(2), val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "1";
  if (key === "library") libraries.push(path.resolve(val)); else args[key] = val;
}
for (const need of ["pkg", "wasm-dolphin", "out"]) if (!args[need]) { console.error(`--${need} is required`); process.exit(2); }
if (!libraries.length) { console.error("--library <dir> is required"); process.exit(2); }
const pkg = path.resolve(args.pkg), wasmDolphin = path.resolve(args["wasm-dolphin"]), out = path.resolve(args.out);
const duration = Number(args.duration || 150), port = Number(args.port || 8089), limit = Number(args.limit || 0);
// Playwright: the one the wasm-dolphin checkout keeps for its own browser tools
// (.omx/browser-probe/node_modules — where its exporter looks first), unless told otherwise.
const playwright = args.playwright
  ? path.resolve(args.playwright)
  : [path.join(wasmDolphin, ".omx", "browser-probe", "node_modules", "playwright", "index.mjs")].find((p) => existsSync(p)) ?? null;
const EXTS = new Set([".rvz", ".iso", ".gcm", ".wbfs", ".ciso"]);
await mkdir(out, { recursive: true });
const indexPath = path.join(out, "index.json");
const index = existsSync(indexPath) ? JSON.parse(await readFile(indexPath, "utf8")) : {};

// The game id from the disc header: raw at 0, RVZ keeps a copy at 0x58, CISO past 0x8000.
async function gameIdOf(file) {
  const fh = await open(file, "r");
  try {
    const head = Buffer.alloc(0x8010); await fh.read(head, 0, head.length, 0);
    const at = head.subarray(0, 3).toString("latin1") === "RVZ" ? 0x58 : head.subarray(0, 4).toString("latin1") === "CISO" ? 0x8000 : 0;
    const id = head.subarray(at, at + 6).toString("latin1");
    return /^[A-Z0-9]{6}$/.test(id) ? id : null;
  } finally { await fh.close(); }
}
function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let outText = "";
    child.stdout.on("data", (d) => { outText += d; });
    child.stderr.on("data", (d) => { outText += d; });
    child.on("close", (code) => resolve({ code, out: outText }));
  });
}

let done = 0;
for (const library of libraries) {
  const files = (await readdir(library)).filter((f) => EXTS.has(path.extname(f).toLowerCase()) && !f.startsWith("."))
    .filter((f) => !args.filter || f.toLowerCase().includes(args.filter.toLowerCase())).sort();
  if (!files.length) continue;
  const server = spawn(process.execPath, [path.join(here, "serve.mjs"), "--pkg", pkg, "--disc", library, "--port", String(port)], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 800));
  try {
    for (const file of files) {
      if (limit && done >= limit) break;
      const full = path.join(library, file), id = await gameIdOf(full);
      if (!id) { console.log(`skip (no game id): ${file}`); continue; }
      const target = path.join(out, `${id}.bin`);
      if (args["skip-existing"] && existsSync(target)) { console.log(`have ${id}: ${file}`); continue; }
      const profile = path.join(out, ".profile"), probeOut = path.join(out, ".probe", id);
      await rm(profile, { recursive: true, force: true });
      console.log(`${id}: ${file} — ${duration} s …`);
      const probe = await run(process.execPath, [path.join(here, "probe.mjs"), "--base-url", `http://127.0.0.1:${port}/`, "--disc", file,
        "--out", probeOut, "--duration", String(duration), "--profile", profile, ...(playwright ? ["--playwright", playwright] : [])]);
      const summary = /SUMMARY (\{.*\})/.exec(probe.out)?.[1];
      const exp = await run(process.execPath, [path.join(wasmDolphin, "tools", "export-prebuilt-jit-cache.mjs")], {
        cwd: wasmDolphin,
        env: { ...process.env, PROBE_PERSIST_DIR: profile, BASE_URL: `http://127.0.0.1:${port}/`, OUT_PATH: target, MAX_ENTRIES: "49152" }
      });
      if (exp.code !== 0 || !existsSync(target)) { console.log(`  ${id}: export failed\n${exp.out.split("\n").slice(-4).join("\n")}`); continue; }
      const size = (await stat(target)).size;
      const modules = Number(/— (\d+) modules/.exec(exp.out)?.[1] ?? 0);
      index[id] = { file, bytes: size, modules, duration, probe: summary ? JSON.parse(summary).speed : null, at: new Date().toISOString() };
      await writeFile(indexPath, JSON.stringify(index, null, 2));
      console.log(`  ${id}: ${(size / 1048576).toFixed(1)} MB${modules ? `, ${modules} modules` : ""}`);
      done++;
    }
  } finally {
    server.kill();
  }
}
await rm(path.join(out, ".profile"), { recursive: true, force: true });
console.log(`done: ${done} title(s); index at ${indexPath}`);
