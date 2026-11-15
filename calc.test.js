// Tests for calc.js. Run: node calc.test.js (exit 1 on failure).
"use strict";
const C = require("./calc.js");
let fails = 0;
function ok(name, cond) { console.log(`${cond ? "PASS" : "FAIL"} ${name}`); if (!cond) fails++; }
function keys(st, list) { for (const k of list) C.press(st, k); return st; }
const digits = s => [...s].map(ch => ch === "-" ? "sub" : ch);

let s = keys(C.create(), [..."85", "sub", ..."70", "eq"]);
ok("85−70 = 15", s.shown === "15");
s = keys(C.create(), ["lp", ..."85", "sub", ..."70", "rp", "div", ..."10", "eq"]);
ok("Z = (85−70)÷10 = 1.5", s.shown === "1.5" && s.tape[0].expr === "(85−70)÷10");
s = keys(C.create(), [..."12", "div", "sqrt", ..."36", "rp", "eq"]);
ok("12÷√(36) = 2 (standard error)", s.shown === "2");
s = keys(C.create(), [..."50", "add", ..."1", ".", ..."96", "mul", ..."10", "div", "sqrt", ..."100", "eq"]);
ok("50+1.96×10÷√(100) = 51.96 (left to right)", s.shown === "51.96");
s = keys(C.create(), [..."50", "add", ..."1", ".", ..."96", "mul", "lp", ..."10", "div", "sqrt", ..."100", "eq"]);
ok("missing ) closes itself: 50+1.96×(10÷√(100 = 51.96", s.shown === "51.96");
s = keys(C.create(), [..."2", "sq", "add", ..."3", "sq", "eq"]);
ok("x² key", s.shown === "13");
s = keys(C.create(), [..."4", "inv", "eq"]);
ok("x⁻¹ key", s.shown === "0.25");
s = keys(C.create(), [..."1", "div", ..."0", "eq"]);
ok("divide by zero: Math ERROR, calculator usable after", s.err === "Math ERROR" && keys(s, ["AC", "2", "add", "2", "eq"]).shown === "4");
s = keys(C.create(), ["sqrt", "neg", "4", "eq"]);
ok("√(−4): Math ERROR", s.err === "Math ERROR");
s = keys(C.create(), [..."5", "add", "eq"]);
ok("5+ : Syntax ERROR", s.err === "Syntax ERROR");
s = keys(C.create(), [..."0", ".", "1", "add", "0", ".", "2", "eq"]);
ok("0.1+0.2 shows 0.3 (10 digits)", s.shown === "0.3");
s = keys(C.create(), [".", "5", "mul", "2", "eq"]);
ok("leading . = 0.5", s.shown === "1");
s = keys(C.create(), [..."1", ".", ".", "5", "eq"]);
ok("second . ignored", s.shown === "1.5");

// continue from the answer
s = keys(C.create(), [..."6", "mul", "7", "eq", "add", "8", "eq"]);
ok("operator after = continues from Ans: 42+8", s.shown === "50" && s.tape[1].expr === "Ans+8");
s = keys(C.create(), [..."6", "eq", "7", "eq"]);
ok("digit after = starts fresh", s.shown === "7");

// STAT mode: 1,2,3 population sigma sqrt(2/3)
s = C.create();
ok("stat key outside STAT mode is refused", keys(s, ["sigma"]).err.includes("MODE"));
keys(s, ["mode"]);
for (const x of [1, 2, 3]) keys(s, [String(x), "DATA"]);
ok("n = 3", keys(s, ["n", "eq"]).shown === "3");
ok("Σx = 6", keys(s, ["AC", "sx", "eq"]).shown === "6");
ok("Σx² = 14", keys(s, ["AC", "sx2", "eq"]).shown === "14");
ok("x̄ = 2", keys(s, ["AC", "mean", "eq"]).shown === "2");
ok("σn = 0.8164965809", keys(s, ["AC", "sigma", "eq"]).shown === "0.8164965809");
ok("sn-1 = 1", keys(s, ["AC", "s", "eq"]).shown === "1");
ok("σn×2 = 1.632993162 (linear transform)", keys(s, ["AC", "sigma", "mul", "2", "eq"]).shown === "1.632993162");
keys(s, ["DELDATA"]);
ok("DELDATA removes the last entry: n = 2", keys(s, ["AC", "n", "eq"]).shown === "2");
keys(s, ["CLRSTAT"]);
ok("CLRSTAT: n = 0 and σn is Math ERROR", keys(s, ["n", "eq"]).shown === "0" && keys(s, ["AC", "sigma", "eq"]).err === "Math ERROR");
// a data value can be an expression
s = keys(C.create(), ["mode", "2", "mul", "3", "DATA", "4", "DATA"]);
ok("DATA takes an expression's value", C.stats(s.data).sx === 10);
// the 11-10 quiz: population vs sample on the same data, sigma never below the mean absolute deviation
const q = [5, 4, 8, 8, 9, 19, 21, 40];
const st = C.stats(q);
ok("population σ < sample s", st.sigma < st.s);
// DEL
s = keys(C.create(), [..."123", "DEL", "DEL", "eq"]);
ok("DEL deletes one digit at a time", s.shown === "1");
// tape
s = keys(C.create(), [..."1", "add", "1", "eq", "AC", "2", "mul", "2", "eq"]);
ok("tape keeps every =", s.tape.length === 2 && s.tape[1].expr === "2×2");
// log for Sturges: k = 1 + 3.322 log10(100) = 7.644
s = keys(C.create(), ["1", "add", ..."3", ".", "3", "2", "2", "mul", "log", ..."100", "eq"]);
ok("Sturges 1+3.322×log(100) = 7.644", s.shown === "7.644");
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
console.log("all passed");
