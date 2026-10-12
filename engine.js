// Grading and adaptive scheduling for the swipe app: pure functions, no page access, so engine.test.js
// can check them with Node. index.html loads this file as a plain script (window.Engine).
//
// Card formats: mc (pick one choice; any letter in card.answer counts), num (type a number within a
// tolerance), essay (write, then tick the rubric points covered; keywords pre-tick them), flip (think,
// flip, grade yourself). Every attempt yields a score from 0 to 1; essays pass at card.pass (0.6).
//
// Adaptivity, per deck:
//   ability   one value per chapter, updated after every attempt like an Elo rating against the
//             card's level (1 basic, 2 standard, 3 advanced). New cards are picked so the expected
//             success is near TARGET: hard enough to learn from, easy enough to keep going.
//   volume    the number of new cards per round starts at the deck's newStart and moves by NEW_STEP
//             after every ADJUST_EVERY attempts: up when recent accuracy is high and few reviews are
//             due, down when accuracy is low or reviews pile up.
(function (root) {
  "use strict";
  const LEVEL_B = { 1: -1, 2: 0, 3: 1.2 };
  const LEVEL_NAME = { 1: "基礎", 2: "標準", 3: "進階" };
  const TARGET = 0.75;
  const INTERVAL_DAYS = [0, 1, 3, 7, 14, 30];  // Leitner box -> days until due after a right answer
  const DAY = 86400000;
  const NEW_MIN = 5, NEW_MAX = 40, NEW_STEP = 5, ADJUST_EVERY = 10, RECENT = 30;
  const HIGH = 0.85, LOW = 0.65, FEW_DUE = 20, MANY_DUE = 60;
  const NEGATION = /(不是|並非|沒有|不|非|無|未)$/;

  function level(card) { return LEVEL_B[card.level] === undefined ? 2 : card.level; }
  function abilityKey(card) { return String(card.ch === undefined ? card.chapter : card.ch); }
  function prob(theta, lvl) { return 1 / (1 + Math.exp(-(theta - LEVEL_B[lvl]))); }
  function theta(model, card) { return (model.theta || {})[abilityKey(card)] || 0; }

  function updateAbility(model, card, score) {
    model.theta = model.theta || {}; model.n = model.n || {};
    const k = abilityKey(card), th = model.theta[k] || 0, n = model.n[k] || 0;
    const step = Math.max(0.15, 0.6 / Math.sqrt(1 + n / 10));  // settles as evidence accumulates
    model.theta[k] = th + step * (score - prob(th, level(card)));
    model.n[k] = n + 1;
    return model.theta[k];
  }

  function normalize(s) { return String(s).normalize("NFKC").toLowerCase().replace(/\s+/g, ""); }

  // A keyword counts unless it comes right after a negation: "不是隨機抽樣" does not hit 隨機抽樣.
  function keywordHit(text, keyword) {
    const t = normalize(text), k = normalize(keyword);
    if (!k) return false;
    for (let i = t.indexOf(k); i >= 0; i = t.indexOf(k, i + 1)) {
      if (!NEGATION.test(t.slice(Math.max(0, i - 2), i))) return true;
    }
    return false;
  }
  function matchPoints(card, text) {
    return (card.points || []).map(p => (p.kw || []).some(k => keywordHit(text, k)));
  }

  function parseNumber(input) {
    let s = normalize(input).replace(/,/g, "").replace(/[−–]/g, "-");
    let div = 1;
    if (s.endsWith("%")) { s = s.slice(0, -1); div = 100; }
    const frac = s.match(/^(-?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
    if (frac) return Number(frac[1]) / Number(frac[2]) / div;
    return s && /^-?(\d+\.?\d*|\.\d+)(e-?\d+)?$/.test(s) ? Number(s) / div : NaN;
  }

  // Returns a score from 0 to 1. mc: picked letter; num: typed text; essay: array of ticks.
  function grade(card, response) {
    if (card.format === "mc") return (card.answer || []).includes(response) ? 1 : 0;
    if (card.format === "num") {
      const x = parseNumber(response), v = card.num.value;
      const tol = card.num.tol === undefined ? Math.abs(v) * 0.005 + 0.005 : card.num.tol;
      return Number.isFinite(x) && Math.abs(x - v) <= tol ? 1 : 0;
    }
    if (card.format === "essay") {
      const n = (card.points || []).length;
      return n ? response.filter(Boolean).length / n : 0;
    }
    return response ? 1 : 0;  // flip: the learner's own right/wrong
  }
  function passed(card, score) { return score >= (card.format === "essay" ? (card.pass || 0.6) : 1); }

  function schedule(entry, right, now) {
    const box = right ? Math.min((entry ? entry.box : 0) + 1, INTERVAL_DAYS.length - 1) : 0;
    return { box, due: now + INTERVAL_DAYS[box] * DAY };
  }

  // Seen cards that are due (or all seen ones), then unseen cards closest to TARGET success, up to cap.
  function buildRound(cards, state, opts) {
    const now = opts.now, progress = state.progress, model = state.model || {};
    const seen = cards.filter(c => progress[c.id] && (opts.ignoreDue || progress[c.id].due <= now));
    const rand = opts.random || Math.random;
    const fresh = cards.filter(c => !progress[c.id])
      .map(c => ({ c, d: Math.abs(prob(theta(model, c), level(c)) - TARGET) + rand() * 0.15 }))
      .sort((a, b) => a.d - b.d).map(x => x.c);
    return { seen, fresh: fresh.slice(0, opts.cap) };
  }

  function recentScores(progress, limit) {
    const all = [];
    for (const p of Object.values(progress)) for (const e of p.log || []) all.push([e[0], e.length > 3 ? e[3] : e[1]]);
    return all.sort((a, b) => a[0] - b[0]).slice(-limit).map(x => x[1]);
  }
  function attemptCount(progress) { return Object.values(progress).reduce((n, p) => n + (p.log || []).length, 0); }

  // Returns the settings to keep: newPerRound moved at most one step since the last adjustment.
  function adjustVolume(settings, progress, dueCount, start) {
    const out = { newPerRound: settings.newPerRound || start, adjustedAt: settings.adjustedAt || 0 };
    const total = attemptCount(progress);
    if (total - out.adjustedAt < ADJUST_EVERY) return out;
    const scores = recentScores(progress, RECENT), acc = scores.reduce((a, b) => a + b, 0) / scores.length;
    if (acc >= HIGH && dueCount < FEW_DUE) out.newPerRound += NEW_STEP;
    else if (acc < LOW || dueCount > MANY_DUE) out.newPerRound -= NEW_STEP;
    out.newPerRound = Math.max(NEW_MIN, Math.min(NEW_MAX, out.newPerRound));
    out.adjustedAt = total;
    return out;
  }

  const Engine = { LEVEL_NAME, TARGET, INTERVAL_DAYS, DAY, prob, level, theta, updateAbility, keywordHit,
                   matchPoints, parseNumber, grade, passed, schedule, buildRound, recentScores, adjustVolume };
  if (typeof module === "object" && module.exports) module.exports = Engine; else root.Engine = Engine;
})(typeof window === "undefined" ? globalThis : window);
