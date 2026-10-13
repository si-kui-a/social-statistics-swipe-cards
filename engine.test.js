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
  ok("today: only attempts since the start", d.n === 3 && d.right === 2 && d.pct === 67);
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

// service worker: pages and cards must be revalidated, or a phone keeps yesterday's engine.js from
// the browser's HTTP cache even when online (2026-10-12: a new grading rule did not load)
const sw = require("fs").readFileSync(require("path").join(__dirname, "sw.js"), "utf8");
ok("sw: fresh files fetched with no-cache", /fetch\(event\.request,\s*\{\s*cache:\s*"no-cache"\s*\}\)/.test(sw));

console.log(`${fails} failed`);
process.exit(fails ? 1 : 0);
