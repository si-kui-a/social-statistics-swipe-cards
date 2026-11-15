/// Copyright (c) 2026 si-kui-a. All rights reserved. The code is not open source; see README "授權".
// On-screen exam calculator for the swipe app: pure functions, no page access (calc.test.js runs them in
// Node; index.html loads this file as a plain script, window.Calc). It copies what a national-exam
// scientific calculator offers: type the expression with keys, press =, and in the statistics mode enter
// data with DATA, then read n, Σx, Σx², x̄, σn (population) and sn-1 (sample). No eval: a small parser.
// Every = is written to a tape ("expression = result"), which is the worked formula the course asks for.
(function (root) {
  "use strict";
  const STAT_KEYS = { n: "n", sx: "Σx", sx2: "Σx²", mean: "x̄", sigma: "σn", s: "sn-1" };
  const MAX_TAPE = 30;

  function create() { return { mode: "COMP", toks: [], shown: "", ans: 0, data: [], tape: [], err: "" }; }

  // 10 significant digits like a calculator, no trailing zeros; huge or tiny values in e-notation.
  function fmt(x) {
    if (!Number.isFinite(x)) return "Math ERROR";
    if (x === 0) return "0";
    const a = Math.abs(x);
    if (a >= 1e10 || a < 1e-9) return Number(x.toPrecision(10)).toExponential().replace("e+", "e");
    return String(Number(x.toPrecision(10)));
  }

  function stats(data) {
    const n = data.length, sx = data.reduce((p, c) => p + c, 0), sx2 = data.reduce((p, c) => p + c * c, 0);
    const mean = n ? sx / n : NaN;
    const ss = data.reduce((p, c) => p + (c - mean) * (c - mean), 0);  // two-pass: no cancellation
    return { n, sx, sx2, mean, sigma: n ? Math.sqrt(ss / n) : NaN, s: n > 1 ? Math.sqrt(ss / (n - 1)) : NaN };
  }

  // tokens: numbers as strings, operators + − × ÷ ^, ( ) √( log( ln(, postfix ² ⁻¹, names Ans n Σx Σx² x̄ σn sn-1 π
  function evaluate(toks, st) {
    let i = 0;
    const st2 = stats(st.data), peek = () => toks[i];
    const fail = m => { throw new Error(m); };
    const NAME = { "Ans": () => st.ans, "π": () => Math.PI, "n": () => st2.n, "Σx": () => st2.sx, "Σx²": () => st2.sx2,
                   "x̄": () => st2.mean, "σn": () => st2.sigma, "sn-1": () => st2.s };
    function expr() {
      let v = term();
      while (peek() === "+" || peek() === "−") { const op = toks[i++]; const r = term(); v = op === "+" ? v + r : v - r; }
      return v;
    }
    function term() {
      let v = unary();
      for (;;) {
        const t = peek();
        if (t === "×" || t === "÷") { i++; const r = unary(); if (t === "÷" && r === 0) fail("Math ERROR"); v = t === "×" ? v * r : v / r; }
        else if (t !== undefined && t !== ")" && t !== "+" && t !== "−" && !"²⁻¹^".includes(t)) v *= unary();  // 2(3), 2√(9), 3x̄
        else return v;
      }
    }
    function unary() {
      if (peek() === "−") { i++; return -unary(); }
      if (peek() === "+") fail("Syntax ERROR");
      return post();
    }
    function post() {
      let v = primary();
      for (;;) {
        if (peek() === "²") { i++; v = v * v; }
        else if (peek() === "⁻¹") { i++; if (v === 0) fail("Math ERROR"); v = 1 / v; }
        else if (peek() === "^") { i++; v = Math.pow(v, unary()); }
        else return v;
      }
    }
    function primary() {
      const t = toks[i++];
      if (t === undefined) fail("Syntax ERROR");
      if (/^[0-9.]/.test(t)) { const v = Number(t); if (Number.isNaN(v)) fail("Syntax ERROR"); return v; }
      if (NAME[t]) { const v = NAME[t](); if (Number.isNaN(v)) fail("Math ERROR"); return v; }
      if (t === "(") { const v = expr(); if (peek() === ")") i++; return v; }  // a missing ) closes itself, like a calculator
      if (t === "√(") { const v = expr(); if (peek() === ")") i++; if (v < 0) fail("Math ERROR"); return Math.sqrt(v); }
      if (t === "log(" || t === "ln(") {
        const v = expr(); if (peek() === ")") i++; if (v <= 0) fail("Math ERROR");
        return t === "log(" ? Math.log10(v) : Math.log(v);
      }
      return fail("Syntax ERROR");
    }
    const v = expr();
    if (i < toks.length) fail("Syntax ERROR");
    return v;
  }

  function show(st) { return st.toks.join("") || "0"; }

  function push(st, tok) {
    if (st.shown) {  // after =: a number or function starts fresh, an operator continues from the answer
      const cont = ["+", "−", "×", "÷", "^", "²", "⁻¹"].includes(tok);
      st.toks = cont ? ["Ans"] : [];
      st.shown = "";
    }
    st.err = "";
    st.toks.push(tok);
  }

  function pushDigit(st, ch) {
    const last = st.toks[st.toks.length - 1];
    if (!st.shown && last !== undefined && /^[0-9.]+$/.test(last)) {
      if (ch === "." && last.includes(".")) return;
      st.toks[st.toks.length - 1] = last + ch;
      return;
    }
    push(st, ch === "." ? "0." : ch);
  }

  // Value of the expression so far, or throws; used by = and DATA.
  function value(st) { return evaluate(st.toks, st); }

  const OPS = { add: "+", sub: "−", mul: "×", div: "÷", pow: "^", lp: "(", rp: ")", sqrt: "√(", log: "log(", ln: "ln(", pi: "π", ans: "Ans" };
  const POST = { sq: "²", inv: "⁻¹" };

  // press(state, key): keys 0-9 . add sub mul div pow lp rp sqrt sq inv log ln pi neg ans DEL AC eq mode
  // DATA DELDATA CLRSTAT and the stat reads n sx sx2 mean sigma s. Returns the state (mutated).
  function press(st, key) {
    try {
      if (/^[0-9]$/.test(key) || key === ".") return pushDigit(st, key), st;
      if (OPS[key]) return push(st, OPS[key]), st;
      if (POST[key]) return push(st, POST[key]), st;
      if (key === "neg") return push(st, "−"), st;
      if (STAT_KEYS[key]) {
        if (st.mode !== "STAT") { st.err = "先按 MODE 進統計模式"; return st; }
        return push(st, STAT_KEYS[key]), st;
      }
      if (key === "DEL") {
        if (st.shown) { st.shown = ""; return st; }
        const last = st.toks[st.toks.length - 1];
        if (last !== undefined && /^[0-9.]{2,}$/.test(last)) st.toks[st.toks.length - 1] = last.slice(0, -1);
        else st.toks.pop();
        st.err = ""; return st;
      }
      if (key === "AC") { st.toks = []; st.shown = ""; st.err = ""; return st; }
      if (key === "mode") {
        st.mode = st.mode === "COMP" ? "STAT" : "COMP";
        st.toks = []; st.shown = ""; st.err = ""; return st;
      }
      if (key === "eq") {
        if (!st.toks.length) return st;
        const text = show(st), v = value(st);
        st.ans = v; st.shown = fmt(v); st.err = "";
        st.tape.push({ expr: text, value: v, text: st.shown });
        if (st.tape.length > MAX_TAPE) st.tape.shift();
        return st;
      }
      if (key === "DATA") {
        if (st.mode !== "STAT") { st.err = "先按 MODE 進統計模式"; return st; }
        if (!st.toks.length) return st;
        const v = value(st);
        st.data.push(v); st.toks = []; st.shown = ""; st.err = "";
        return st;
      }
      if (key === "DELDATA") { st.data.pop(); return st; }
      if (key === "CLRSTAT") { st.data = []; st.toks = []; st.shown = ""; st.err = ""; return st; }
    } catch (e) { st.err = e.message; st.toks = []; st.shown = ""; }
    return st;
  }

  // What the display shows: the expression, or the answer after =, or the error.
  function display(st) {
    if (st.err) return { top: st.err, main: "" };
    return { top: st.shown ? show({ toks: st.toks }) : "", main: st.shown || show(st) };
  }

  const api = { create, press, display, evaluate, stats, fmt, value };
  if (typeof module === "object" && module.exports) module.exports = api; else root.Calc = api;
})(typeof window !== "undefined" ? window : globalThis);
