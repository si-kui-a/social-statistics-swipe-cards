/// Copyright (c) 2026 si-kui-a. All rights reserved. The code is not open source; see README "授權".
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

  // Standing per domain (a card's label: a chapter or topic) over the whole history, in Khan Academy's
  // skill levels over the last LEVEL_WINDOW attempts: 未開始 (never answered), 嘗試 (under FAMILIAR
  // right), 熟悉, 精熟 (all right). Fewer than MIN_SAMPLE attempts is too little to call a domain weak
  // or strong, so it stays 嘗試 with sparse set and no error rate.
  const LEVEL_WINDOW = 10, MIN_SAMPLE = 3, FAMILIAR = 0.7;
  function domainOf(card) { return card.label || card.chapter; }
  function domainStats(cards, progress) {
    const by = new Map();
    for (const c of cards) {
      const d = domainOf(c), b = by.get(d) || { label: d, cards: 0, log: [] };
      b.cards++;
      b.log.push(...((progress[c.id] || {}).log || []));
      by.set(d, b);
    }
    return [...by.values()].map(b => {
      const recent = b.log.sort((x, y) => x[0] - y[0]).slice(-LEVEL_WINDOW);
      const n = recent.length, wrong = recent.filter(e => !e[1]).length, sparse = n < MIN_SAMPLE;
      const level = !n ? "未開始" : sparse || (n - wrong) / n < FAMILIAR ? "嘗試" : wrong ? "熟悉" : "精熟";
      return { label: b.label, cards: b.cards, n, wrong, err: sparse ? null : wrong / n, sparse, level };
    });
  }

  // New cards shared out by domain, most deserving slot first (D'Hondt): a domain's weight grows with
  // its recent error rate, and a weak domain gives its basic cards first, as ALEKS teaches what a topic
  // builds on before the topic. No domain takes more than half the slots while another can still give
  // a card (interleaved practice beats blocks of one topic); only when the others run out does it fill
  // the rest, so a round is never cut short. A domain without enough evidence counts as NEUTRAL_ERR.
  const WEAK_WEIGHT = 2, NEUTRAL_ERR = 0.3, WEAK_ERR = 0.3;
  function pickFresh(ranked, stats, cap) {
    const info = new Map(stats.map(s => [s.label, s]));
    const err = d => { const s = info.get(d); return s && !s.sparse ? s.err : NEUTRAL_ERR; };
    const pools = new Map();
    for (const c of ranked) { const d = domainOf(c); if (!pools.has(d)) pools.set(d, []); pools.get(d).push(c); }
    for (const [d, list] of pools) if (err(d) >= WEAK_ERR && !(info.get(d) || { sparse: true }).sparse) list.sort((a, b) => level(a) - level(b));
    const taken = new Map(), out = [];
    const fill = limit => {
      while (out.length < cap) {
        let best = null, bestQ = -1;
        for (const [d, list] of pools) {
          const t = taken.get(d) || 0;
          if (t >= list.length || t >= limit) continue;
          const q = (1 + WEAK_WEIGHT * err(d)) / (t + 1);
          if (q > bestQ) { best = d; bestQ = q; }
        }
        if (best === null) return;
        const t = taken.get(best) || 0;
        out.push(pools.get(best)[t]); taken.set(best, t + 1);
      }
    };
    fill(pools.size > 1 ? Math.ceil(cap / 2) : Infinity);
    fill(Infinity);
    return out;
  }

  // A round's order with the same domain twice in a row only when nothing else is left: each step takes
  // the first card (in the given, shuffled order) from the domain with the most cards remaining.
  function interleave(list) {
    const rest = list.slice(), left = new Map(), out = [];
    for (const c of rest) left.set(domainOf(c), (left.get(domainOf(c)) || 0) + 1);
    while (rest.length) {
      const prev = out.length ? domainOf(out[out.length - 1]) : null;
      let pick = -1;
      for (let i = 0; i < rest.length; i++) {
        const d = domainOf(rest[i]);
        if (d !== prev && (pick < 0 || left.get(d) > left.get(domainOf(rest[pick])))) pick = i;
      }
      if (pick < 0) pick = 0;
      const c = rest.splice(pick, 1)[0];
      left.set(domainOf(c), left.get(domainOf(c)) - 1);
      out.push(c);
    }
    return out;
  }

  // Seen cards that are due (or all seen ones), then unseen cards closest to TARGET success, up to cap,
  // shared out by domain (pickFresh).
  function buildRound(cards, state, opts) {
    const now = opts.now, progress = state.progress, model = state.model || {};
    const seen = cards.filter(c => progress[c.id] && (opts.ignoreDue || progress[c.id].due <= now));
    const rand = opts.random || Math.random;
    const fresh = cards.filter(c => !progress[c.id])
      .map(c => ({ c, d: Math.abs(expected(theta(model, c), c) - TARGET) + rand() * 0.15 }))
      .sort((a, b) => a.d - b.d).map(x => x.c);
    return { seen, fresh: pickFresh(fresh, domainStats(cards, progress), opts.cap) };
  }

  // A scheduled round sized to what is left of today's limit (2026-10-16 request: a round of every due
  // card plus new ones ran past the limit, so the day stopped mid-round and mostly on old cards).
  //   forgetting  due reviews most likely forgotten first: recall is modelled as 2^(-elapsed / half-life)
  //               with the half-life set to the card's interval, so a card is due at 50% and an overdue
  //               or lower-box card ranks ahead (the exponential forgetting curve; FSRS uses the same idea).
  //   learning    new cards are never squeezed out by a backlog: at least NEW_SHARE of the round, within
  //               the adaptive newPerRound (adjustVolume slows new cards when accuracy drops), spread
  //               evenly between reviews so each new card meets a familiar one on both sides.
  // size: today's remaining limit; at or past the limit the round holds EXTRA cards, which the
  // limit pause offers first. Returns the ordered cards and how many of them are reviews.
  const NEW_SHARE = 0.2;
  function recall(p, now) {
    const half = Math.max(INTERVAL_DAYS[p.box || 0], 0.5) * DAY;
    // last review from the log; without one, back from the due date by the interval
    const last = p.log && p.log.length ? Math.max(...p.log.map(e => e[0])) : p.due !== undefined ? p.due - INTERVAL_DAYS[p.box || 0] * DAY : now;
    return Math.pow(2, -(Math.max(0, now - last)) / half);
  }
  function planRound(cards, state, opts) {
    const now = opts.now, progress = state.progress;
    const size = Math.max(opts.size, EXTRA);
    const reviews = buildRound(cards, state, { ...opts, cap: 0 }).seen
      .sort((a, b) => recall(progress[a.id], now) - recall(progress[b.id], now));
    const unseen = cards.filter(c => !progress[c.id]).length;
    const nNew = Math.min(opts.cap, unseen, Math.max(Math.ceil(size * NEW_SHARE), size - reviews.length));
    const fresh = nNew ? buildRound(cards, state, { ...opts, cap: nNew }).fresh : [];
    const old = reviews.slice(0, Math.max(0, size - fresh.length));
    return { list: spread(interleave(shuffleBy(old, opts.random)), interleave(fresh)), review: old.length };
  }
  // Order within the most-forgotten set does not matter, so it is shuffled before interleaving by domain.
  function shuffleBy(list, random) {
    const out = list.slice(), rand = random || Math.random;
    for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
    return out;
  }
  // New cards at even gaps between reviews (none first, so a round opens on something familiar), then
  // a pass that swaps a card away from a same-domain neighbour with one of its own kind (new or review)
  // that fits both places.
  function spread(old, fresh) {
    const out = [], isNew = new Set(fresh);
    let o = 0;
    fresh.forEach((c, i) => {
      const before = old.length ? Math.max(1, Math.floor((i + 1) * old.length / (fresh.length + 1))) : 0;
      while (o < before) out.push(old[o++]);
      out.push(c);
    });
    while (o < old.length) out.push(old[o++]);
    const d = k => (k >= 0 && k < out.length ? domainOf(out[k]) : null);
    for (let i = 1; i < out.length; i++) {
      if (d(i) !== d(i - 1)) continue;
      const j = out.findIndex((c, k) => Math.abs(k - i) > 1 && isNew.has(c) === isNew.has(out[i]) && d(k) !== d(i - 1) && d(k) !== d(i + 1)
        && d(i) !== d(k - 1) && d(i) !== d(k + 1));
      if (j >= 0) [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
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

  // Exam progress (改善規劃.md, stage A): familiarity says "do I know it", risk says "will I make it".
  // work = cards in the scope not yet mastered (box < 3) plus mastered ones falling due before the exam;
  // capacity = days left x recent pace (distinct cards answered per day over the last 7 days). Risk tiers
  // are fixed before seeing data (穩 < 0.7 <= 注意 <= 1 < 危險) and a sure-but-wrong share over 20% is at
  // least 注意 (thinking you know is riskier than knowing you don't). No history: no pace, so no tier.
  const RISK_CALM = 0.7, RISK_DANGER = 1, SURE_WRONG_ALERT = 0.2, PACE_DAYS = 7, PACE_MIN_ACTIVE = 3;
  function examProgress(scopeCards, progress, examTime, now = Date.now()) {
    const daysLeft = Math.max(0, Math.ceil((examTime - now) / DAY));
    let notLearned = 0, dueBefore = 0, sure = 0, sureWrong = 0;
    for (const c of scopeCards) {
      const p = progress[c.id];
      if (!p || p.box < 3) notLearned++;
      else if (p.due <= examTime) dueBefore++;
      for (const e of (p && p.log) || []) if (e[2]) { sure++; if (!e[1]) sureWrong++; }
    }
    const work = notLearned + dueBefore;
    const since = now - PACE_DAYS * DAY, perDay = new Map();
    for (const [id, p] of Object.entries(progress)) {
      for (const e of p.log || []) {
        if (e[0] < since || e[0] > now) continue;
        const day = Math.floor(e[0] / DAY);
        if (!perDay.has(day)) perDay.set(day, new Set());
        perDay.get(day).add(id);
      }
    }
    const answered = [...perDay.values()].reduce((n, s) => n + s.size, 0);
    const hasHistory = Object.keys(progress).length > 0;
    let pace = answered / PACE_DAYS, paceFrom = "recent";
    if (!answered && hasHistory) {
      // Imported or long-idle records with nothing in the last 7 days: the whole-history average
      // (distinct cards per day over the span answered) instead of a pace of 0, flagged as such.
      const days = new Map();
      for (const [id, p] of Object.entries(progress)) {
        for (const e of p.log || []) {
          if (e[0] > now) continue;
          const day = Math.floor(e[0] / DAY);
          if (!days.has(day)) days.set(day, new Set());
          days.get(day).add(id);
        }
      }
      if (days.size) {
        const span = Math.max(...days.keys()) - Math.min(...days.keys()) + 1;
        pace = [...days.values()].reduce((n, s) => n + s.size, 0) / span;
        paceFrom = "all";
      }
    }
    const ratio = !hasHistory ? null : pace > 0 && daysLeft > 0 ? work / (daysLeft * pace) : work ? Infinity : 0;
    let tier = ratio === null ? null : ratio < RISK_CALM ? "穩" : ratio <= RISK_DANGER ? "注意" : "危險";
    const sureWrongShare = sure ? sureWrong / sure : 0;
    if (tier === "穩" && sureWrongShare > SURE_WRONG_ALERT) tier = "注意";
    return { daysLeft, notLearned, dueBefore, work, pace: Math.round(pace * 10) / 10, activeDays: perDay.size,
      unstable: hasHistory && perDay.size < PACE_MIN_ACTIVE, paceFrom, ratio, tier, sureWrongShare,
      perDay: daysLeft > 0 ? Math.ceil(work / daysLeft) : work };
  }

  // Three rounds in a row at 危險 (exam rounds aside): repeating the warning stops helping, so the advice
  // turns to a smaller daily scope (改善規劃.md, learning-expert note). A round without a tier breaks it.
  const DANGER_STREAK = 3;
  function dangerStreak(history, n = DANGER_STREAK) {
    const h = (history || []).filter(x => x && !x.exam).slice(-n);
    return h.length === n && h.every(x => x.tier === "危險");
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
  // A card made in the app ($("addForm")): strings and a timestamp only, always a flip card. An
  // imported card may carry nothing else -- format/num/choices/points would route rendering to the
  // num/mc/essay paths, and a crafted file could then reach an unescaped sink. Fields are capped so a
  // file cannot bloat localStorage. Whitelist, not blacklist: an unknown key is refused.
  const MINE_FIELDS = { id: 1, chapter: 1, label: 1, q: 1, a: 1, created: 1, group: 1, ch: 1 };
  function validMineCard(m) {
    if (!m || typeof m !== "object" || Array.isArray(m)) return false;
    if (!Object.keys(m).every(k => MINE_FIELDS[k])) return false;
    const str = (x, max) => typeof x === "string" && x.length <= max;
    return str(m.id, 60) && str(m.q, 2000) && str(m.a, 2000) &&
      (m.chapter === undefined || str(m.chapter, 200)) && (m.label === undefined || str(m.label, 200)) &&
      (m.group === undefined || str(m.group, 200)) && (m.created === undefined || Number.isFinite(m.created)) &&
      (m.ch === undefined || Number.isFinite(m.ch));
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
    if (data.mine !== undefined && (!Array.isArray(data.mine) || !data.mine.every(validMineCard))) errs.push("自製卡格式不正確");
    if (data.essays !== undefined && (typeof data.essays !== "object" || !Object.values(data.essays).every(Array.isArray))) errs.push("申論作答格式不正確");
    if (data.model !== undefined && (typeof data.model !== "object" || !Object.values(data.model.theta || {}).every(Number.isFinite))) errs.push("能力估計格式不正確");
    return errs;
  }

  // Anonymous sharing (opt-in, asked once): one row per attempt with only what item statistics need.
  // The day but not the time, the letter picked or the number typed but never written text, and first
  // = the learner's first attempt at the card (item statistics count one first attempt per person and
  // card: later ones are not independent and have seen the answer). The receiving Apps Script
  // (apps-script/Code.gs) refuses any other field; engine.test.js checks both sides on the same rows.
  function shareDay(t) {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function shareRow(deck, card, entry, first, id, install) {
    const f = card.format === "mc" || card.format === "num" ? card.format : "";
    return { id, install, deck, card: card.id, day: shareDay(entry[0]), right: entry[1], sure: entry[2],
             score: entry.length > 3 ? entry[3] : entry[1], answer: f ? String(entry.length > 4 ? entry[4] : "").slice(0, ANSWER_MAX) : "",
             first: first ? 1 : 0, level: level(card) };
  }

  const Engine = { examProgress, dangerStreak, DANGER_STREAK, EXPORT_VERSION, shareRow, shareDay, validateExport, attempt, LEVEL_NAME, TARGET, INTERVAL_DAYS, DAY, prob, expected, level, theta, updateAbility, keywordHit,
                   matchPoints, parseNumber, grade, passed, schedule, retryAt, buildRound, planRound, recall, NEW_SHARE, fullPass, buildExam, domainStats, pickFresh, interleave, MIN_SAMPLE, summarize, since, mastery, pauseReason, diagnose, DIAG, DAILY_MAX, EXTRA, RECENT_TODAY, recentScores, adjustVolume };
  if (typeof module === "object" && module.exports) module.exports = Engine; else root.Engine = Engine;
})(typeof window === "undefined" ? globalThis : window);
