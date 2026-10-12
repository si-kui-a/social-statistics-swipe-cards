// Phone layout check: serves this folder, opens tests/layout-check.html in headless Chrome and fails
// when any card format leaves its answer area or buttons off a 390x844 screen.
// Run: node layout.test.js   (needs Chrome; set CHROME to its path if it is not in the usual place)
// No dependencies: Node's http module and Chrome's --dump-dom are enough, locally and in CI.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = __dirname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css",
                ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const CHROME = process.env.CHROME || [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].find(p => fs.existsSync(p));

if (!CHROME) {
  console.log("FAIL no Chrome found; set CHROME to its path");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

server.listen(0, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}/tests/layout-check.html`;
  const args = ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
                "--virtual-time-budget=20000", "--dump-dom", url];
  execFile(CHROME, args, { timeout: 60000, windowsHide: true }, (err, stdout) => {
    server.close();
    const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(stdout || "");
    let result = null;
    try { result = m && JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")); }
    catch (e) { /* reported below */ }
    if (!result) {
      console.log(`FAIL layout check produced no result${err ? ` (${err.message.split("\n")[0]})` : ""}`);
      process.exit(1);
    }
    for (const s of result.seen) console.log(`checked ${s}`);
    for (const f of result.failures) console.log(`FAIL ${f}`);
    console.log(`${result.failures.length} failed`);
    process.exit(result.failures.length || !result.seen.length ? 1 : 0);
  });
});
