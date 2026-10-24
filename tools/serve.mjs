// A test server for the package: the package directory at /, with the COOP/COEP headers
// the core needs, and discs under /disc/ with Range support — plus an added first-byte
// delay and a bandwidth cap on the discs, to stand in for a slower link. The cap is one
// link that every disc response in flight shares (a 100 Mbit link with three requests on
// it is still 100 Mbit — it used to be per response, which let background requests run
// beside a miss at no cost to it), and a response the browser aborts stops taking from it.
// A disc's read order (<disc file>.reads.json) is served from beside it like any file.
//
//   node tools/serve.mjs --pkg <package dir> --disc <disc dir> [--port 8085] [--delay-ms 0]
//                        [--bw-mbit 0] [--log <file>]
//
// Nothing here is game data; the discs are read from wherever --disc points.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((out, a, i, all) => {
  if (a.startsWith("--")) out.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "1"]);
  return out;
}, []));
const ROOT = path.resolve(args.pkg || "."), DISC = path.resolve(args.disc || "disc");
const port = Number(args.port || 8085), DELAY = Number(args["delay-ms"] || 0), BW = Number(args["bw-mbit"] || 0) * 125000;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm",
  ".json": "application/json", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".map": "application/json" };
const log = args.log ? fs.createWriteStream(args.log, { flags: "a" }) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The link: one queue every disc byte goes through, at BW bytes/s.
let linkFree = 0;
async function link(n) {
  if (!BW) return;
  const now = Date.now();
  linkFree = Math.max(linkFree, now) + n / BW * 1000;
  if (linkFree > now) await sleep(linkFree - now);
}

http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
  const isDisc = p.startsWith("/disc/");
  const file = isDisc ? path.join(DISC, p.slice(6)) : path.join(ROOT, p === "/" ? "/index.html" : p);
  if (!file.startsWith(isDisc ? DISC : ROOT)) { res.writeHead(403); return res.end(); }
  let st;
  try { st = fs.statSync(file); } catch { res.writeHead(404); return res.end("not found"); }
  res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
  res.setHeader("Accept-Ranges", "bytes");
  if (req.method === "HEAD") { res.setHeader("Content-Length", st.size); res.writeHead(200); return res.end(); }
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
  let a = 0, b = st.size - 1;
  if (m) {
    a = Number(m[1]); b = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    if (a > b || a >= st.size) { res.writeHead(416); return res.end(); }
  }
  const n = b - a + 1, t0 = Date.now();
  if (m) { res.setHeader("Content-Range", `bytes ${a}-${b}/${st.size}`); res.setHeader("Content-Length", n); res.writeHead(206); }
  else { res.setHeader("Content-Length", n); res.writeHead(200); }
  let gone = false, sent = 0;
  res.on("close", () => { gone = true; });
  if (isDisc && DELAY) await sleep(DELAY);
  const fd = fs.openSync(file, "r");
  try {
    const CH = 65536, buf = Buffer.alloc(CH);
    let pos = a;
    while (pos <= b && !gone) {
      const len = Math.min(CH, b - pos + 1);
      fs.readSync(fd, buf, 0, len, pos); pos += len;
      if (isDisc) await link(len);
      if (gone) break;
      if (!res.write(Buffer.from(buf.subarray(0, len)))) {
        await new Promise((r) => { const done = () => { res.off("drain", done); res.off("close", done); r(); }; res.on("drain", done); res.on("close", done); });
      }
      sent += len;
    }
  } finally { fs.closeSync(fd); res.end(); }
  if (isDisc && log) log.write(`${new Date().toISOString()} ${a}-${b} ${n} sent=${sent}${gone ? " aborted" : ""} ${Date.now() - t0}ms\n`);
}).listen(port, "127.0.0.1", () => {
  console.log(`serving ${ROOT} on http://127.0.0.1:${port}/ — discs from ${DISC}; delay ${DELAY} ms, bandwidth ${BW ? `${args["bw-mbit"]} Mbit/s (shared)` : "unlimited"}`);
});
