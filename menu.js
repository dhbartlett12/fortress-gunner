// Fortress Gunner 1.8.1 — main menu, briefing, seat/difficulty pick, settings, service record, pause menu.
(function () {
  "use strict";
  const A = () => window.FG_API, $ = (h) => { const d = document.createElement("div"); d.innerHTML = h.trim(); return d.firstChild; };
  const LS = (k, v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem(k) || "null"); localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } };
  const MIX0 = { master: 1, engines: 1, guns: 1, radio: 1, music: 0.6 };
  const mix = Object.assign({}, MIX0, LS("fg_mix") || {});
  let seat = LS("fg_seat") || "top", diff = LS("fg_diff") || "easy";
  const SEATS = [["top", "TOP TURRET", "B-17 · twin .50"], ["tail", "TAIL GUNNER", "B-17 · twin .50"], ["p51", "P-51D MUSTANG", "Escort · 6×.50"], ["109", "BF 109 G-6", "2×MG131 + MG151/20"], ["190", "FW 190 A-8/R2", "Sturm · 2×MG151 + 2×MK108"], ["flak", "8.8 cm FLAK", "Ground battery"]];
  const root = $('<div id="fgMenu" class="fgm"></div>'); document.body.appendChild(root);
  const title = document.getElementById("title");
  // ---- menu audio: engine drone + slow music pad (own tiny graph, stopped when the mission starts) ----
  let mc = null, mg = null, mm = null;
  function menuAudio() {
    if (mc) { if (mc.state === "suspended") mc.resume(); return; }
    try { mc = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
    const out = mc.createGain(); out.gain.value = mix.master; out.connect(mc.destination);
    mg = mc.createGain(); mg.gain.value = 0.10 * mix.engines; mg.connect(out);
    const lp = mc.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 260; lp.connect(mg);
    [38, 41.5, 57, 76.3].forEach((f, i) => { const o = mc.createOscillator(); o.type = "sawtooth"; o.frequency.value = f; const lfo = mc.createOscillator(), lg = mc.createGain(); lfo.frequency.value = 0.13 + i * 0.07; lg.gain.value = 0.6; lfo.connect(lg); lg.connect(o.frequency); const g = mc.createGain(); g.gain.value = 0.25; o.connect(g); g.connect(lp); o.start(); lfo.start(); });
    mm = mc.createGain(); mm.gain.value = 0.05 * mix.music; mm.connect(out); out.m = out; mc.out = out;
    const rv = mc.createDelay(1.2); rv.delayTime.value = 0.45; const fb = mc.createGain(); fb.gain.value = 0.45; rv.connect(fb); fb.connect(rv); rv.connect(mm);
    const CH = [[220, 261.6, 329.6], [174.6, 220, 261.6], [196, 246.9, 293.7], [164.8, 207.7, 246.9]]; let ci = 0;
    const play = () => { if (!mc || mc.state === "closed") return; const t = mc.currentTime; CH[ci++ % 4].concat([CH[(ci + 3) % 4][0] / 2]).forEach((f) => { const o = mc.createOscillator(), g = mc.createGain(); o.type = "triangle"; o.frequency.value = f; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.5, t + 1.2); g.gain.linearRampToValueAtTime(0, t + 4); o.connect(g); g.connect(mm); g.connect(rv); o.start(t); o.stop(t + 4.1); }); mc.tm = setTimeout(play, 3600); };
    play();
  }
  function menuAudioMix() { if (!mc) return; mc.out.gain.value = mix.master; mg.gain.value = 0.10 * mix.engines; mm.gain.value = 0.05 * mix.music; }
  function menuAudioStop() { if (mc) { clearTimeout(mc.tm); try { mc.close(); } catch (e) {} mc = null; } }
  function pushMix() { LS("fg_mix", mix); if (window.FGAudio && window.FGAudio.setMix) window.FGAudio.setMix(mix); menuAudioMix(); }
  // ---- screens ----
  const btn = (id, t, sub) => `<button class="fgb" data-a="${id}">${t}${sub ? `<small>${sub}</small>` : ""}</button>`;
  function show(h, cls) { root.className = "fgm " + (cls || ""); root.innerHTML = h; root.style.display = "flex"; }
  function hide() { root.style.display = "none"; root.innerHTML = ""; }
  let back = null;
  function main() {
    back = null; if (title) title.style.display = "none"; document.body.classList.add("fgmenu");
    show(`<div class="fgp"><h1>FORTRESS GUNNER</h1><div class="fgs">8TH AIR FORCE · 1943 · v1.8.1</div>
      ${btn("fly", "FLY MISSION")}${btn("select", "MISSION SELECT")}${btn("settings", "SETTINGS")}${btn("record", "SERVICE RECORD")}</div>`, "fgmain");
  }
  function select() { back = main; show(`<div class="fgp"><h2>MISSION SELECT</h2><div class="fgcard" data-a="brief"><b>MISSION 1 — BREMEN</b><span>17 April 1943 · 18 B-17Fs of the combat wing box · Focke-Wulf works</span><em>SELECT ▸</em></div>${btn("back", "BACK")}</div>`); }
  function brief() {
    back = main;
    show(`<div class="fgp fgwide"><h2>BRIEFING — BREMEN</h2>
      <svg viewBox="0 0 300 150" class="fgmap"><rect width="300" height="150" fill="#2b3a2a"/><path d="M0 40 Q60 30 90 60 T170 50 L300 30 L300 0 L0 0Z" fill="#30475a"/><path d="M40 125 L120 100 L190 70 L238 52" stroke="#e8d27a" stroke-width="2.5" fill="none" stroke-dasharray="6 4"/><circle cx="40" cy="125" r="4" fill="#9fd"/><text x="48" y="138" fill="#cfe" font-size="10">IP</text><circle cx="240" cy="50" r="9" fill="none" stroke="#f55" stroke-width="2"/><path d="M233 43l14 14M247 43l-14 14" stroke="#f55" stroke-width="2"/><text x="208" y="76" fill="#fbb" font-size="10">BREMEN</text><text x="110" y="92" fill="#ccc" font-size="9">P-51 escort to target</text><text x="150" y="122" fill="#fc8" font-size="9">JG 1 / JG 11 · 109s & 190s</text></svg>
      <table class="fgt"><tr><td>TARGET</td><td>Focke-Wulf aircraft plant, Bremen</td></tr><tr><td>FORCE</td><td>18 B-17s — tight combat wing box, you fly lead squadron</td></tr><tr><td>ESCORT</td><td>P-51 Mustangs, roving</td></tr><tr><td>EXPECTED</td><td>Bf 109 Gruppe, mass head-on attacks; Fw 190 Sturm with 30 mm</td></tr><tr><td>WEATHER</td><td>Scattered cumulus, haze over the target · flak heavy</td></tr></table>
      ${btn("seat", "CHOOSE SEAT ▸")}${btn("back", "BACK")}</div>`);
  }
  function seatPick(inGame, de) {
    back = inGame ? pause : brief; const L = de ? SEATS.filter((q) => q[0] === "109" || q[0] === "190" || q[0] === "flak") : SEATS;
    show(`<div class="fgp fgwide"><h2>${de ? "ABGESCHOSSEN — NEW GERMAN SEAT" : inGame ? "CHANGE SEAT" : "CHOOSE YOUR SEAT"}</h2><div class="fggrid">${L.map(([k, t, s]) => `<button class="fgb fgseat${k === seat ? " on" : ""}" data-seat="${k}">${t}<small>${s}</small></button>`).join("")}</div>${btn("back", "BACK")}</div>`);
  }
  function diffPick() { back = () => seatPick(false); show(`<div class="fgp"><h2>DIFFICULTY</h2>${btn("d_easy", "EASY", "Autopilot holds formation · aim assist")}${btn("d_medium", "NORMAL", "You fly it")}${btn("back", "BACK")}</div>`); }
  function record() { back = main; const r = (A() && A().record()) || {}; show(`<div class="fgp"><h2>SERVICE RECORD</h2><table class="fgt"><tr><td>MISSIONS</td><td>${r.missions || 0}</td></tr><tr><td>SUCCESSFUL</td><td>${r.won || 0}</td></tr><tr><td>KILLS</td><td>${r.kills || 0}</td></tr><tr><td>B-17s BROUGHT HOME</td><td>${r.b17home || 0}</td></tr><tr><td>BEST SCORE</td><td>${r.best || 0}</td></tr></table>${btn("back", "BACK")}</div>`); }
  let tab = "controls";
  function settings(from) {
    back = from || back || main; const S = (A() && A().settings) || {};
    const ck = (k, t) => `<label class="fgck"><input type="checkbox" data-set="${k}" ${S[k] ? "checked" : ""}> ${t}</label>`;
    const sl = (k, t) => `<label class="fgsl">${t}<input type="range" min="0" max="1" step="0.05" data-mix="${k}" value="${mix[k]}"></label>`;
    const body = tab === "controls" ? `${ck("invTurret", "Invert turret look")}${ck("invFlak", "Invert flak aim")}${ck("invPilot", "Invert pilot pitch")}<label class="fgsl">Sensitivity<input type="range" min="0.4" max="2" step="0.05" data-set="sens" value="${S.sens || 1}"></label>
      <svg viewBox="0 0 320 130" class="fgpad"><rect x="40" y="20" width="240" height="90" rx="40" fill="#333" stroke="#888"/><circle cx="95" cy="55" r="14" fill="#555"/><circle cx="200" cy="85" r="14" fill="#555"/><rect x="108" y="74" width="26" height="8" fill="#666"/><rect x="117" y="65" width="8" height="26" fill="#666"/><g font-size="9" fill="#ddd"><circle cx="240" cy="45" r="7" fill="#c90"/><circle cx="225" cy="58" r="7" fill="#24a"/><circle cx="255" cy="58" r="7" fill="#a22"/><circle cx="240" cy="71" r="7" fill="#2a4"/><text x="4" y="12">LT zoom / RT fire</text><text x="210" y="12">Y A B X: seat / view</text><text x="40" y="126">L-stick fly/aim · R-stick look (click = recenter)</text><text x="126" y="104">D-pad ↑↓ throttle · ←→ weapons</text><text x="150" y="40">START pause</text></g></svg>`
      : tab === "audio" ? `${sl("master", "Master")}${sl("engines", "Engines")}${sl("guns", "Guns")}${sl("radio", "Radio")}${sl("music", "Music (menu)")}`
      : `<div class="fgrow">${["medium", "ultra"].map((q) => `<button class="fgb fgsm${S.quality === q ? " on" : ""}" data-q="${q}">${q.toUpperCase()}</button>`).join("")}</div>${ck("fps", "Show FPS counter")}`;
    show(`<div class="fgp fgwide"><h2>SETTINGS</h2><div class="fgrow">${["controls", "audio", "graphics"].map((t) => `<button class="fgb fgsm${t === tab ? " on" : ""}" data-tab="${t}">${t.toUpperCase()}</button>`).join("")}</div><div class="fgbody">${body}</div>${btn("back", "BACK")}</div>`);
  }
  function pause() { back = null; show(`<div class="fgp"><h2>PAUSED</h2>${btn("resume", "RESUME")}${btn("psettings", "SETTINGS")}${btn("pseat", "CHANGE SEAT")}${btn("quit", "QUIT MISSION")}</div>`, "fgpause"); }
  function go() { LS("fg_seat", seat); LS("fg_diff", diff); hide(); menuAudioStop(); pushMix(); A().start({ seat, diff }); pushMix(); }
  root.addEventListener("input", (ev) => { const t = ev.target; if (t.dataset.mix) { mix[t.dataset.mix] = +t.value; pushMix(); } if (t.dataset.set === "sens") A().set({ sens: +t.value }); });
  root.addEventListener("change", (ev) => { const t = ev.target; if (t.type === "checkbox" && t.dataset.set) A().set({ [t.dataset.set]: t.checked }); });
  root.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-a],[data-seat],[data-tab],[data-q]"); if (!b) return; ev.stopPropagation(); menuAudio();
    const inGame = A() && A().state === "PLAYING";
    if (b.dataset.seat) { seat = b.dataset.seat; LS("fg_seat", seat); if (inGame) { A().seat(seat); A().pause(false); hide(); } else diffPick(); return; }
    if (b.dataset.tab) { tab = b.dataset.tab; return settings(back); }
    if (b.dataset.q) { A().set({ quality: b.dataset.q }); return settings(back); }
    const a = b.dataset.a;
    ({ fly: brief, select, brief, seat: () => seatPick(false), settings: () => settings(main), record, back: () => (back || main)(),
       d_easy: () => { diff = "easy"; go(); }, d_medium: () => { diff = "medium"; go(); },
       resume: () => { hide(); A().pause(false); }, psettings: () => settings(pause), pseat: () => seatPick(true), quit: () => A().quit() }[a] || main)();
  });
  root.addEventListener("pointerdown", (e) => e.stopPropagation()); root.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
  window.addEventListener("fg-pause", (e) => { if (e.detail.on) { if (e.detail.why === "seat-de") seatPick(true, true); else pause(); } else hide(); });
  window.addEventListener("keydown", (e) => { const k = e.key.toLowerCase(); if ((k === "escape" || k === "p") && A() && A().state === "PLAYING") { if (!A().paused) A().pause(true); else if (!back) { hide(); A().pause(false); } } }, true);
  document.addEventListener("pointerdown", () => { if (root.style.display !== "none" && !(A() && A().state === "PLAYING")) menuAudio(); }, { once: true });
  window.FGMenu = { main, brief, settings: () => settings(main), pause, seatPick, record, get mix() { return mix; } };
  window.addEventListener("load", () => { pushMix(); main(); });
})();
