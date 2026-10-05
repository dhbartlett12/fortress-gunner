/* Fortress Gunner 1.6.0 — CREW VOICES (voice.js)
 * Kokoro-82M (Apache-2.0) generated lines, radio-processed offline (see ITERATION_LOG 1.6.0): 123 lines + 85 clock-call pieces packed in assets/voices/voices.bin (Opus/OGG, 16 kHz mono, 0.72 MB) + voices.json.
 * One voice at a time, priority queue 3/2/1/0 (3 interrupts), per-id 60 s and per-trigger cooldowns, chatter limits, silence while flak-deafened / bailed out, dead stations silent,
 * engines+guns ducked ~4 dB under a voice (AudioContext graph in audio.js: FGAudio.voiceBus / FGAudio.duck). Everything runs on the SIM clock (tick(now)), so the director is testable at any speed ("virtual" mode plays nothing).
 * Templates (bare pieces) are assembled into "Bandits, ten o'clock, high!" and run through the same radio chain as the baked lines (HP/LP, presence, tanh, squelch click + tail, hiss). */
(function () {
  "use strict";
  const KEY = "fg_voices";
  let enabled = true; try { enabled = localStorage.getItem(KEY) !== "off"; } catch (e) {}
  const V = { enabled, virtual: false, ready: false, failed: false, idx: null, log: [], stats: { said: 0, dropped: {}, interrupts: 0, decodeMs: 0, decodes: 0, errors: 0 }, silenced: false, gunsFiring: false, deadFn: null };
  V.virtual = !!window.__FG_VOICE_VIRTUAL; // test hook: director runs on the sim clock but plays nothing
  let blob = null, A = null, now = 0;
  const cache = new Map(); // id → {buf, secs, t}
  let cacheSecs = 0; const CACHE_MAX = 110;
  const lastId = {}, trgLast = {}, onceDone = {};
  let queue = [], cur = null, lastEnd = -99, lastCritEnd = -99, lastChatter = -99, lastLoud = -99, curChain = null;
  const TRG_CD = { bandit: 4, flak: 5, hit: 3, kill: 12, mustang: 15, clear: 20, rc: 0, plain: 1 };
  const drop = (why) => { V.stats.dropped[why] = (V.stats.dropped[why] || 0) + 1; return false; };

  V.load = function () {
    if (V.ready || V.loading) return;
    V.loading = true;
    try {
      const get = (url, type, cb) => { const x = new XMLHttpRequest(); x.open("GET", url, true); x.responseType = type; x.onload = () => { if (x.status === 200 || (x.status === 0 && x.response)) cb(x.response); else { V.failed = true; } }; x.onerror = () => { V.failed = true; }; x.send(); };
      // 1.6.0: Opus/OGG first (0.72 MB); if this WebView cannot decode it (probe on an OfflineAudioContext, or any real decode failure) switch to the MP3 twin pack (same ids, 1.4 MB)
      const loadPack = (name, done) => get("assets/voices/" + name + ".json", "json", (j) => get("assets/voices/" + name + ".bin", "arraybuffer", (b) => done(j, b)));
      const useMp3 = () => { if (V.fmt === "mp3" || V.fbLoading) return; V.fbLoading = true; loadPack("voices_mp3", (j, b) => { V.idx = j; blob = b; cache.clear(); cacheSecs = 0; V.fmt = "mp3"; V.fbLoading = false; V.ready = true; }); };
      V.useMp3 = useMp3;
      loadPack("voices", (j, b) => {
        V.idx = j; blob = b; V.fmt = "opus"; V.ready = true;
        if (window.__FG_VOICE_FORCE_MP3) { V.ready = false; useMp3(); return; } // test hook
        try {
          const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext; let k0 = null; for (const k in j) { if (k0 == null || j[k].n < j[k0].n) k0 = k; }
          if (OAC && k0 != null) { const oc = new OAC(1, 22050, 22050); const pr = oc.decodeAudioData(b.slice(j[k0].o, j[k0].o + j[k0].n), () => { V.probe = "opus-ok"; }, () => { V.probe = "opus-fail"; useMp3(); }); if (pr && pr.catch) pr.catch(() => {}); }
        } catch (e) { V.probe = "probe-err"; }
      });
    } catch (e) { V.failed = true; V.stats.errors++; }
  };
  V.setEnabled = function (b) { V.enabled = !!b; try { localStorage.setItem(KEY, b ? "on" : "off"); } catch (e) {} if (!b) V.cut(true); };
  V.reset = function () { V.cut(true); queue = []; for (const k in lastId) delete lastId[k]; for (const k in trgLast) delete trgLast[k]; for (const k in onceDone) delete onceDone[k]; lastEnd = -99; lastCritEnd = -99; lastChatter = -99; lastLoud = -99; V.lastT = 0; V.silenced = false; V.log.length = 0; V.stats.said = 0; V.stats.dropped = {}; V.stats.interrupts = 0; V.stats.overlaps = 0; };
  V.silence = function (on) { V.silenced = !!on; if (on) { queue = []; V.cut(false, "silenced"); } };
  V.cut = function (hard, why) { if (!cur) return; try { if (cur.src) { const g = cur.gain; if (g && A && !hard) { const t = A.ctx.currentTime; g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(0.0001, t, 0.04); cur.src.stop(t + 0.2); } else { cur.src.stop(); if (cur.gain) cur.gain.disconnect(); } } } catch (e) {} duck(false); log(cur, why || "cut"); cur = null; };
  function log(c, why) { if (V.log.length < 400) V.log.push({ id: c.id, prio: c.prio, spk: c.spk, t0: +c.t0.toFixed(2), t1: +now.toFixed(2), dur: c.dur, end: why }); }
  function duck(on) { try { if (!V.virtual && window.FGAudio && window.FGAudio.duck) window.FGAudio.duck(on); } catch (e) {} }
  V.setNow = function (t) { now = t; };

  // ---- decode (cache by seconds) ----
  function decode(id) {
    const hit = cache.get(id); if (hit) { hit.t = now; return Promise.resolve(hit.buf); }
    const e = V.idx && V.idx[id]; if (!e || !blob || !A) return Promise.resolve(null);
    const t0 = performance.now();
    return new Promise((res) => {
      try {
        A.ctx.decodeAudioData(blob.slice(e.o, e.o + e.n), (buf) => {
          V.stats.decodeMs += performance.now() - t0; V.stats.decodes++;
          cache.set(id, { buf, secs: buf.duration, t: now }); cacheSecs += buf.duration;
          if (cacheSecs > CACHE_MAX) { const arr = [...cache.entries()].sort((a, b) => a[1].t - b[1].t); for (const [k, v] of arr) { if (cacheSecs <= CACHE_MAX * 0.8) break; if (k === id) continue; cache.delete(k); cacheSecs -= v.secs; } }
          res(buf);
        }, () => { V.stats.errors++; V.decodeFail = (V.decodeFail || 0) + 1; if (V.fmt === "opus" && V.useMp3) V.useMp3(); res(null); });
      } catch (er) { V.stats.errors++; res(null); }
    });
  }
  V.prefetch = function (ids) { if (!V.enabled) return; A = A || (window.FGAudio && window.FGAudio.voiceBus ? window.FGAudio.voiceBus() : null); if (V.virtual || !A || !V.ready) return; let k = 0; for (const id of ids) setTimeout(() => decode(id), 40 * k++); };

  // ---- requests ----
  function speakerOk(spk) { if (V.deadFn && V.deadFn(spk)) return false; return true; }
  // item: {id | parts:[ids], spk, prio, trg, cd, ttl, resp, once, label}
  V.say = function (id, o) {
    o = o || {};
    if (!V.idx && !V.virtual) return drop("noidx");
    const e = V.idx ? V.idx[id] : null;
    if (!e && !V.virtual) return drop("unknown");
    const it = { id, spk: o.spk || (e && e.s) || "?", prio: o.prio != null ? o.prio : (e ? e.p : 1), trg: o.trg || "plain", cd: o.cd != null ? o.cd : null, ttl: o.ttl, resp: !!o.resp, dur: (e && e.d) || o.dur || 2, parts: null, seqNext: o.seqNext || null, at: now, minDelay: o.delay || 0 };
    return enqueue(it, o);
  };
  V.phrase = function (spk, pre, clk, mod, o) { // "Bandits, ten o'clock, high!"
    o = o || {};
    const num = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"][clk | 0] || "twelve";
    const parts = [spk + "__pre_" + pre, spk + "__clk_" + num, spk + "__mod_" + (mod || "level")];
    let dur = 0.3; if (V.idx) for (const p of parts) dur += ((V.idx[p] && V.idx[p].d) || 0.8) + 0.05;
    const it = { id: "phrase:" + pre + ":" + num + ":" + (mod || "level"), spk, prio: o.prio != null ? o.prio : 2, trg: o.trg || "bandit", cd: o.cd, ttl: o.ttl, resp: false, dur, parts, at: now, minDelay: 0, phraseKey: pre + num + mod };
    return enqueue(it, o);
  };
  function enqueue(it, o) {
    if (!V.enabled) return drop("off");
    if (V.silenced && !o.allowSilenced) return drop("silenced");
    if (!speakerOk(it.spk)) return drop("dead:" + it.spk);
    if (o.once) { if (onceDone[o.once]) return drop("once"); }
    if (it.parts == null && lastId[it.id] != null && now - lastId[it.id] < 60 && !o.noIdCd) return drop("idcd");
    if (it.parts != null && lastId[it.id] != null && now - lastId[it.id] < 12) return drop("idcd");
    const tc = it.cd != null ? it.cd : (TRG_CD[it.trg] != null ? TRG_CD[it.trg] : 1);
    if (trgLast[it.trg] != null && now - trgLast[it.trg] < tc && !o.noTrgCd) return drop("trgcd");
    if (it.prio <= 1 && !it.resp && !o.seq) { // chatter: nothing else was said for 6 s, and 20 s since the last chatter
      if (now - lastLoud < 6 || now - lastChatter < 20) return drop("chatter");
    }
    if (queue.some((q) => q.id === it.id)) return drop("dup");
    if (!o.seq && queue.filter((q) => !q.seqItem).length >= 5) { // keep the most important five (scripted sequences — roll call, nav calls — are exempt, they were queued whole)
      queue = queue.filter((q) => q.seqItem).concat(queue.filter((q) => !q.seqItem).sort((a, b) => b.prio - a.prio || a.at - b.at)); const worst = queue[queue.length - 1];
      if (worst.prio >= it.prio) return drop("full"); queue.pop();
    }
    it.ttl = o.ttl != null ? o.ttl : (it.prio >= 3 ? 5 : it.prio === 2 ? 4 : 2.5);
    it.seqItem = !!o.seq; it.once = o.once || null; it.onStart = o.onStart || null; it.cond = o.cond || null;
    if (o.after != null) it.minStart = now + o.after;
    queue.push(it);
    trgLast[it.trg] = now; // the request itself arms the trigger cooldown (a flood of the same event is thinned before it reaches the queue)
    return true;
  }

  // ---- director tick (sim clock) ----
  V.tick = function (t) {
    now = t;
    if (!V.enabled) { if (cur) V.cut(true); queue = []; return; }
    if (cur && now >= cur.end) { log(cur, "done"); lastEnd = now; if (cur.prio >= 3) lastCritEnd = now; duck(false); cur = null; }
    if (!queue.length) return;
    queue = queue.filter((q) => now - Math.max(q.at, q.minStart || 0) <= q.ttl ? true : (drop("expired"), false));
    if (!queue.length) return;
    for (const q of queue) q.ep = Math.min(3, q.prio + (now - Math.max(q.at, q.minStart || 0) > 4 ? 1 : 0)); // 1.6.0: a line that has waited > 4 s moves up one rank (no starvation of the scripted nav / escort calls now that nobody is cut off)
    queue.sort((a, b) => b.ep - a.ep || a.at - b.at);
    let top = null;
    for (let guard = 0; guard < 8 && !top; guard++) {
      const c = queue.find((q) => !q.minStart || now >= q.minStart); if (!c) return;
      if (c.cond && !c.cond()) { queue.splice(queue.indexOf(c), 1); drop("cond"); if (!queue.length) return; continue; }
      top = c;
    }
    if (!top) return;
    if (cur) {
      return; // 1.6.0: nobody is ever cut off mid-line (was: a priority-3 call cut a lower line after 0.25 s, e.g. "Top turret, you with us?"); the urgent call waits in the queue and goes 0.35 s after the line ends (longest non-urgent line 4.1 s < the 5 s urgent ttl)
    }
    const gap = top.resp ? 0.45 : (now - lastCritEnd < 2.0 && lastCritEnd > 0) ? 2.0 : (top.prio <= 1 ? 1.5 : 1.0); // a crew answer (roll call, reply) comes right back
    if (now - lastEnd < gap && !(top.prio >= 3 && now - lastEnd > 0.35)) return;
    queue.splice(queue.indexOf(top), 1);
    play(top);
  };
  function play(it) {
    it.t0 = now; it.end = now + it.dur;
    if (!speakerOk(it.spk)) { drop("dead:" + it.spk); return; }
    if (cur) V.stats.overlaps = (V.stats.overlaps || 0) + 1;
    cur = it; V.stats.said++; lastId[it.id] = now; V.lastT = now;
    if (it.once) onceDone[it.once] = true;
    if (it.prio >= 2) lastLoud = now; if (it.prio <= 1 && !it.resp) lastChatter = now;
    if (it.onStart) { try { it.onStart(it); } catch (e) {} }
    if (V.virtual) return;
    A = A || (window.FGAudio && window.FGAudio.voiceBus ? window.FGAudio.voiceBus() : null);
    if (!A) return;
    duck(true);
    const ids = it.parts || [it.id], want = it;
    Promise.all(ids.map((i) => decode(i))).then((bufs) => {
      if (cur !== want || bufs.some((b) => !b)) { if (cur === want && bufs.some((b) => !b)) { /* undecodable: free the channel */ want.end = now; } return; }
      try { startAudio(want, bufs); } catch (e) { V.stats.errors++; want.end = now; }
    });
  }
  let noiseBuf = null;
  function startAudio(it, bufs) {
    const ctx = A.ctx, t0 = ctx.currentTime + 0.02, vol = 1.0;
    const out = ctx.createGain(); out.gain.value = vol; out.connect(A.bus); it.gain = out;
    let t = t0;
    if (!it.parts) { const s = ctx.createBufferSource(); s.buffer = bufs[0]; s.connect(out); s.start(t); it.src = s; it.end = now + bufs[0].duration + 0.05; return; }
    // assembled phrase: radio chain = HP 340 → LP 3000 → presence +6 dB @1.5 kHz → tanh drive → squelch click, hiss bed, close tail (same recipe as proc.py, "urgent" style)
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 340; hp.Q.value = 0.7;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 3000; lp.Q.value = 0.7;
    const pk = ctx.createBiquadFilter(); pk.type = "peaking"; pk.frequency.value = 1500; pk.Q.value = 0.9; pk.gain.value = 6;
    const ws = ctx.createWaveShaper(); { const n = 1024, c = new Float32Array(n); for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(3 * x * 1.8) / Math.tanh(3 * 0.9) * 0.5; } ws.curve = c; }
    const pre = ctx.createGain(); pre.gain.value = 1;
    pre.connect(hp); hp.connect(lp); lp.connect(pk); pk.connect(ws); ws.connect(out);
    if (!noiseBuf || noiseBuf.sampleRate !== ctx.sampleRate) { noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.0), ctx.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    const burst = (at, len, f0, f1, g, tau) => { const s = ctx.createBufferSource(); s.buffer = noiseBuf; const b = ctx.createBiquadFilter(); b.type = "bandpass"; b.frequency.value = Math.sqrt(f0 * f1); b.Q.value = Math.sqrt(f0 * f1) / (f1 - f0); const e = ctx.createGain(); e.gain.setValueAtTime(g, at); e.gain.setTargetAtTime(0.0001, at, tau); s.connect(b); b.connect(e); e.connect(out); s.start(at, Math.random() * 0.5); s.stop(at + len); };
    burst(t, 0.02, 600, 3000, 0.16, 0.003); // squelch open
    t += 0.14;
    let tot = 0;
    for (const b of bufs) { // RMS-normalise each bare piece to the processed lines' level
      const d = b.getChannelData(0); let s2 = 0; for (let i = 0; i < d.length; i += 3) s2 += d[i] * d[i]; const rms = Math.sqrt(s2 / (d.length / 3)) || 0.05;
      const s = ctx.createBufferSource(); s.buffer = b; const g = ctx.createGain(); g.gain.value = Math.min(6, 0.12 / rms); s.connect(g); g.connect(pre); s.start(t); t += b.duration + 0.05; tot += b.duration + 0.05; if (!it.src) it.src = s;
    }
    const hs = ctx.createBufferSource(); hs.buffer = noiseBuf; hs.loop = true; const hb = ctx.createBiquadFilter(); hb.type = "bandpass"; hb.frequency.value = 1000; hb.Q.value = 0.5; const hg = ctx.createGain(); hg.gain.value = 0.006; hs.connect(hb); hb.connect(hg); hg.connect(out); hs.start(t0); hs.stop(t + 0.1);
    burst(t, 0.12, 500, 3000, 0.12, 0.03); // squelch tail
    it.end = now + (t - t0) + 0.15;
  }
  V.state = () => ({ cur: cur ? { id: cur.id, prio: cur.prio, spk: cur.spk, t0: cur.t0, end: cur.end } : null, queue: queue.map((q) => ({ id: q.id, prio: q.prio })), enabled: V.enabled, ready: V.ready, failed: V.failed, silenced: V.silenced, cacheSecs: +cacheSecs.toFixed(1) });
  V.markOnce = (k) => { if (onceDone[k]) return false; onceDone[k] = true; return true; };
  V.speaking = () => !!cur;
  window.FGVoice = V;
})();
