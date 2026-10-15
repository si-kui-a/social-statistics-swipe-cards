// Copyright (c) 2026 si-kui-a. All rights reserved. The code is not open source; see README "授權".
// Receives the swipe app's anonymous attempt rows (opt-in) and appends them to the sheet "attempts" of
// the spreadsheet this script is bound to; the private course repository pulls them with the read key
// (scripts/shared_attempts.py there). No secret lives in this file: READ_KEY is a script property.
//
// Deploy (once, in the owner's Google account):
//   1. New Google spreadsheet → Extensions → Apps Script → paste this file as Code.gs
//   2. Project settings → Script properties → READ_KEY = a long random string (keep it only in the
//      local config the pull script reads; never in a repository)
//   3. Deploy → New deployment → Web app: execute as me, who has access: anyone → copy the /exec URL
//      into SHARE_URL in index.html
//
// Rows are checked field by field (validRow) and anything else is refused; engine.test.js runs
// validRow on the rows Engine.shareRow makes, so the two sides cannot drift apart unnoticed.
var FIELDS = ["id", "install", "deck", "card", "day", "right", "sure", "score", "answer", "first", "level"];
var MAX_ROWS = 200;   // per request
var DAILY_CAP = 600;  // rows per install code per day: one heavy day of practice, not a flood
var PULL_MAX = 5000;  // rows per read

function validRow(r) {
  if (!r || typeof r !== "object") return false;
  var keys = Object.keys(r);
  if (keys.length !== FIELDS.length || !keys.every(function (k) { return FIELDS.indexOf(k) >= 0; })) return false;
  var bit = function (x) { return x === 0 || x === 1; };
  return /^[0-9a-f]{16}$/.test(r.id) && /^[0-9a-f]{16}$/.test(r.install) &&
    (r.deck === "stats" || r.deck === "research" || r.deck === "theory") && typeof r.card === "string" && /^[\w-]{1,40}$/.test(r.card) &&
    typeof r.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.day) && bit(r.right) && bit(r.sure) &&
    typeof r.score === "number" && r.score >= 0 && r.score <= 1 &&
    typeof r.answer === "string" && r.answer.length <= 40 && bit(r.first) && [1, 2, 3].indexOf(r.level) >= 0;
}

// The rows of one request worth keeping: valid, and all from the install code of the first one.
function acceptedRows(body) {
  var rows = body && Array.isArray(body.rows) ? body.rows.slice(0, MAX_ROWS) : [];
  var install = rows.length && rows[0] ? rows[0].install : null;
  return rows.filter(function (r) { return validRow(r) && r.install === install; });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function attemptsSheet() {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  var sh = book.getSheetByName("attempts");
  if (!sh) {
    sh = book.insertSheet("attempts");
    sh.appendRow(FIELDS);
  }
  return sh;
}

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json({ ok: false, error: "not JSON" }); }
  var good = acceptedRows(body);
  if (!good.length) return json({ ok: false, error: "no valid rows" });
  var cache = CacheService.getScriptCache(), key = "n-" + good[0].install + "-" + good[0].day;
  var n = Number(cache.get(key) || 0);
  if (n + good.length > DAILY_CAP) return json({ ok: false, error: "daily cap" });
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = attemptsSheet();
    sh.getRange(sh.getLastRow() + 1, 1, good.length, FIELDS.length)
      .setValues(good.map(function (r) { return FIELDS.map(function (f) { return r[f]; }); }));
  } finally {
    lock.releaseLock();
  }
  cache.put(key, String(n + good.length), 21600);
  return json({ ok: true, saved: good.length });
}

// GET ?key=READ_KEY&since=N: data rows after the first N (header excluded), at most PULL_MAX.
function doGet(e) {
  var want = PropertiesService.getScriptProperties().getProperty("READ_KEY");
  if (!want || !e || !e.parameter || e.parameter.key !== want) return json({ ok: false, error: "key" });
  var sh = attemptsSheet(), since = Math.max(0, Number(e.parameter.since) || 0);
  var total = sh.getLastRow() - 1, take = Math.min(PULL_MAX, total - since);
  var rows = take > 0 ? sh.getRange(since + 2, 1, take, FIELDS.length).getValues() : [];
  return json({ ok: true, fields: FIELDS, rows: rows, total: total });
}
