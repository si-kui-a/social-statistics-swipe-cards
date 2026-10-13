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
//   confidence an unsure right answer keeps its box (min 1 day); a confident wrong answer comes back
//             RETRY_SOON cards later in the same round instead of at the end (retryAt).
(function (root) {
  "use strict";
  const LEVEL_B = { 1: -1, 2: 0, 3: 1.2 };
  const LEVEL_NAME = { 1: "基礎", 2: "標準", 3: "進階" };
  const TARGET = 0.75;
  const INTERVAL_DAYS = [0, 1, 3, 7, 14, 30];  // Leitner box -> days until due after a right answer
  const DAY = 86400000;
  const NEW_MIN = 5, NEW_MAX = 40, NEW_STEP = 5, ADJUST_EVERY = 10, RECENT = 30;
  const HIGH = 0.85, LOW = 0.65, FEW_DUE = 20, MANY_DUE = 60;
  const RETRY_SOON = 3;
  const NEGATION = /(不是|並非|沒有|不|非|無|未)$/;

  function level(card) { return LEVEL_B[card.level] === undefined ? 2 : card.level; }
  function abilityKey(card) { return String(card.ch === undefined ? card.chapter : card.ch); }
  function prob(theta, lvl) { return 1 / (1 + Math.exp(-(theta - LEVEL_B[lvl]))); }
  // Expected success on a card: a multiple-choice item can be guessed (1 in k choices), so the floor
  // is 1/k, as in a three-parameter IRT model. Without it a guessed answer reads as knowledge, the
  // ability estimate runs high and harder cards come too early.
  function expected(theta, card) {
    const k = card.format === "mc" && card.choices ? card.choices.length : 0;
    const floor = k > 1 ? 1 / k : 0;
    return floor + (1 - floor) * prob(theta, level(card));
  }
  function theta(model, card) { return (model.theta || {})[abilityKey(card)] || 0; }

  function updateAbility(model, card, score) {
    model.theta = model.theta || {}; model.n = model.n || {};
    const k = abilityKey(card), th = model.theta[k] || 0, n = model.n[k] || 0;
    const step = Math.max(0.15, 0.6 / Math.sqrt(1 + n / 10));  // settles as evidence accumulates
    model.theta[k] = th + step * (score - expected(th, card));
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
      // A percent answer (num.unit "%", value 23 for 23%) accepts "23" and "23%": parseNumber reads
      // "23%" as 0.23, which would otherwise mark the right answer wrong.
      let x = parseNumber(response);
      if (card.num.unit === "%" && /%\s*$/.test(String(response))) x *= 100;
      const v = card.num.value;
      // Default: 0.5% of the value, at least 0.0005 (an absolute 0.005 would accept p = .008 for .003).
      const tol = card.num.tol === undefined ? Math.max(Math.abs(v) * 0.005, 0.0005) : card.num.tol;
      return Number.isFinite(x) && Math.abs(x - v) <= tol ? 1 : 0;
    }
    if (card.format === "essay") {
      const n = (card.points || []).length;
      return n ? response.filter(Boolean).length / n : 0;
    }
    return response ? 1 : 0;  // flip: the learner's own right/wrong
  }
  function passed(card, score) { return score >= (card.format === "essay" ? (card.pass || 0.6) : 1); }

  // Confidence moves the schedule, never the score: an unsure right answer is still right (the
  // ability estimate stays honest), but the card is not promoted, so it returns the next day instead
  // of after a longer gap. sure defaults to 1 so callers without it keep the old behaviour.
  function schedule(entry, right, now, sure = 1) {
    const prev = entry ? entry.box : 0;
    const box = !right ? 0 : sure ? Math.min(prev + 1, INTERVAL_DAYS.length - 1) : Math.max(1, prev);
    return { box, due: now + INTERVAL_DAYS[box] * DAY };
  }

  // Where a wrongly answered card goes back into the round's queue: a confident wrong answer, the
  // misconception most worth fixing, after RETRY_SOON cards; an unsure one at the end.
  function retryAt(queueLength, sure) { return sure ? Math.min(RETRY_SOON, queueLength) : queueLength; }

  // Seen cards that are due (or all seen ones), then unseen cards closest to TARGET success, up to cap.
  function buildRound(cards, state, opts) {
    const now = opts.now, progress = state.progress, model = state.model || {};
    const seen = cards.filter(c => progress[c.id] && (opts.ignoreDue || progress[c.id].due <= now));
    const rand = opts.random || Math.random;
    const fresh = cards.filter(c => !progress[c.id])
      .map(c => ({ c, d: Math.abs(expected(theta(model, c), c) - TARGET) + rand() * 0.15 }))
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

  // Every card in the selection once, for "go through all of it": due reviews first, then unseen cards
  // nearest TARGET success, then the rest by how soon they fall due. Anki's Custom Study does the same
  // job (step outside the daily limits); without it a large chapter could never be finished.
  function fullPass(cards, state, opts) {
    const r = buildRound(cards, state, { ...opts, cap: Infinity });
    const progress = state.progress;
    const later = cards.filter(c => progress[c.id] && progress[c.id].due > opts.now)
      .sort((a, b) => progress[a.id].due - progress[b.id].due);
    return r.seen.concat(r.fresh, later);
  }

  // A finished round in numbers. results hold the first attempt at each card ({ id, label, right, sure });
  // retries of missed cards do not count, as in Quizlet and Anki, so the score says what was known.
  // Results may also carry type (定義辨識, 國考選擇題…), diag (diagnose()) and trap (a misconception id);
  // weak areas are labels and types with two or more misses, worst share first.
  function summarize(results) {
    const n = results.length, right = results.filter(r => r.right).length;
    const group = key => {
      const by = new Map();
      for (const r of results) {
        const k = r[key]; if (!k) continue;
        const b = by.get(k) || { label: k, n: 0, right: 0 };
        b.n++; if (r.right) b.right++;
        by.set(k, b);
      }
      return [...by.values()];
    };
    const weak = list => list.filter(b => b.n - b.right >= 2)
      .sort((a, b) => (b.n - b.right) / b.n - (a.n - a.right) / a.n || b.n - a.n);
    const count = key => results.filter(r => !r.right && r[key]).reduce((m, r) => (m[r[key]] = (m[r[key]] || 0) + 1, m), {});
    const byLabel = group("label");
    const bySection = group("section");
    return { n, right, pct: n ? Math.round(100 * right / n) : 0,
             sureWrong: results.filter(r => !r.right && r.sure).map(r => r.id),
             unsureRight: results.filter(r => r.right && !r.sure).length,
             missed: results.filter(r => !r.right).map(r => r.id),
             byLabel: byLabel.sort((a, b) => a.label < b.label ? -1 : 1), bySection,
             weakLabels: weak(byLabel), weakTypes: weak(group("type")), diags: count("diag"), traps: count("trap") };
  }

  // Today, over the whole deck (the same whatever chapter is picked): distinct cards and how many were
  // right at their first attempt today. Counting every attempt let retries of missed cards inflate
  // "今天 40 題" and blur the rate (2026-10-13). recent: the last RECENT_TODAY attempts, for pauseReason.
  const RECENT_TODAY = 20;
  function since(progress, from) {
    let cards = 0, first = 0;
    const today = [];
    for (const p of Object.values(progress)) {
      const log = (p.log || []).filter(e => e[0] >= from);
      if (!log.length) continue;
      cards++; first += log[0][1];
      today.push(...log);
    }
    const recent = today.sort((a, b) => a[0] - b[0]).slice(-RECENT_TODAY);
    return { n: cards, right: first, pct: cards ? Math.round(100 * first / cards) : 0, attempts: today.length,
             recentN: recent.length, recentPct: recent.length ? Math.round(100 * recent.reduce((s, e) => s + e[1], 0) / recent.length) : 0 };
  }

  // A mechanical stop (Anki's daily limit, plus a fatigue check): the daily card limit, or the last
  // RECENT_TODAY attempts under half right. ack remembers what the learner already chose to go past:
  // { day, limit, at } with at = the attempt count when the low-accuracy pause was last shown.
  const DAILY_MAX = 60, LOW_TODAY = 50, EXTRA = 20;
  function pauseReason(today, ack, dailyMax) {
    const limit = (ack && ack.limit) || dailyMax || DAILY_MAX;
    if (today.n >= limit) return { code: "limit", limit, text: `今天已做 ${today.n} 張，到了每日上限 ${limit} 張` };
    const since_ack = today.attempts - ((ack && ack.at) || 0);
    if (today.recentN >= RECENT_TODAY && today.recentPct < LOW_TODAY && since_ack >= RECENT_TODAY) {
      return { code: "low", text: `最近 ${RECENT_TODAY} 題只答對 ${today.recentPct}%：先看錯在哪，比再多做有用` };
    }
    return null;
  }

  // Why a wrong answer went wrong, from the answer itself where the format allows, each with the first
  // step of a hint ladder: ask before telling, the rule the essay review uses, carried over to the other
  // formats. A multiple-choice pick tagged as a known misconception (card.traps) names it instead.
  const DIAG = {
    pct: { name: "百分比與比例混用", ask: "題目要的是比例（0 到 1）還是百分比（0 到 100）？" },
    sign: { name: "正負號弄反", ask: "這個量應該是正還是負？是誰減誰？" },
    round: { name: "四捨五入太早或精度不足", ask: "中間步驟留了幾位小數？最後才四捨五入會差多少？" },
    calc: { name: "公式或步驟錯", ask: "先說這個公式在解決什麼問題，再逐步代數字：哪一步和解說不同？" },
    trap: { name: "選了常見誤解", ask: "這個選項看起來對的理由是什麼？那個理由在哪裡不成立？" },
    sure: { name: "以為懂（有把握卻答錯）", ask: "你當時用什麼判斷？那個判斷在什麼情況下不成立？" },
    choice: { name: "選擇題選錯", ask: "每個選項各錯在哪裡？試著一句話說出它不成立的理由。" },
    essay: { name: "申論要點沒寫到", ask: "漏掉的是定義、條件還是例子？下次先列這三樣再寫。" },
    flip: { name: "自評答錯", ask: "寫一句「因為……」：你的答案和解說差在哪個判斷？" },
  };
  function diagnose(card, answer, right, sure) {
    if (right) return null;
    if (card.format === "num" && card.num) {
      let x = parseNumber(answer);
      if (card.num.unit === "%" && /%\s*$/.test(String(answer))) x *= 100;
      const v = card.num.value, near = (a, b) => Math.abs(a - b) <= Math.abs(b) * 0.01;
      if (!Number.isFinite(x) || v === 0) return "calc";
      if (near(x, v * 100) || near(x, v / 100)) return "pct";
      if (near(x, -v)) return "sign";
      if (Math.abs(x - v) <= Math.abs(v) * 0.05) return "round";
      return "calc";
    }
    if (card.format === "mc") return card.traps && card.traps[answer] ? "trap" : sure ? "sure" : "choice";
    if (card.format === "essay") return "essay";
    return sure ? "sure" : "flip";
  }

  // A mock exam from its spec in the deck file (exams[]): scope by course chapter (ch) or chapter-code
  // prefixes (chapters), then each section's n cards of the given formats, in section order as on a real
  // paper. Returns ids, each id's section, and the sections that came up short (too few cards yet).
  function buildExam(cards, exam, rnd = Math.random) {
    const sc = exam.scope || {};
    const under = (c, prefixes) => prefixes.some(p => String(c.chapter).startsWith(p));
    const pool = cards.filter(c => (!sc.ch || sc.ch.includes(c.ch)) && (!sc.chapters || under(c, sc.chapters)));
    const used = new Set(), ids = [], section = {}, short = [];
    for (const s of exam.sections) {
      const cand = pool.filter(c => !used.has(c.id) && s.formats.includes(c.format || "flip") && (!s.chapters || under(c, s.chapters)));
      for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [cand[i], cand[j]] = [cand[j], cand[i]]; }
      const take = cand.slice(0, s.n);
      for (const c of take) { used.add(c.id); ids.push(c.id); section[c.id] = s.name; }
      if (take.length < s.n) short.push(`${s.name} ${take.length}/${s.n}`);
    }
    return { ids, section, short };
  }

  // Quizlet-style groups: never answered, still learning (box 0-2: due within 3 days), mastered (box 3+).
  function mastery(cards, progress) {
    const out = { unseen: 0, learning: 0, mastered: 0 };
    for (const c of cards) {
      const p = progress[c.id];
      out[!p ? "unseen" : p.box >= 3 ? "mastered" : "learning"]++;
    }
    return out;
  }

  // Exports carry schemaVersion. 1 (or none): [time, correct, sure] attempts only; 2 adds an essay score
  // as a fourth attempt field, the ability model, settings and essay text; 3 adds a fifth field, the
  // answer given (the letter picked, or the number typed), so a wrong answer can be traced to the
  // misconception behind it instead of only counted. A file from a newer app is refused rather than
  // half-read (finance-tools does the same for its workspace files).
  const EXPORT_VERSION = 3;
  const ANSWER_MAX = 40;
  const bit = x => x === 0 || x === 1;
  function validAttempt(e) {
    return Array.isArray(e) && e.length >= 3 && Number.isFinite(e[0]) && bit(e[1]) && bit(e[2]) &&
      (e.length < 4 || (Number.isFinite(e[3]) && e[3] >= 0 && e[3] <= 1)) &&
      (e.length < 5 || (typeof e[4] === "string" && e[4].length <= ANSWER_MAX));
  }
  // One attempt as saved: [time, correct, sure], then the score when it is partial or an answer
  // follows, then the answer (mc letter or typed number, trimmed; essays and flips keep their text
  // elsewhere, so they carry none).
  function attempt(now, right, sure, score, answer) {
    const e = [now, right ? 1 : 0, sure ? 1 : 0];
    const given = typeof answer === "string" ? answer.trim().slice(0, ANSWER_MAX) : "";
    if (given || (score !== 0 && score !== 1)) e.push(score);
    if (given) e.push(given);
    return e;
  }
  // Every problem found, in words for the learner; an empty list means the file can be merged.
  function validateExport(data) {
    if (!data || typeof data !== "object" || !data.progress || typeof data.progress !== "object") return ["這不是滑卡匯出的成績檔"];
    const errs = [];
    const v = data.schemaVersion;
    if (v !== undefined && !(Number.isInteger(v) && v >= 1 && v <= EXPORT_VERSION)) {
      errs.push(`檔案格式 v${v} 比這個 App 支援的 v${EXPORT_VERSION} 新，請重新整理 App 取得新版後再匯入`);
    }
    const bad = Object.entries(data.progress).filter(([, p]) =>
      !p || !Number.isInteger(p.box) || !Number.isFinite(p.due) || !Array.isArray(p.log) || !p.log.every(validAttempt));
    if (bad.length) errs.push(`${bad.length} 張卡的作答紀錄格式不正確（例如 ${bad[0][0]}）`);
    if (data.mine !== undefined && !Array.isArray(data.mine)) errs.push("自製卡格式不正確");
    if (data.essays !== undefined && (typeof data.essays !== "object" || !Object.values(data.essays).every(Array.isArray))) errs.push("申論作答格式不正確");
    if (data.model !== undefined && (typeof data.model !== "object" || !Object.values(data.model.theta || {}).every(Number.isFinite))) errs.push("能力估計格式不正確");
    return errs;
  }

  const Engine = { EXPORT_VERSION, validateExport, attempt, LEVEL_NAME, TARGET, INTERVAL_DAYS, DAY, prob, expected, level, theta, updateAbility, keywordHit,
                   matchPoints, parseNumber, grade, passed, schedule, retryAt, buildRound, fullPass, buildExam, summarize, since, mastery, pauseReason, diagnose, DIAG, DAILY_MAX, EXTRA, RECENT_TODAY, recentScores, adjustVolume };
  if (typeof module === "object" && module.exports) module.exports = Engine; else root.Engine = Engine;
})(typeof window === "undefined" ? globalThis : window);
