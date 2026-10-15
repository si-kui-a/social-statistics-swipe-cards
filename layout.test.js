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
                ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".webmanifest": "application/manifest+json" };
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
  if (file === path.join(ROOT, "index.html")) {
    // The check page reads the app's let-scoped state through eval, which the shipped CSP forbids, so the
    // served copy allows eval and records every CSP violation for the check page (window.__csp).
    res.end(fs.readFileSync(file, "utf8")
      .replace("script-src 'self' 'unsafe-inline'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'")
      .replace("<head>", "<head><script>window.__csp=[];document.addEventListener('securitypolicyviolation',"
        + "e=>window.__csp.push(e.violatedDirective+' '+e.blockedURI))</script>"));
    return;
  }
  fs.createReadStream(file).pipe(res);
});

// A syntax error in the check page or the app stops the page before it writes a result, and the run
// only says "produced no result", which looks like a timeout (2026-10-14: a second `const row`).
// Compile every inline script first so the error names itself.
// The shipped page keeps a CSP without eval; the test server only loosens its own copy.
const csp = (fs.readFileSync(path.join(ROOT, "index.html"), "utf8").match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1];
if (!csp || /unsafe-eval/.test(csp) || !/default-src 'self'/.test(csp)) {
  console.log("FAIL index.html: needs a Content-Security-Policy with default-src 'self' and no 'unsafe-eval'");
  process.exit(1);
}
for (const page of ["tests/layout-check.html", "index.html"]) {
  const html = fs.readFileSync(path.join(ROOT, page), "utf8");
  for (const [, code] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    try { new Function(code); } catch (e) {  // compiles only; nothing runs
      console.log(`FAIL ${page}: script does not compile: ${e.message}`);
      process.exit(1);
    }
  }
}

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
