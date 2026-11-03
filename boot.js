/// Copyright (c) 2026 si-kui-a. All rights reserved. The code is not open source; see README "授權".
// Runs this app on another page of the same origin (10-1001 Deutsch Weg's Indonesian page) without a
// second copy of the code: the page sets window.SITE (decks, storage keys, texts, palette) and loads this
// file. It reads this site's index.html at run time and takes its styles, markup and scripts, so every
// change made here reaches the other page on its next visit. Relative fetches (deck files, sw.js) resolve
// against the other page, so it serves its own cards and offline cache.
(async () => {
  const base = new URL(".", document.currentScript.src);
  if (document.readyState === "loading") await new Promise(r => document.addEventListener("DOMContentLoaded", r));
  const html = await (await fetch(new URL("index.html", base), { cache: "no-cache" })).text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const style of doc.head.querySelectorAll("style")) document.head.append(document.importNode(style, true));
  const scripts = [...doc.body.querySelectorAll("script")];
  scripts.forEach(s => s.remove());
  document.body.replaceChildren(...[...doc.body.childNodes].map(n => document.importNode(n, true)));
  // In order, each after the previous one ran: the inline app needs engine.js first
  for (const s of scripts) {
    const el = document.createElement("script");
    if (s.getAttribute("src")) {
      el.src = new URL(s.getAttribute("src"), base).href;
      await new Promise((ok, fail) => { el.onload = ok; el.onerror = () => fail(new Error(`${el.src} did not load`)); document.body.append(el); });
    } else {
      el.textContent = s.textContent;
      document.body.append(el);
    }
  }
})().catch(e => {
  document.body.textContent = `無法載入：${e.message}。請連上網路後重新整理。`;
});
