/* Fortress Gunner 1.5.7 — every NON-player machine gun (box gunners, P-51 six-.50, German MG 131/151, distant chute-bed fire) is now the player's own per-round sample, delayed by distance / speed of sound,
 * low-passed to a muffled 500–1200 Hz, ~-27…-45 dB below the player's gun, inaudible past 2600 u, thinned (random skips, min spacing) and capped at 6 concurrent voices. (1.5.6 header follows.)
 * Fortress Gunner 1.5.6 — gun sound rebuilt against a real M60 reference (sample-led round: crack + body + chest thump + outdoor echo; steady belt cadence; one trigger-release end sound per release);
 * ear-ring only on a direct flak hit (once per run, ~10 s: whine + muffle easing back). (1.5.4 header follows.) Fortress Gunner 1.5.4 — procedural WebAudio sound design + a tiny rendered sample layer (.50 bark, flak thump; synthesised once at unlock, ~0.3 MB).
 * 1.5.4: speed-of-sound delay + 1/(1+d/ref) gain + air-absorption low-pass for every distant source; noise-based engines (no tonal drone); phone-speaker EQ;
 * wind-through-holes bed that scales with the hole count; noise-based radio intercom (no beeps).
 * (Original 1.3.8 header follows.) Fortress Gunner 1.3.8 — procedural WebAudio sound design (no samples).
 * Everything is synthesized: 4 Wright R-1820 radials (detuned sawtooth drone + firing-rate buzz),
 * wind rush, .50 cal shots (ours close, the box's attenuated/panned by distance and direction),
 * hits on our airframe (metal tinks, 20 mm thumps), engine sputter / wind-down, 109 fly-bys with
 * doppler, 109 cannon/MG bursts, flak crumps, explosions. A soft master chain (lowpass + compressor)
 * keeps the mix non-fatiguing. Works in Android WebView; unlocked on the first touch.
 * API: FGAudio.unlock(), .frame(state), .gun(x,y,z,own), .hitOwn(kind), .enemyGun(x,y,z), .boom(x,y,z,big),
 *      .flak(x,y,z), .renderSample(sec) → Promise<AudioBuffer> (offline demo mix), .stats
 * 1.3.8: shot down — .fallStart(cause) (rising wind + falling howl), .bell() (bail-out alarm), .bail() (whoosh,
 *      engines gone, quiet chute bed), .chuteOpen() (canopy crack), .mute(b), .results(), .reset();
 *      close flak → shrapnel rattle (.hitOwn("flak")); distant guns / box drone fade under the chute. */
(function () {
  "use strict";
  const AC = window.AudioContext || window.webkitAudioContext;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const stats = { built: false, unlocked: false, errors: 0, events: {}, ringsThisRun: 0, ringsTotal: 0, ringTries: 0 };
  const count = (k) => { stats.events[k] = (stats.events[k] || 0) + 1; };

  // ---------- 1.5.4 distance model: speed of sound, spreading loss, air absorption ----------
  // Scale: VF 83.4 u/s = 280 mph (125 m/s) → 1 u ≈ 1.5 m, so sound travels 343 / 1.5 = 228.7 u/s (1000 u ≈ 4.4 s; the delay is capped at 3.5 s so a far burst is never lost).
  const TAME_F = 6200;
  const M_PER_U = 1.5, U_PER_S = 343 / M_PER_U, DELAY_CAP = 3.5;
  function distModel(d, ref) { return { d, delay: Math.min(DELAY_CAP, d / U_PER_S), gain: 1 / (1 + d / ref), lp: 450 + 9500 * Math.exp(-d / 1800) }; }
  let DM = null; // the model in force while a distant voice is being scheduled: out() applies its gain and air-absorption low-pass to every node
  function withDM(d, ref, fn) { DM = distModel(d, ref); try { fn(DM); } finally { DM = null; } return distModel(d, ref); }

  // ---------- graph (shared by the live context and the offline demo render) ----------
  function makeNoise(ctx, sec) {
    const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * sec), ctx.sampleRate);
    const d = b.getChannelData(0); let last = 0;
    for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; last = last * 0.02 + w * 0.98; d[i] = last; }
    return b;
  }
  function Graph(ctx) {
    const G = { ctx };
    G.master = ctx.createGain(); G.master.gain.value = 0.0001;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 10; comp.ratio.value = 5; comp.attack.value = 0.004; comp.release.value = 0.25;
    const tame = ctx.createBiquadFilter(); tame.type = "lowpass"; tame.frequency.value = TAME_F; tame.Q.value = 0.5; // no ice-pick highs
    // 1.5.4 phone-speaker EQ: a phone driver gives nothing below ~150 Hz (sub energy only eats headroom and trips the limiter) → high-pass ~100 Hz (2 stages), tame the 130–250 Hz boom,
    // and push the body that a small speaker CAN play: +3 dB at 700 Hz (chest of the .50 bark), +3 dB at 2.3 kHz (crack / presence).
    const eq1 = ctx.createBiquadFilter(); eq1.type = "highpass"; eq1.frequency.value = 105; eq1.Q.value = 0.7; const eq0 = ctx.createBiquadFilter(); eq0.type = "highpass"; eq0.frequency.value = 85; eq0.Q.value = 0.6; // cascaded: ~4th order below ~100 Hz
    const eq2 = ctx.createBiquadFilter(); eq2.type = "peaking"; eq2.frequency.value = 170; eq2.Q.value = 0.8; eq2.gain.value = -3.5;
    const eq3 = ctx.createBiquadFilter(); eq3.type = "peaking"; eq3.frequency.value = 520; eq3.Q.value = 0.7; eq3.gain.value = 4.2;
    const eq4 = ctx.createBiquadFilter(); eq4.type = "peaking"; eq4.frequency.value = 2300; eq4.Q.value = 0.9; eq4.gain.value = 0.8;
    const sat = ctx.createWaveShaper(); { const n = 2048, c = new Float32Array(n); for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(1.5 * x) / Math.tanh(1.5) * 0.94; } sat.curve = c; } // 1.5.3: soft ceiling at -0.5 dBFS, never hard-clips
    // 1.6.0: duck bus — engines/guns/everything dips ~6 dB under a crew voice (voice.js)
    G.duckG = ctx.createGain(); G.duckG.gain.value = 1; G.master.connect(G.duckG); G.duckG.connect(eq0); eq0.connect(eq1); eq1.connect(eq2); eq2.connect(eq3); eq3.connect(eq4); eq4.connect(tame); tame.connect(comp); G.comp = comp; comp.connect(sat); sat.connect(ctx.destination); G.sat = sat; G.tame = tame; G.vox = []; G.eq = [eq1, eq2, eq3, eq4];
    G.noise = makeNoise(ctx, 2.0);
    G.sfx = ctx.createGain(); G.sfx.gain.value = 1.5; G.sfx.connect(G.master);
    // --- 1.5.4 engines: 4 R-1820 radials as NOISE (no tonal drone). Each = a low rumble band chopped at the prop's blade-passing rate (~66 Hz, 4 engines slowly beating)
    //     + a mid "growl" band (250–900 Hz) chopped at the cylinder firing rate (~172 Hz) with a slow random wander → throb and roar, no 46 Hz hum.
    G.eng = [];
    const busE = ctx.createGain(); busE.gain.value = 0.24;
    const eHP = ctx.createBiquadFilter(); eHP.type = "highpass"; eHP.frequency.value = 55; eHP.Q.value = 0.6;
    const eLP = ctx.createBiquadFilter(); eLP.type = "lowpass"; eLP.frequency.value = 900; eLP.Q.value = 0.6;
    busE.connect(eHP); eHP.connect(eLP); eLP.connect(G.master);
    const pans = [-0.55, -0.25, 0.25, 0.55];
    for (let i = 0; i < 4; i++) {
      const f0 = 66 + i * 0.83 + (i === 2 ? 0.4 : 0);
      const g = ctx.createGain(); g.gain.value = 0.25;
      const n1 = ctx.createBufferSource(); n1.buffer = G.noise; n1.loop = true; n1.playbackRate.value = 0.9 + i * 0.05;
      const b1 = ctx.createBiquadFilter(); b1.type = "bandpass"; b1.frequency.value = 135 + i * 11; b1.Q.value = 0.75;
      const a1 = ctx.createGain(); a1.gain.value = 0.62;
      const saw = ctx.createOscillator(); saw.type = "triangle"; saw.frequency.value = f0; const sg = ctx.createGain(); sg.gain.value = 0.34; saw.connect(sg); sg.connect(a1.gain); // blade-passing chop
      n1.connect(b1); b1.connect(a1); a1.connect(g);
      const n2 = ctx.createBufferSource(); n2.buffer = G.noise; n2.loop = true; n2.playbackRate.value = 1.0 + i * 0.07;
      const b2 = ctx.createBiquadFilter(); b2.type = "bandpass"; b2.frequency.value = 420 + i * 38; b2.Q.value = 0.9;
      const a2 = ctx.createGain(); a2.gain.value = 0.34;
      const buzz = ctx.createOscillator(); buzz.type = "sawtooth"; buzz.frequency.value = f0 * 2.62; const bz = ctx.createGain(); bz.gain.value = 0.2; buzz.connect(bz); bz.connect(a2.gain); // cylinder firing chop
      n2.connect(b2); b2.connect(a2); a2.connect(g);
      const wob = ctx.createOscillator(); wob.frequency.value = 0.17 + i * 0.043; const wg = ctx.createGain(); wg.gain.value = 1.3; wob.connect(wg); wg.connect(saw.frequency); wg.connect(buzz.frequency); // slow wander: never a fixed tone
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (pan) { pan.pan.value = pans[i]; g.connect(pan); pan.connect(busE); } else g.connect(busE);
      n1.start(0, i * 0.37); n2.start(0, 0.8 + i * 0.29); saw.start(); buzz.start(); wob.start();
      G.eng.push({ saw, buzz, g, f0, kb: 2.62, state: "run", sput: 0, level: 0.25 });
    }
    // --- wind rush + airframe rumble (looped noise, band-limited)
    const wn = ctx.createBufferSource(); wn.buffer = G.noise; wn.loop = true;
    const wbp = ctx.createBiquadFilter(); wbp.type = "bandpass"; wbp.frequency.value = 600; wbp.Q.value = 0.8;
    const wg = ctx.createGain(); wg.gain.value = 0.045;
    const wlfo = ctx.createOscillator(); wlfo.frequency.value = 0.13; const wlg = ctx.createGain(); wlg.gain.value = 0.015; wlfo.connect(wlg); wlg.connect(wg.gain); wlfo.start();
    const rlp = ctx.createBiquadFilter(); rlp.type = "lowpass"; rlp.frequency.value = 110; const rg = ctx.createGain(); rg.gain.value = 0.16;
    wn.connect(wbp); wbp.connect(wg); wg.connect(G.master); wn.connect(rlp); rlp.connect(rg); rg.connect(G.master); wn.start();
    G.wind = wg; G.windBP = wbp; G.rumble = rg; G.busE = busE;
    // 1.5.4 wind through the holes: a continuous whistling/roaring bed (noise, 600–2.8 kHz) whose level, pitch and flutter grow with the number of holes shot through the skin
    { const hn = ctx.createBufferSource(); hn.buffer = G.noise; hn.loop = true; hn.playbackRate.value = 1.15;
      const hb = ctx.createBiquadFilter(); hb.type = "bandpass"; hb.frequency.value = 900; hb.Q.value = 0.9;
      const hh = ctx.createBiquadFilter(); hh.type = "highpass"; hh.frequency.value = 450;
      const hg = ctx.createGain(); hg.gain.value = 0;
      const fl = ctx.createOscillator(); fl.type = "sine"; fl.frequency.value = 5.3; const fg = ctx.createGain(); fg.gain.value = 0; fl.connect(fg); fg.connect(hg.gain);
      const fl2 = ctx.createOscillator(); fl2.type = "sine"; fl2.frequency.value = 0.37; const fg2 = ctx.createGain(); fg2.gain.value = 250; fl2.connect(fg2); fg2.connect(hb.frequency);
      hn.connect(hb); hb.connect(hh); hh.connect(hg); hg.connect(G.master); hn.start(0, 0.5); fl.start(); fl2.start();
      G.holeWind = hg; G.holeFlutter = fg; G.holeBP = hb; }
    // 1.3.8: chute bed (low wind with canopy flutter) + the box's distant drone, both silent until bail-out
    const cn = ctx.createBufferSource(); cn.buffer = G.noise; cn.loop = true; cn.playbackRate.value = 0.7;
    const cbp = ctx.createBiquadFilter(); cbp.type = "bandpass"; cbp.frequency.value = 320; cbp.Q.value = 0.6;
    const cg = ctx.createGain(); cg.gain.value = 0;
    const flap = ctx.createOscillator(); flap.frequency.value = 2.6; const flg = ctx.createGain(); flg.gain.value = 0; flap.connect(flg); flg.connect(cg.gain); flap.start();
    cn.connect(cbp); cbp.connect(cg); cg.connect(G.master); cn.start();
    G.chute = cg; G.chuteFlap = flg;
    const dg = ctx.createGain(); dg.gain.value = 0; const dlp = ctx.createBiquadFilter(); dlp.type = "lowpass"; dlp.frequency.value = 180;
    { const dn = ctx.createBufferSource(); dn.buffer = G.noise; dn.loop = true; dn.playbackRate.value = 0.8; const dbp = ctx.createBiquadFilter(); dbp.type = "bandpass"; dbp.frequency.value = 150; dbp.Q.value = 0.8;
      const dam = ctx.createGain(); dam.gain.value = 1.4; const dosc = ctx.createOscillator(); dosc.type = "triangle"; dosc.frequency.value = 66.7; const dog = ctx.createGain(); dog.gain.value = 0.5; dosc.connect(dog); dog.connect(dam.gain); dn.connect(dbp); dbp.connect(dam); dam.connect(dlp); dn.start(); dosc.start(); }
    dlp.connect(dg); dg.connect(G.master);
    G.distDrone = dg;
    try { G.smp = makeSmp(ctx); } catch (e) { stats.errors++; stats.lastError = String(e); G.smp = null; }
    stats.built = true;
    return G;
  }

  // ---------- 1.5.4 RENDERED SAMPLE LAYER (synthesised once; played back with pitch/level jitter under the synth) ----------
  // .50 bark: a 3 ms muzzle crack + resonant body (chest 650 Hz / throat 1.4 kHz / action clank 2.4 kHz) + a dropping 150→55 Hz thump + a short turret-cabin tail.
  // flak thump: a 90→32 Hz sweep, a 250–900 Hz "crump" body and a decaying gravel tail — mid-weighted so a phone speaker can actually play it.
  let SMP_CACHE = null;
  function biquadBP(f, q, sr) { const w = 2 * Math.PI * f / sr, al = Math.sin(w) / (2 * q), a0 = 1 + al; return { b0: al / a0, b1: 0, b2: -al / a0, a1: -2 * Math.cos(w) / a0, a2: (1 - al) / a0, x1: 0, x2: 0, y1: 0, y2: 0 }; }
  function biquadLP(f, q, sr) { const w = 2 * Math.PI * f / sr, al = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + al; return { b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0, a1: -2 * c / a0, a2: (1 - al) / a0, x1: 0, x2: 0, y1: 0, y2: 0 }; }
  function bq(F, x) { const y = F.b0 * x + F.b1 * F.x1 + F.b2 * F.x2 - F.a1 * F.y1 - F.a2 * F.y2; F.x2 = F.x1; F.x1 = x; F.y2 = F.y1; F.y1 = y; return y; }
  function buildSamples() {
    if (SMP_CACHE) return SMP_CACHE;
    const sr = 44100, bark = [], flak = [];
    // 1.5.6 .50 / MG round, matched to a real M60 reference burst (fg_157): a sharp broadband crack (<2 ms) + a 2–5 kHz snap + a punchy 300–1.6 kHz body (~30 ms) + a 150→90 Hz chest thump
    // + a dense "outdoor" tail (low-passed noise ~110 ms with 3 reflection taps at 20–90 ms: the neighbouring ships / ground) — so each round is a gunshot with an echo, not a noise tick.
    for (let v = 0; v < 8; v++) {
      const n = Math.floor(sr * 0.5), d = new Float32Array(n), r = (a, b) => a + Math.random() * (b - a);
      const fE = biquadBP(r(280, 400), 0.9, sr), fA = biquadBP(r(560, 760), 1.1, sr), fB = biquadBP(r(1150, 1600), 1.0, sr), fC = biquadBP(r(2400, 3300), 0.9, sr), fD = biquadBP(r(4800, 6000), 0.8, sr);
      const lpT = biquadLP(r(1300, 1900), 0.7, sr), fT = biquadBP(r(700, 1000), 0.6, sr);
      const taps = [r(0.02, 0.034), r(0.04, 0.06), r(0.065, 0.09)].map((t, i) => ({ i: Math.floor(t * sr), a: r(0.16, 0.28) * (1 - 0.25 * i), f: biquadBP(r(600, 1500), 0.8, sr) }));
      const f0 = r(150, 185), f1 = r(85, 100); let hp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr, w = Math.random() * 2 - 1;
        let x = w * Math.exp(-t / 0.0010) * 0.85;
        x += bq(fC, w) * Math.exp(-t / 0.014) * 1.55 + bq(fD, w) * Math.exp(-t / 0.02) * 0.72;
        x += bq(fB, w) * Math.exp(-t / 0.019) * 1.4 + bq(fA, w) * Math.exp(-t / 0.030) * 1.9 + bq(fE, w) * Math.exp(-t / 0.042) * 1.1;
        x += Math.sin(2 * Math.PI * (f1 * t + (f0 - f1) * 0.028 * (1 - Math.exp(-t / 0.028)))) * Math.exp(-t / 0.032) * 0.34;
        x += bq(lpT, bq(fT, w)) * Math.exp(-t / 0.105) * 1.1;
        for (const tp of taps) if (i >= tp.i) { const k = (i - tp.i) / sr; x += bq(tp.f, w) * tp.a * Math.exp(-k / 0.018) * 1.2; }
        const y = Math.tanh(1.5 * x); d[i] = y - hp; hp += (y - hp) * 0.004; // soft clip, then a slow DC-kill
      }
      // 4 ms fade-out at the very end so the buffer never ends on a click
      for (let i = n - 180; i < n; i++) d[i] *= (n - i) / 180;
      let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(d[i])); for (let i = 0; i < n; i++) d[i] /= pk * 1.05;
      bark.push(d);
    }
    for (let v = 0; v < 4; v++) {
      const n = Math.floor(sr * 1.5), d = new Float32Array(n), r = (a, b) => a + Math.random() * (b - a);
      const fb = biquadBP(r(380, 560), 0.9, sr), fm = biquadBP(r(750, 1000), 0.8, sr), lp = biquadLP(r(240, 330), 0.7, sr), lg = biquadLP(r(500, 760), 0.8, sr);
      const f0 = r(80, 100), f1 = r(30, 38);
      for (let i = 0; i < n; i++) {
        const t = i / sr, w = Math.random() * 2 - 1;
        const rise = 1 - Math.exp(-t / 0.012);
        const sub = Math.sin(2 * Math.PI * (f1 * t + (f0 - f1) * 0.28 * (1 - Math.exp(-t / 0.28)))) * Math.exp(-t / 0.4) * 0.8;
        const crump = bq(fb, w) * Math.exp(-t / 0.2) * 2.1 + bq(fm, w) * Math.exp(-t / 0.11) * 1.4;
        const crack = w * Math.exp(-t / 0.004) * 0.7;
        const gravel = bq(lg, w) * Math.exp(-t / 0.5) * (0.5 + 0.5 * Math.sin(t * 38 + Math.sin(t * 7) * 2)) * 0.7;
        const rum = bq(lp, w) * Math.exp(-t / 0.6) * 1.1;
        d[i] = (sub * 0.9 + crump + crack + gravel + rum) * rise;
      }
      let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(d[i])); for (let i = 0; i < n; i++) d[i] = Math.tanh(1.2 * d[i] / pk) * 0.92;
      flak.push(d);
    }
    SMP_CACHE = { bark, flak, sr };
    return SMP_CACHE;
  }
  function makeSmp(ctx) {
    const S = buildSamples(), mk = (a) => { const b = ctx.createBuffer(1, a.length, S.sr); b.getChannelData(0).set(a); return b; };
    return { bark: S.bark.map(mk), flak: S.flak.map(mk) };
  }
  function playSample(G, buf, t, gain, pan, rate) {
    const ctx = G.ctx, s = ctx.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate || 1;
    s.connect(out(G, t, gain, pan, 9000)); s.start(t);
  }
  // one-shot helpers --------------------------------------------------------------------------
  function out(G, t, gain, pan, lp) { // voice output chain: gain → (lowpass) → pan → sfx
    const ctx = G.ctx, g = ctx.createGain();
    if (DM) { gain *= DM.gain; lp = lp ? Math.min(lp, DM.lp) : DM.lp; }
    g.gain.value = gain;
    let node = g;
    if (lp) { const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = lp; g.connect(f); node = f; }
    if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan || 0)); node.connect(p); p.connect(G.sfx); }
    else node.connect(G.sfx);
    return g;
  }
  function noiseHit(G, t, dur, f, q, gain, pan, lp, attack) {
    const ctx = G.ctx, s = ctx.createBufferSource(); s.buffer = G.noise; s.playbackRate.value = 0.9 + Math.random() * 0.2;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = f; bp.Q.value = q;
    const e = ctx.createGain(); e.gain.setValueAtTime(0.0001, t); e.gain.exponentialRampToValueAtTime(1, t + (attack || 0.002)); e.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(bp); bp.connect(e); e.connect(out(G, t, gain, pan, lp));
    s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.05);
  }
  function thump(G, t, f0, f1, dur, gain, pan, lp) {
    const ctx = G.ctx, o = ctx.createOscillator(); o.type = "sine";
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const e = ctx.createGain(); e.gain.setValueAtTime(0.0001, t); e.gain.exponentialRampToValueAtTime(1, t + 0.004); e.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(e); e.connect(out(G, t, gain, pan, lp)); o.start(t); o.stop(t + dur + 0.05);
  }
  function tink(G, t, gain, pan) { // small-calibre strike on aluminium: inharmonic ring + click
    const ctx = G.ctx, base = 1900 + Math.random() * 1400;
    for (const m of [1, 1.51, 2.37]) {
      const o = ctx.createOscillator(); o.type = "sine"; o.frequency.setValueAtTime(base * m * 1.015, t); o.frequency.exponentialRampToValueAtTime(base * m, t + 0.025);
      const e = ctx.createGain(); e.gain.setValueAtTime(0.0001, t); e.gain.exponentialRampToValueAtTime(0.5 / m, t + 0.002); e.gain.exponentialRampToValueAtTime(0.0001, t + 0.09 + 0.05 / m);
      o.connect(e); e.connect(out(G, t, gain, pan)); o.start(t); o.stop(t + 0.2);
    }
    noiseHit(G, t, 0.03, 3500, 1.2, gain * 0.9, pan);
  }
  // sound events --------------------------------------------------------------------------------
  // 1.4.0: every round a little different (pitch, length, level), box gunners duller and further off
  // (heavier low-pass, a late soft "slap" echo off the neighbouring ships), our own rounds + brass clinks.
  let lastBark = -1;
  function pickBark(G) { const n = G.smp.bark.length; let k = (Math.random() * n) | 0; if (k === lastBark) k = (k + 1 + ((Math.random() * (n - 1)) | 0)) % n; lastBark = k; return G.smp.bark[k]; } // never the same take twice in a row
  // ---------- 1.5.7 distant-gun model: the SAME per-round sample as the player's gun (pickBark), nothing else ----------
  // Muffled: two cascaded low-passes (24 dB/oct) at 500–1200 Hz falling with distance, so the crack is gone and only a dull thud-patter remains.
  // Faint: -27 dB re the player's round at 0 u, then 1/(1+d/300) spreading (measured RMS vs the player burst: about -29 dB at 100 u, -33 dB at 500 u, -35 dB at 1500 u); a linear fade to silence between 2000 and 2600 u (inaudible beyond).
  // Not incessant: rounds are thinned (keep probability falls with distance) and rate/voice limited in aiGunAllowed (min spacing, max AI_MAX_VOICES concurrent).
  const AI_MAX_VOICES = 6, AI_VOICE_LEN = 0.45, AI_MIN_GAP = 0.05, AI_CUTOFF = 2600;
  function aiGunGain(d) { return 0.7 * Math.pow(10, -27 / 20) / (1 + d / 300) * Math.max(0, Math.min(1, (AI_CUTOFF - d) / 600)); } // 0.7 = the player's round gain in sGun(own)
  function aiGunLP(d) { return 500 + 700 * Math.exp(-d / 900); }
  function aiGunKeep(d) { return Math.max(0.12, 0.9 * Math.exp(-d / 1400)); }
  const aiVoices = []; let aiLast = -9;
  function aiGunAllowed(t, d) { // live gate: thinning + minimum spacing + concurrent-voice cap
    if (d >= AI_CUTOFF) return false;
    if (Math.random() > aiGunKeep(d)) { stats.aiSkipThin = (stats.aiSkipThin || 0) + 1; return false; }
    if (t - aiLast < AI_MIN_GAP) { stats.aiSkipGap = (stats.aiSkipGap || 0) + 1; return false; }
    let n = 0; for (let i = aiVoices.length - 1; i >= 0; i--) { if (aiVoices[i] < t - 1) aiVoices.splice(i, 1); else if (aiVoices[i] - AI_VOICE_LEN <= t && aiVoices[i] > t) n++; }
    if (n >= AI_MAX_VOICES) { stats.aiSkipCap = (stats.aiSkipCap || 0) + 1; return false; }
    aiVoices.push(t + AI_VOICE_LEN); aiLast = t; stats.aiRounds = (stats.aiRounds || 0) + 1; return true;
  }
  function aiRound(G, t, d, pan) { // one distant round: t already includes the speed-of-sound delay
    const ctx = G.ctx, g = aiGunGain(d); if (g < 0.0004) return;
    if (!G.smp) { const lv = 0.9 + Math.random() * 0.2; noiseHit(G, t, 0.1, 520, 0.7, g * lv * 0.6, pan, aiGunLP(d), 0.004); return; } // no-sample fallback: a dull noise tap
    const s = ctx.createBufferSource(); s.buffer = pickBark(G); s.playbackRate.value = 0.95 + Math.random() * 0.12; // the player's rate jitter
    const lv = ctx.createGain(); lv.gain.value = g * (0.88 + Math.random() * 0.24);
    const f1 = ctx.createBiquadFilter(), f2 = ctx.createBiquadFilter(); f1.type = f2.type = "lowpass"; f1.frequency.value = f2.frequency.value = aiGunLP(d); f1.Q.value = f2.Q.value = 0.55;
    s.connect(lv); lv.connect(f1); f1.connect(f2);
    if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan || 0)) * 0.8; f2.connect(p); p.connect(G.sfx); } else f2.connect(G.sfx);
    s.start(t); s.stop(t + 0.5);
  }
  function sGun(G, t, dist, pan, own) { // one .50 cal round (1.5.6: sample-led — real crack + body + chest thump + outdoor tail, each take different; the 1.5.3 noise-burst synth is the no-sample fallback)
    const v = 0.88 + Math.random() * 0.24, lv = 0.88 + Math.random() * 0.24;
    if (G.smp) {
      if (own) {
        playSample(G, pickBark(G), t, 0.7 * lv, pan, 0.95 + Math.random() * 0.12);
        thump(G, t, 150 * v, 62, 0.07, 0.05 * lv, pan, 1800);
        return;
      }
      aiRound(G, t, dist, pan); // 1.5.7: every non-player MG round = the player's sample through the distant-gun model
      return;
    }
    if (own) {
      noiseHit(G, t, 0.07 + Math.random() * 0.03, 620 * v, 0.8, 0.72 * lv, pan, 3200, 0.002);
      noiseHit(G, t, 0.045, 1250 * v, 0.8, 0.34 * lv, pan, 5000, 0.001);
      noiseHit(G, t, 0.018, 2200 * v, 0.7, 0.09 * lv, pan, 5200, 0.0006);
      thump(G, t, 125 * v, 48, 0.085, 0.12 * lv, pan, 5000);
      return;
    }
    const near = DM ? 1 : 1 / (1 + dist / 55);
    const lp = DM ? 9000 : Math.max(500, 2800 - dist * 4.5);
    noiseHit(G, t, 0.1 + Math.random() * 0.05, 640 * v, 0.7, 0.8 * near * lv, pan, lp, 0.004);
    noiseHit(G, t, 0.05, 1300 * v, 0.7, 0.3 * near * lv, pan, lp, 0.002);
    thump(G, t, 105 * v, 42, 0.12, 0.12 * near * lv, pan, lp * 0.7);
    if (dist > 60) noiseHit(G, t + 0.07 + dist / 3000, 0.16, 420, 0.6, 0.12 * near, -pan * 0.5, 900, 0.02);
  }
  // 1.5.6 gun end sound — what you hear when you let go of the trigger: the last round's echo rolling off the neighbouring ships and the ground, a low settle, and the ringing in the cabin dying away (~1.1 s).
  // Starts 2 ms after its anchor with a 4 ms fade-in and ends on an exponential fade to silence (no click); the last shot's own tail keeps playing underneath.
  function sGunEnd(G, t, own) {
    const ctx = G.ctx, k = own ? 1 : 0.7;
    for (const [dt, f, q, dur, gain, lp] of [[0.004, 520, 0.55, 1.15, 0.30, 1500], [0.004, 1500, 0.7, 0.55, 0.12, 3200], [0.012, 240, 0.7, 0.8, 0.14, 700]]) {
      const s = ctx.createBufferSource(); s.buffer = G.noise; s.playbackRate.value = 0.9 + Math.random() * 0.2;
      const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = f; bp.Q.value = q;
      const e = ctx.createGain(), t0 = t + dt;
      e.gain.setValueAtTime(0, t0); e.gain.linearRampToValueAtTime(1, t0 + 0.004); e.gain.setTargetAtTime(0.0001, t0 + 0.02, dur / 4.6); e.gain.linearRampToValueAtTime(0, t0 + dur + 0.25);
      s.connect(bp); bp.connect(e); e.connect(out(G, t0, gain * k, 0, lp)); s.start(t0, Math.random() * 1.2); s.stop(t0 + dur + 0.3);
    }
    for (const [dt, a, f] of [[0.075, 0.12, 900], [0.17, 0.08, 700], [0.31, 0.05, 550]]) noiseHit(G, t + dt, 0.12, f, 0.7, a * k, (Math.random() - 0.5) * 0.5, 2000, 0.01); // slap echoes
    thump(G, t + 0.01, 110, 55, 0.18, 0.05 * k, 0, 900); // settle
  }
  function sBrass(G, t, pan) { // spent .50 cases rattling off the turret floor / ring
    const ctx = G.ctx, n = 1 + ((Math.random() * 2) | 0);
    for (let k = 0; k < n; k++) {
      const tt = t + k * (0.04 + Math.random() * 0.06), base = 2600 + Math.random() * 1800;
      for (const m of [1, 2.76]) {
        const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = base * m;
        const e = ctx.createGain(); e.gain.setValueAtTime(0.0001, tt); e.gain.exponentialRampToValueAtTime(0.4 / m, tt + 0.002); e.gain.exponentialRampToValueAtTime(0.0001, tt + 0.07);
        o.connect(e); e.connect(out(G, tt, 0.05 + Math.random() * 0.04, pan + (Math.random() - 0.5) * 0.3, 7000)); o.start(tt); o.stop(tt + 0.12);
      }
    }
  }
  function sHitThump(G, t) { // our rounds striking a 109: a dull distant "tock" under the tink
    thump(G, t, 180 + Math.random() * 60, 70, 0.08, 0.22, (Math.random() - 0.5) * 0.3, 1400);
    noiseHit(G, t, 0.05, 900, 0.9, 0.12, 0, 2200);
  }
  function sEnemyGun(G, t, dist, pan, live) { // 1.5.7: German MG 131 / MG 151 fire = the player's round sample, 3 rounds at the belt cadence (live: each passes the thinning/voice gate)
    for (let k = 0; k < 3; k++) { const tt = t + k * 0.062 + (Math.random() - 0.5) * 0.004; if (live && !aiGunAllowed(tt, dist)) continue; aiRound(G, tt, dist, pan); }
  }
  // 1.4.1: rounds hitting OUR ship — sharp metallic cracks, tearing aluminium, a debris rattle and a low thud through
  // the airframe; every hit different (which layers, pitch, length, pan). 1.4.0 was two polite tinks.
  function crack(G, t, gain, pan, f) { // the hard strike: a very short broadband snap + a low inharmonic clang
    noiseHit(G, t, 0.018 + Math.random() * 0.02, f || (3200 + Math.random() * 2200), 0.7, gain, pan, 7000, 0.0008);
    const ctx = G.ctx, base = 700 + Math.random() * 900;
    for (const [m, a] of [[1, 0.55], [2.76, 0.3], [5.4, 0.18], [8.93, 0.08]]) {
      const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = base * m * (0.98 + Math.random() * 0.04);
      const e = ctx.createGain(); const dur = 0.08 + Math.random() * 0.16 + 0.12 / m;
      e.gain.setValueAtTime(0.0001, t); e.gain.exponentialRampToValueAtTime(a, t + 0.0015); e.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(e); e.connect(out(G, t, gain * 0.55, pan, 6500)); o.start(t); o.stop(t + dur + 0.02);
    }
  }
  function tear(G, t, dur, gain, pan) { // aluminium skin ripping: a resonant noise band sliding down, chopped into a crackle
    const ctx = G.ctx, s = ctx.createBufferSource(); s.buffer = G.noise; s.playbackRate.value = 0.8 + Math.random() * 0.4;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 4 + Math.random() * 4;
    const f0 = 1800 + Math.random() * 1600; bp.frequency.setValueAtTime(f0, t); bp.frequency.exponentialRampToValueAtTime(f0 * (0.25 + Math.random() * 0.2), t + dur);
    const e = ctx.createGain(); e.gain.setValueAtTime(0.0001, t); e.gain.exponentialRampToValueAtTime(1, t + 0.012); e.gain.setValueAtTime(0.8, t + dur * 0.6); e.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const chop = ctx.createGain(); chop.gain.value = 0.5; const lfo = ctx.createOscillator(); lfo.type = "square"; lfo.frequency.value = 28 + Math.random() * 40; const lg = ctx.createGain(); lg.gain.value = 0.5; lfo.connect(lg); lg.connect(chop.gain);
    s.connect(bp); bp.connect(chop); chop.connect(e); e.connect(out(G, t, gain, pan, 6000));
    s.start(t, Math.random() * 1.2); s.stop(t + dur + 0.05); lfo.start(t); lfo.stop(t + dur + 0.05);
  }
  function rattle(G, t, n, gain, pan, spread) { // bits of airframe, rivets and fragments rattling about
    for (let k = 0; k < n; k++) {
      const tt = t + Math.pow(Math.random(), 1.6) * spread, g = gain * (1 - (tt - t) / (spread * 1.3));
      if (Math.random() < 0.7) tink(G, tt, g * (0.4 + Math.random() * 0.6), pan + (Math.random() - 0.5) * 0.9);
      else noiseHit(G, tt, 0.012 + Math.random() * 0.02, 1500 + Math.random() * 3000, 1.5, g * 0.6, pan + (Math.random() - 0.5) * 0.9, 6000);
    }
  }
  function sHitOwn(G, t, kind) {
    if (kind === "flak") { // shrapnel rattling across the skin: a hard crack + a spray of tinks
      thump(G, t, 85, 30, 0.3, 0.75, (Math.random() - 0.5) * 0.5, 1200);
      crack(G, t, 0.6, 0, 3000);
      if (Math.random() < 0.6) tear(G, t + 0.02, 0.25 + Math.random() * 0.2, 0.3, (Math.random() - 0.5) * 0.8);
      rattle(G, t + 0.01, 10 + ((Math.random() * 7) | 0), 0.45, (Math.random() - 0.5) * 0.6, 0.4);
      return;
    }
    const heavy = kind === "cannon" || kind === "engine", pan = (Math.random() - 0.5) * 1.1;
    const v = 0.8 + Math.random() * 0.4;
    crack(G, t, (heavy ? 0.95 : kind === "self" ? 0.6 : 0.75) * v, pan);
    if (Math.random() < 0.45) crack(G, t + 0.025 + Math.random() * 0.06, 0.5 * v, pan + (Math.random() - 0.5) * 0.4); // a second round
    thump(G, t + 0.004, (heavy ? 70 : 95) * (0.85 + Math.random() * 0.3), 28, heavy ? 0.34 : 0.18, (heavy ? 0.95 : 0.55) * v, pan * 0.5, 700); // through the airframe
    if (heavy) noiseHit(G, t, 0.28, 420, 0.6, 0.55, pan * 0.6, 1600, 0.004); // the 20 mm shell going off
    if (heavy || Math.random() < 0.5) tear(G, t + 0.015 + Math.random() * 0.03, (heavy ? 0.35 : 0.16) + Math.random() * 0.22, (heavy ? 0.45 : 0.28) * v, pan);
    if (heavy || Math.random() < 0.65) rattle(G, t + 0.03, heavy ? 8 + ((Math.random() * 6) | 0) : 3 + ((Math.random() * 4) | 0), heavy ? 0.4 : 0.28, pan, heavy ? 0.55 : 0.3);
  }

  // ===== 1.5.3 HIT / FLAK / STRUCTURE SOUNDS (reworked; tuned against two reference clips of show flak audio, see ITERATION_LOG) =====
  // Phone-cheap: every effect is a handful of oscillators + filtered noise bursts; a voice budget (room()) drops the
  // lowest-value layers when too many are alive at once, so a long strafing burst or a flak barrage never piles up.
  const VOX_CAP = 36;
  function room(G, t, cost, dur) { // reserve `cost` voices for `dur` s starting at t; false if over the cap
    const v = G.vox; for (let i = v.length - 1; i >= 0; i--) if (v[i][0] < t - 0.02) v.splice(i, 1);
    let n = 0; for (const q of v) if (q[1] <= t + 0.05) n += q[2];
    if (n + cost > VOX_CAP) return false;
    v.push([t + dur, t, cost]); return true;
  }
  function env(G, t, a, peak, dur) { const e = G.ctx.createGain(); e.gain.setValueAtTime(0.0001, t); e.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a); e.gain.exponentialRampToValueAtTime(0.0001, t + dur); return e; }
  function ring(G, t, freqs, dur, gain, pan, lp, jit) { // inharmonic metal ring (partials with their own decays)
    const ctx = G.ctx;
    for (const [m, a] of freqs) {
      const o = ctx.createOscillator(); o.type = "sine"; const fm = m * (1 + (Math.random() - 0.5) * (jit || 0.04)); o.frequency.setValueAtTime(fm * 1.012, t); o.frequency.exponentialRampToValueAtTime(fm, t + 0.03); // struck metal settles a hair flat
      const d = dur * (0.3 + 0.55 / (1 + m / 1500)) * (0.7 + Math.random() * 0.6); const e = env(G, t, 0.0012, a * 0.75, d);
      o.connect(e); e.connect(out(G, t, gain, pan, lp)); o.start(t); o.stop(t + d + 0.03);
    }
  }
  // (a) rounds on the airframe ------------------------------------------------------------------
  // MG (.50 / 7.9 / 13 mm): bright metallic "ping" (stiff inharmonic ring 1.6–4.5 kHz) over a sheet-metal snap + a short thud; ~1 in 4 ricochets (a
  // downward-whining zing). 20 mm cannon: lower, heavier — a splitting crack, a clang at 400–900 Hz, a "whump" and the shell bursting inside the skin.
  function hitMG(G, t, pan, v, ric) {
    if (!room(G, t, 6, 0.3)) return;
    const base = 1500 + Math.random() * 2200;
    ring(G, t, [[base, 0.5], [base * 1.52, 0.3], [base * 2.31, 0.2], [base * 3.7, 0.08]], 0.16, 0.5 * v, pan, 9000);
    noiseHit(G, t, 0.014 + Math.random() * 0.012, 2600 + Math.random() * 1800, 0.8, 0.8 * v, pan, 8000, 0.0006); // the snap
    thump(G, t + 0.002, 118 + Math.random() * 40, 52, 0.09, 0.95 * v, pan * 0.4, 700); // thud through the structure (ref hits: ~55% of energy < 150 Hz)
    if (ric) { const o = G.ctx.createOscillator(); o.type = "triangle"; o.frequency.setValueAtTime(5200 + Math.random() * 1500, t + 0.01); o.frequency.exponentialRampToValueAtTime(1100, t + 0.2); const e = env(G, t + 0.01, 0.004, 0.16 * v, 0.2); o.connect(e); e.connect(out(G, t, 1, pan * 1.2, 7000)); o.start(t + 0.01); o.stop(t + 0.24); }
  }
  function hitCannon(G, t, pan, v) {
    if (!room(G, t, 9, 0.6)) return hitMG(G, t, pan, v, false);
    noiseHit(G, t, 0.03, 1900 + Math.random() * 900, 0.6, 1.0 * v, pan, 6500, 0.0007); // the crack
    thump(G, t + 0.002, 105 + Math.random() * 25, 34, 0.3, 1.05 * v, pan * 0.4, 520); // whump
    noiseHit(G, t + 0.012, 0.22, 380, 0.7, 0.7 * v, pan * 0.6, 1400, 0.003); // the shell bursting inside
    const b = 380 + Math.random() * 380;
    ring(G, t + 0.004, [[b, 0.55], [b * 2.76, 0.32], [b * 5.4, 0.18], [b * 8.9, 0.08]], 0.38, 0.5 * v, pan, 6000, 0.06); // clang of torn skin
    tear(G, t + 0.02, 0.18 + Math.random() * 0.16, 0.3 * v, pan);
    rattle(G, t + 0.035, 4 + ((Math.random() * 3) | 0), 0.3 * v, pan, 0.4);
  }
  function sHitOwn2(G, t, kind, pan0, side) {
    const pan = pan0 != null ? pan0 : (Math.random() - 0.5) * 1.1, v = 0.8 + Math.random() * 0.4;
    if (kind === "flak") return flakFragments(G, t, 0.8, pan);
    if (kind === "cannon" || kind === "engine") { hitCannon(G, t, pan, v); if (kind === "engine") sEngineHit(G, t + 0.05); return; }
    hitMG(G, t, pan, kind === "self" ? v * 0.75 : v, Math.random() < 0.25);
    if (Math.random() < 0.4) hitMG(G, t + 0.03 + Math.random() * 0.05, pan + (Math.random() - 0.5) * 0.3, v * 0.7, false);
    if (Math.random() < 0.55) rattle(G, t + 0.02, 3 + ((Math.random() * 3) | 0), 0.25 * v, pan, 0.25);
  }
  // a strafing pass: n hits at ~45–75 ms (20 mm cannon every 3rd), walking along the skin (pan sweeps), tapering off; one call = the whole burst
  // shred bed: while a burst chews through the skin, a continuous chopped band of torn-metal noise (≈12 Hz flutter) sits under the individual hits — the "shredded" texture of the user's clips
  function shredBed(G, t, dur, gain, panA, panB) {
    if (!room(G, t, 6, dur)) return;
    const ctx = G.ctx, s = ctx.createBufferSource(); s.buffer = G.noise; s.playbackRate.value = 0.9 + Math.random() * 0.2;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 0.9; bp.frequency.setValueAtTime(1500, t); bp.frequency.linearRampToValueAtTime(700, t + dur);
    const e = ctx.createGain(); e.gain.setValueAtTime(0.0001, t); e.gain.linearRampToValueAtTime(1, t + 0.05); e.gain.setValueAtTime(1, t + dur * 0.7); e.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const ch = ctx.createGain(); ch.gain.value = 0.55; const lfo = ctx.createOscillator(); lfo.type = "sawtooth"; lfo.frequency.value = 11 + Math.random() * 3;
    const lg = ctx.createGain(); lg.gain.value = 0.45; lfo.connect(lg); lg.connect(ch.gain);
    const o = out(G, t, gain, panA, 5000); if (G.ctx.createStereoPanner) { /* pan sweep follows the skin */ }
    s.connect(bp); bp.connect(ch); ch.connect(e); e.connect(o); s.start(t, Math.random() * 1.2); s.stop(t + dur + 0.05); lfo.start(t); lfo.stop(t + dur + 0.05);
  }
  function sStrafe(G, t, n, cannon, panA, panB) {
    let tt = t;
    if (n >= 6) shredBed(G, t, Math.min(2.2, n * 0.075), cannon ? 0.5 : 0.32, (panA + panB) / 2, 0);
    for (let k = 0; k < n; k++) {
      const pan = panA + (panB - panA) * (n > 1 ? k / (n - 1) : 0) + (Math.random() - 0.5) * 0.2, v = 0.9 - 0.25 * (k / Math.max(1, n));
      if (cannon && k % 3 === 1) hitCannon(G, tt, pan, v); else hitMG(G, tt, pan, v, Math.random() < 0.15);
      tt += 0.058 + Math.random() * 0.05; // ref patter: median 85 ms between hits (p10 63, p90 125–156)
    }
    return tt;
  }
  // (b) flak -----------------------------------------------------------------------------------------
  // ear-ring + muffle (1.5.6): ONLY on a direct flak hit on the player's own ship (game.js calls FGAudio.earRing() when flak damage is actually applied to our B-17),
  // at most once per run (stats.ringsThisRun, re-armed by reset()). No distance trigger: near-miss bursts keep their thump / shake / shrapnel but never ring.
  // Lasts RING_SEC (~10 s): the mix low-pass slams to ~450 Hz, holds ~1.5 s, then eases back to normal by t+10 s (exponential), while a high whine (3.1 kHz + faint 4.7 kHz, slow drift)
  // sits post-filter, swells in over 0.12 s, holds a while and fades out with a long tail that reaches zero exactly at t+10 s (no click).
  const RING_SEC = 10;
  function ringCore(G, t, depth) {
    const T = G.tame, C = G.ctx, d = depth == null ? 1 : depth; if (!T) return;
    T.frequency.cancelScheduledValues(t); T.frequency.setValueAtTime(TAME_F, t);
    T.frequency.exponentialRampToValueAtTime(450, t + 0.02); T.frequency.setValueAtTime(450, t + 1.5);
    T.frequency.exponentialRampToValueAtTime(TAME_F, t + RING_SEC);
    const e = C.createGain(); e.gain.setValueAtTime(0, t + 0.03); e.gain.linearRampToValueAtTime(0.05 * d, t + 0.15);
    e.gain.setValueAtTime(0.05 * d, t + 1.5); e.gain.exponentialRampToValueAtTime(0.0012 * d, t + RING_SEC - 0.6); e.gain.linearRampToValueAtTime(0, t + RING_SEC);
    e.connect(G.comp || C.destination); G.ringEnv = e;
    for (const [f, a, f2] of [[3100, 1, 2960], [4700, 0.3, 4560]]) {
      const o = C.createOscillator(); o.type = "sine"; o.frequency.setValueAtTime(f, t + 0.03); o.frequency.linearRampToValueAtTime(f2, t + RING_SEC);
      const g = C.createGain(); g.gain.value = a; o.connect(g); g.connect(e); o.start(t + 0.03); o.stop(t + RING_SEC + 0.05);
    }
  }
  function earRingNow(G, t, depth) { // gated: once per run
    stats.ringTries = (stats.ringTries || 0) + 1;
    if (stats.ringsThisRun >= 1) return false;
    stats.ringsThisRun = 1; stats.ringsTotal = (stats.ringsTotal || 0) + 1; ringCore(G, t, depth); return true;
  }
  function flakFragments(G, t, v, pan) { // shrapnel peppering the skin: fast gravelly ticks + a few tinks, thinning out over ~0.6 s
    const n = 14 + ((Math.random() * 10) | 0);
    for (let k = 0; k < n; k++) {
      const tt = t + Math.pow(Math.random(), 1.8) * 0.65, g = v * (0.9 - 0.7 * (tt - t) / 0.65);
      if (!room(G, tt, 2, 0.08)) continue;
      const p = pan + (Math.random() - 0.5) * 0.9;
      noiseHit(G, tt, 0.006 + Math.random() * 0.012, 1800 + Math.random() * 3200, 1.1, 1.4 * g, p, 7000, 0.0004);
      if (k % 3 === 0) tink(G, tt, 0.34 * g, p);
      else thump(G, tt, 190 + Math.random() * 90, 80, 0.035, 0.18 * g, p * 0.4, 900);
    }
  }
  function sFlakClose(G, t, dist, pan) { // d < ~120 u: a sharp concussive CRACK-BOOM, low thump, shrapnel, ear-ring
    const k = Math.max(0, 1 - dist / 140), vv = 0.55 + 0.45 * k;
    room(G, t, 10, 1.5);
    noiseHit(G, t, 0.1, 900, 0.3, 2.6 * vv, pan, 7500, 0.0005); // the crack (broadband, instant)
    noiseHit(G, t, 0.05, 2600, 0.5, 1.4 * vv, pan, 8000, 0.0004);
    noiseHit(G, t, 0.32, 320, 0.5, 1.7 * vv, pan, 1400, 0.003); // the boom body
    thump(G, t, 78, 26, 0.75, 1.05 * vv, pan * 0.3, 380); // low thump
    thump(G, t + 0.03, 46, 24, 0.9, 0.7 * vv, 0, 200); // sub
    flakFragments(G, t + 0.02 + dist / 700, 0.6 + 0.6 * k, pan);
    if (G.smp) playSample(G, G.smp.flak[(Math.random() * G.smp.flak.length) | 0], t, 1.1 * vv, pan * 0.4, 0.95 + Math.random() * 0.1);
  }
  function sFlakDistant(G, t, dist, pan) { // far burst: the thump arrives late and soft ("crump"): sub-120 Hz body, no crack, a faint lumpy tail
    const near = DM ? 1 : 1 / (1 + dist / 380);
    const o = G.ctx.createOscillator(); o.type = "sine"; o.frequency.setValueAtTime(74, t); o.frequency.exponentialRampToValueAtTime(30, t + 0.55);
    const e = G.ctx.createGain(); const a = 0.05 + Math.min(0.14, dist / 7000); // soft onset grows with distance (ref: 60–180 ms rises)
    e.gain.setValueAtTime(0.0001, t); e.gain.linearRampToValueAtTime(1, t + a); e.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    o.connect(e); e.connect(out(G, t, 1.5 * near + 0.15, pan * 0.5, 260)); o.start(t); o.stop(t + 1);
    noiseHit(G, t, 0.7, 210, 0.5, 1.1 * near + 0.1, pan, 520, a * 0.7);
    noiseHit(G, t + 0.012, 0.42, 520, 0.7, 0.62 * near + 0.1, pan, 1500, a * 0.5); // 1.5.4: mid body (250–900 Hz) — a phone speaker has no sub, so the burst lives here
    noiseHit(G, t + 0.18, 0.5, 520, 0.5, 0.22 * near, pan, 900, 0.08);
    if (G.smp) playSample(G, G.smp.flak[(Math.random() * G.smp.flak.length) | 0], t, 0.5 * (DM ? 1 : near + 0.15), pan, 0.9 + Math.random() * 0.2); // rendered thump layer
  }

  // 1.5.3 WGr.21 rocket (tuned on a reference rocket-attack clip): launch thump + hiss; FLIGHT = a band-limited whoosh swelling ~+11 dB over ~1 s
  // (mid 400–2k dominant, sizzle above 2k); IMPACT on the airframe = metal bang + a very low (<150 Hz) concussion ~10 dB over the mid band that holds ~1 s
  // then falls ~6 dB per 0.3 s, thumping fragments every ~100 ms, shrapnel on the skin, ear-ring. Far impacts are just a flak-style crump.
  function sRocketFlight(G, t, dist, pan, dur) {
    if (!room(G, t, 3, dur + 0.5)) return;
    const ctx = G.ctx, near = DM ? 1 : 1 / (1 + dist / 500);
    const s = ctx.createBufferSource(); s.buffer = G.noise; s.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 1.3; bp.frequency.setValueAtTime(650, t); bp.frequency.exponentialRampToValueAtTime(2300, t + dur);
    const e = ctx.createGain(); e.gain.setValueAtTime(0.03, t); e.gain.exponentialRampToValueAtTime(1, t + dur); e.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.45);
    s.connect(bp); bp.connect(e); e.connect(out(G, t, 1.3 * near + 0.18, pan, 6000)); s.start(t); s.stop(t + dur + 0.5);
    const sz = ctx.createBufferSource(); sz.buffer = G.noise; sz.playbackRate.value = 1.3; sz.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 2600; const e2 = ctx.createGain(); e2.gain.setValueAtTime(0.02, t); e2.gain.exponentialRampToValueAtTime(0.5, t + dur); e2.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.4);
    sz.connect(hp); hp.connect(e2); e2.connect(out(G, t, 0.1 * near + 0.015, pan, 8000)); sz.start(t); sz.stop(t + dur + 0.45);
  }
  function sRocketImpact(G, t, dist, pan) {
    if (dist > 120) return sFlakDistant(G, t, dist, pan);
    const k = Math.max(0.25, 1 - dist / 160);
    room(G, t, 12, 2.0);
    noiseHit(G, t, 0.012, 2000, 0.6, 1.6 * k, pan, 7500, 0.0004); // the skin cracking open
    ring(G, t, [[520, 0.6], [1250, 0.35], [2600, 0.2]], 0.35, 0.6 * k, pan, 6000, 0.05);
    { // concussion: held ~0.9 s then falling (ref: -13..-15 dBFS for ~1 s, -21 by 1.4 s)
      const o = G.ctx.createOscillator(); o.type = "sine"; o.frequency.setValueAtTime(85, t); o.frequency.exponentialRampToValueAtTime(34, t + 1.6);
      const e = G.ctx.createGain(); e.gain.setValueAtTime(0.0001, t); e.gain.linearRampToValueAtTime(1, t + 0.03); e.gain.exponentialRampToValueAtTime(0.4, t + 0.7); e.gain.exponentialRampToValueAtTime(0.1, t + 1.2); e.gain.exponentialRampToValueAtTime(0.0001, t + 1.9);
      o.connect(e); e.connect(out(G, t, 0.62 * k, pan * 0.3, 320)); o.start(t); o.stop(t + 1.95);
    }
    noiseHit(G, t, 1.0, 200, 0.5, 0.9 * k, pan, 500, 0.004);
    noiseHit(G, t + 0.01, 0.6, 900, 0.5, 6.0 * k, pan, 2200, 0.004); // mid body of the blast (ref: mid ~11–13 dB under the low band)
    for (let i = 0; i < 6; i++) thump(G, t + 0.08 + i * (0.09 + Math.random() * 0.05), 95 - i * 8, 38, 0.14, (0.8 - i * 0.1) * k, pan * 0.5, 400); // secondary thumps
    flakFragments(G, t + 0.04, 0.9 * k, pan);
  }
  // 1.5.4 radio intercom: squelch-open click, a syllabic noise "voice" burble through a 350–2600 Hz radio band, squelch-close tail. NO tones/beeps.
  function sIntercom(G, t) {
    const ctx = G.ctx;
    noiseHit(G, t, 0.03, 2800, 0.6, 0.30, 0, 6000, 0.0005); // key-up click
    const dur = 0.55 + Math.random() * 0.25, s = ctx.createBufferSource(); s.buffer = G.noise; s.loop = true; s.playbackRate.value = 0.9 + Math.random() * 0.2;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 900 + Math.random() * 300; bp.Q.value = 0.8;
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 350;
    const e = ctx.createGain(); e.gain.value = 0;
    let tt = t + 0.04; // syllables: random-length bursts, each a little different in level, like speech
    while (tt < t + dur) { const sy = 0.05 + Math.random() * 0.09, lv = 0.12 + Math.random() * 0.2; e.gain.setValueAtTime(0.0001, tt); e.gain.linearRampToValueAtTime(lv, tt + 0.012); e.gain.setTargetAtTime(0.0001, tt + sy, 0.02); bp.frequency.setValueAtTime(700 + Math.random() * 1500, tt); tt += sy + 0.025 + Math.random() * 0.05; }
    s.connect(bp); bp.connect(hp); hp.connect(e); e.connect(out(G, t, 1, 0, 3200)); s.start(t, Math.random() * 3); s.stop(t + dur + 0.2);
    noiseHit(G, t + dur + 0.04, 0.09, 1800, 0.5, 0.16, 0, 5000, 0.001); // squelch tail
  }
  function sFlak2(G, t, dist, pan) { if (dist < 120) sFlakClose(G, t, dist, pan); else sFlakDistant(G, t, dist, pan); }
  // (c) structural damage ---------------------------------------------------------------------------
  function sEngineHit(G, t) { // sputter-bang, a grinding rattle with the pitch falling away
    if (!room(G, t, 8, 1.6)) return;
    const ctx = G.ctx;
    for (let k = 0; k < 5; k++) thump(G, t + k * (0.07 + Math.random() * 0.05), 120 - k * 14, 45, 0.07, 0.45 - k * 0.05, (Math.random() - 0.5) * 0.4, 700);
    const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.setValueAtTime(95, t + 0.1); o.frequency.exponentialRampToValueAtTime(34, t + 1.5);
    const am = ctx.createOscillator(); am.type = "square"; am.frequency.setValueAtTime(34, t); am.frequency.exponentialRampToValueAtTime(11, t + 1.5); const amg = ctx.createGain(); amg.gain.value = 0.5;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t + 0.1); g.gain.linearRampToValueAtTime(0.5, t + 0.2); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.55); amg.connect(g.gain);
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 480; o.connect(lp); lp.connect(g); g.connect(out(G, t, 0.7, 0, null));
    o.start(t + 0.1); o.stop(t + 1.6); am.connect(amg); am.start(t + 0.1); am.stop(t + 1.6);
    noiseHit(G, t + 0.15, 0.9, 1400, 2.5, 0.12, 0, 3000, 0.1); // metal on metal grind
  }
  function sCreak(G, t, dur, gain, pan) { // wing / tail under load: a groaning, swept narrow noise band + a wavering low tone
    if (!room(G, t, 4, dur)) return;
    const ctx = G.ctx, s = ctx.createBufferSource(); s.buffer = G.noise; s.playbackRate.value = 0.5;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 9; const f0 = 260 + Math.random() * 200;
    bp.frequency.setValueAtTime(f0, t); bp.frequency.linearRampToValueAtTime(f0 * 1.9, t + dur * 0.5); bp.frequency.linearRampToValueAtTime(f0 * 1.15, t + dur);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 5 + Math.random() * 4; const lg = ctx.createGain(); lg.gain.value = 0.35; const e = ctx.createGain(); e.gain.setValueAtTime(0.0001, t); e.gain.linearRampToValueAtTime(0.6, t + dur * 0.3); e.gain.linearRampToValueAtTime(0.0001, t + dur);
    lfo.connect(lg); lg.connect(e.gain); s.connect(bp); bp.connect(e); e.connect(out(G, t, gain, pan, 2400));
    s.start(t, Math.random()); s.stop(t + dur + 0.05); lfo.start(t); lfo.stop(t + dur + 0.05);
    const o = ctx.createOscillator(); o.type = "triangle"; o.frequency.setValueAtTime(118, t); o.frequency.linearRampToValueAtTime(96, t + dur); const e2 = env(G, t, dur * 0.4, 0.25, dur);
    o.connect(e2); e2.connect(out(G, t, gain * 0.7, pan * 0.5, 400)); o.start(t); o.stop(t + dur + 0.05);
  }
  function sWindRoar(G, t, dur, gain) { // air tearing through the new holes: a rising broadband roar that lingers
    if (!room(G, t, 3, dur)) return;
    const ctx = G.ctx, s = ctx.createBufferSource(); s.buffer = G.noise; s.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 0.5; bp.frequency.setValueAtTime(420, t); bp.frequency.linearRampToValueAtTime(1200, t + dur * 0.4); bp.frequency.linearRampToValueAtTime(600, t + dur);
    const e = ctx.createGain(); e.gain.setValueAtTime(0.0001, t); e.gain.linearRampToValueAtTime(1, t + dur * 0.25); e.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(bp); bp.connect(e); e.connect(out(G, t, gain, 0, 4000)); s.start(t); s.stop(t + dur + 0.05);
  }
  function sFireWhoosh(G, t, gain) { // flames catching: a soft rushing whoomph then crackle
    if (!room(G, t, 4, 1.4)) return;
    const ctx = G.ctx, s = ctx.createBufferSource(); s.buffer = G.noise; s.playbackRate.value = 0.7;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.setValueAtTime(300, t); lp.frequency.exponentialRampToValueAtTime(1500, t + 0.35); lp.frequency.exponentialRampToValueAtTime(420, t + 1.3);
    const e = env(G, t, 0.18, 1, 1.35); s.connect(lp); lp.connect(e); e.connect(out(G, t, gain, 0, null)); s.start(t, 0.3); s.stop(t + 1.4);
    thump(G, t, 70, 32, 0.4, 0.5 * gain, 0, 300);
    for (let k = 0; k < 9; k++) noiseHit(G, t + 0.3 + Math.random() * 1.0, 0.01 + Math.random() * 0.012, 2000 + Math.random() * 3000, 1.2, 0.12 * gain, (Math.random() - 0.5) * 0.4, 6000);
  }
  function sDecomp(G, t, gain) { // a window / skin goes: a bang, then wind hissing through the hole
    if (!room(G, t, 6, 1.6)) return;
    noiseHit(G, t, 0.05, 1500, 0.5, 0.9 * gain, 0, 6000, 0.001); thump(G, t, 90, 40, 0.22, 0.8 * gain, 0, 600);
    const ctx = G.ctx, s = ctx.createBufferSource(); s.buffer = G.noise; s.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 1.4; bp.frequency.setValueAtTime(2800, t); bp.frequency.exponentialRampToValueAtTime(500, t + 1.5);
    const e = env(G, t, 0.03, 0.9, 1.6); s.connect(bp); bp.connect(e); e.connect(out(G, t, 0.55 * gain, 0, 5000)); s.start(t); s.stop(t + 1.65);
  }
  function sBreakOff(G, t, kind) { // the wing / tail tears off: sheet-metal shriek + crunch, a deep boom, clanging debris
    room(G, t, 12, 2.2);
    noiseHit(G, t, 0.05, 1200, 0.5, 1.2, 0, 7000, 0.0008);
    thump(G, t, 70, 24, 1.0, 1.4, 0, 320);
    for (let k = 0; k < 4; k++) tear(G, t + 0.02 + k * 0.09, 0.4 + Math.random() * 0.4, 0.5, (Math.random() - 0.5) * 0.8);
    const b = kind === "wing" ? 240 : 330;
    ring(G, t + 0.02, [[b, 0.6], [b * 2.4, 0.4], [b * 4.9, 0.25], [b * 7.7, 0.12]], 1.2, 0.5, 0, 5000, 0.08);
    noiseHit(G, t + 0.05, 1.3, 300, 0.4, 0.7, 0, 900, 0.03);
    sWindRoar(G, t + 0.1, 2.0, 0.5);
    for (let k = 0; k < 10; k++) { const tt = t + 0.25 + Math.pow(Math.random(), 1.5) * 1.3; tink(G, tt, 0.2 * (1 - (tt - t) / 1.7), (Math.random() - 0.5) * 0.9); }
  }

  function sBoom(G, t, dist, pan, big) {
    const near = DM ? 1 : 1 / (1 + dist / 150), lp = DM ? 9000 : Math.max(300, 1800 - dist * 1.2);
    thump(G, t, big ? 60 : 80, 22, big ? 1.4 : 0.9, (big ? 1.3 : 0.9) * near, pan, lp);
    noiseHit(G, t, big ? 1.6 : 1.1, 260, 0.5, 1.3 * near, pan, lp, 0.01);
  }
  // 1.5.2: WGr.21 rocket launch — ignition thump, then a rushing hiss that sweeps up and fades as it flies off
  function sRocket(G, t, dist, pan) {
    const ctx = G.ctx, near = DM ? 1 : 1 / (1 + dist / 260);
    thump(G, t, 85, 32, 0.35, 0.9 * near, pan, 900);
    noiseHit(G, t, 0.09, 1400, 0.8, 0.5 * near, pan, 4500);
    const s = ctx.createBufferSource(); s.buffer = G.noise; s.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 2.2; bp.frequency.setValueAtTime(700, t); bp.frequency.exponentialRampToValueAtTime(2600, t + 0.5); bp.frequency.exponentialRampToValueAtTime(900, t + 1.6);
    const e = ctx.createGain(); e.gain.setValueAtTime(0.0001, t); e.gain.exponentialRampToValueAtTime(0.55 * near + 0.02, t + 0.08); e.gain.setValueAtTime(0.55 * near + 0.02, t + 0.7); e.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
    s.connect(bp); bp.connect(e); e.connect(out(G, t, 0.5, pan)); s.start(t); s.stop(t + 1.9);
    sRocketFlight(G, t + 0.15, dist, pan, 1.0 + Math.min(0.5, dist / 800));
  }
  function sFlak(G, t, dist, pan) { // the "crump": dull boom, then a short crackle of fragments
    const near = DM ? 1 : 1 / (1 + dist / 220);
    if (dist < 90) { thump(G, t, 120, 35, 0.5, 1.2 * (1 - dist / 90) + 0.3, pan, 2500); noiseHit(G, t, 0.12, 1800, 0.7, 0.9 * (1 - dist / 90), pan, 5000); } // close: a hard, sharp WHAM
    thump(G, t, 55, 25, 0.7, 0.8 * near, pan, 500);
    noiseHit(G, t, 0.7, 180, 0.6, 0.7 * near, pan, 700, 0.006);
    if (dist < 500) for (let k = 0; k < 4; k++) tink(G, t + 0.25 + Math.random() * 0.3, 0.12 * near, pan);
  }
  // 1.3.8 shot-down sequence voices ----------------------------------------------------------
  function sFallStart(G, t) {
    const ctx = G.ctx;
    G.wind.gain.cancelScheduledValues(t); G.wind.gain.setValueAtTime(0.05, t); G.wind.gain.linearRampToValueAtTime(0.17, t + 6);
    G.windBP.frequency.cancelScheduledValues(t); G.windBP.frequency.setValueAtTime(700, t); G.windBP.frequency.exponentialRampToValueAtTime(1400, t + 6);
    G.rumble.gain.setValueAtTime(0.16, t); G.rumble.gain.linearRampToValueAtTime(0.3, t + 3);
    // the airframe's falling howl: a resonant noise band sliding down
    const s = ctx.createBufferSource(); s.buffer = G.noise; s.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 9; bp.frequency.setValueAtTime(950, t); bp.frequency.exponentialRampToValueAtTime(260, t + 8);
    const e = ctx.createGain(); e.gain.setValueAtTime(0.0001, t); e.gain.exponentialRampToValueAtTime(0.9, t + 1.5); e.gain.setValueAtTime(0.9, t + 6.5); e.gain.exponentialRampToValueAtTime(0.0001, t + 8.3);
    s.connect(bp); bp.connect(e); e.connect(out(G, t, 0.5, 0)); s.start(t); s.stop(t + 8.5);
    thump(G, t, 70, 28, 0.6, 0.9, 0, 800); noiseHit(G, t, 0.5, 400, 0.6, 0.7, 0, 1500);
  }
  function sBell(G, t) { // bail-out alarm bell: rapid strikes
    const ctx = G.ctx;
    for (let k = 0; k < 16; k++) {
      const tt = t + k * 0.11;
      for (const [f, a] of [[1180, 0.5], [2710, 0.25], [4010, 0.12]]) {
        const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = f;
        const e = ctx.createGain(); e.gain.setValueAtTime(0.0001, tt); e.gain.exponentialRampToValueAtTime(a, tt + 0.003); e.gain.exponentialRampToValueAtTime(0.0001, tt + 0.1);
        o.connect(e); e.connect(out(G, tt, 0.35, 0.1, 5000)); o.start(tt); o.stop(tt + 0.12);
      }
    }
  }
  function sBail(G, t) {
    noiseHit(G, t, 0.9, 900, 0.5, 1.1, 0, 4000, 0.05); // out of the hatch into the slipstream
    G.busE.gain.cancelScheduledValues(t); G.busE.gain.setValueAtTime(G.busE.gain.value || 0.24, t); G.busE.gain.linearRampToValueAtTime(0.0001, t + 1.2);
    G.wind.gain.cancelScheduledValues(t); G.wind.gain.setValueAtTime(0.17, t); G.wind.gain.linearRampToValueAtTime(0.1, t + 1.3);
    G.rumble.gain.cancelScheduledValues(t); G.rumble.gain.setValueAtTime(0.3, t); G.rumble.gain.linearRampToValueAtTime(0.01, t + 1.5);
    G.distDrone.gain.setValueAtTime(0, t); G.distDrone.gain.linearRampToValueAtTime(0.05, t + 1.5);
  }
  function sChuteOpen(G, t) {
    noiseHit(G, t, 0.16, 700, 0.8, 1.3, 0, 3000, 0.003); thump(G, t, 95, 40, 0.3, 0.8, 0, 900);
    for (let k = 0; k < 5; k++) noiseHit(G, t + 0.15 + k * 0.13, 0.1, 380, 0.9, 0.5 - k * 0.08, (Math.random() - 0.5) * 0.4, 1500);
    G.wind.gain.cancelScheduledValues(t); G.wind.gain.setValueAtTime(0.1, t); G.wind.gain.linearRampToValueAtTime(0.012, t + 1.2);
    G.windBP.frequency.cancelScheduledValues(t); G.windBP.frequency.setValueAtTime(1400, t); G.windBP.frequency.exponentialRampToValueAtTime(450, t + 1.2);
    G.chute.gain.cancelScheduledValues(t); G.chute.gain.setValueAtTime(0.0, t); G.chute.gain.linearRampToValueAtTime(0.05, t + 1.0);
    G.chuteFlap.gain.setValueAtTime(0.02, t);
  }
  // 1.4.1: under the canopy — the wind fades as we slow and settle, the box's drone recedes, far-off flak thumps
  function sFarFlak(G, t, dist, pan) { // a distant flak burst heard from the chute: a soft low "whump", no crackle
    const near = DM ? 1 : 1 / (1 + dist / 400);
    thump(G, t, 48 + Math.random() * 10, 22, 0.9 + Math.random() * 0.4, 0.55 * near, pan, 260);
    noiseHit(G, t + 0.02, 1.1, 140, 0.5, 0.35 * near, pan, 320, 0.03);
  }
  function chuteBed(G, t, ct, boxDist) { // levels for chute time ct (s) and the box's distance (u)
    const w = 0.012 + 0.05 * Math.exp(-ct / 12); // the slipstream roar dying away to a breath
    G.chute.gain.setTargetAtTime(0.028 + 0.03 * Math.exp(-ct / 20), t, 0.8);
    G.chuteFlap.gain.setTargetAtTime(0.008 + 0.014 * Math.exp(-ct / 15), t, 0.8);
    G.wind.gain.setTargetAtTime(w, t, 0.8);
    const k = 1 / (1 + (boxDist || 0) / 420);
    G.distDrone.gain.setTargetAtTime(0.075 * k, t, 0.7);
  }
  function sBombsAway(G, t) { // the shackles let go one after another, the bay door bang, the ship lifts
    for (let k = 0; k < 10; k++) {
      const tt = t + k * (0.09 + Math.random() * 0.03), pan = (k % 2 ? 0.15 : -0.15);
      thump(G, tt, 190 + Math.random() * 40, 80, 0.07, 0.35, pan, 2400);
      noiseHit(G, tt, 0.04, 1300 + Math.random() * 500, 1.2, 0.25, pan, 5000);
    }
    thump(G, t, 52, 24, 1.1, 0.9, 0, 300); // the whole airframe unloading
    G.rumble.gain.cancelScheduledValues(t); G.rumble.gain.setValueAtTime(0.16, t); G.rumble.gain.linearRampToValueAtTime(0.34, t + 0.3); G.rumble.gain.linearRampToValueAtTime(0.16, t + 2.2);
    noiseHit(G, t + 0.25, 1.4, 500, 0.4, 0.3, 0, 1500, 0.2); // wind through the open bay
  }
  function restoreGraph(G, t) {
    if (G.tame) { G.tame.frequency.cancelScheduledValues(t); G.tame.frequency.setValueAtTime(TAME_F, t); }
    if (G.ringEnv) { try { G.ringEnv.gain.cancelScheduledValues(t); G.ringEnv.gain.setTargetAtTime(0, t, 0.03); } catch (e) {} G.ringEnv = null; }
    for (const E of G.eng) {
      E.saw.frequency.cancelScheduledValues(t); E.buzz.frequency.cancelScheduledValues(t); E.g.gain.cancelScheduledValues(t);
      E.saw.frequency.setValueAtTime(E.f0, t); E.buzz.frequency.setValueAtTime(E.f0 * E.kb, t); E.g.gain.setValueAtTime(E.level, t);
      E.state = "run"; E.sput = 0;
    }
    for (const [p, v] of [[G.holeWind.gain, 0], [G.busE.gain, 0.24], [G.wind.gain, 0.045], [G.windBP.frequency, 700], [G.rumble.gain, 0.16], [G.chute.gain, 0], [G.chuteFlap.gain, 0], [G.distDrone.gain, 0]]) { p.cancelScheduledValues(t); p.setValueAtTime(v, t); }
  }
  function sWhoosh(G, t, pan0, pan1, gain, closing, dur) { // fly-by: noise sweep + engine buzz with doppler
    const ctx = G.ctx;
    const dop = Math.min(0.45, closing / 340 * 0.6);
    const s = ctx.createBufferSource(); s.buffer = G.noise; s.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(1600 * (1 + dop), t); bp.frequency.exponentialRampToValueAtTime(420, t + dur);
    const e = ctx.createGain(); e.gain.setValueAtTime(0.0001, t); e.gain.exponentialRampToValueAtTime(1, t + dur * 0.42); e.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const o = ctx.createOscillator(); o.type = "sawtooth"; // DB 605 at ~2,600 rpm, doppler-shifted
    o.frequency.setValueAtTime(128 * (1 + dop), t); o.frequency.setValueAtTime(128 * (1 + dop), t + dur * 0.4); o.frequency.exponentialRampToValueAtTime(128 * (1 - dop * 0.7), t + dur * 0.6);
    const og = ctx.createGain(); og.gain.value = 0.18; const olp = ctx.createBiquadFilter(); olp.type = "lowpass"; olp.frequency.value = 900;
    s.connect(bp); bp.connect(e); o.connect(olp); olp.connect(og); og.connect(e);
    let dst = G.sfx;
    const g = ctx.createGain(); g.gain.value = gain;
    if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.setValueAtTime(pan0, t); p.pan.linearRampToValueAtTime(pan1, t + dur); g.connect(p); p.connect(dst); } else g.connect(dst);
    e.connect(g);
    s.start(t); s.stop(t + dur + 0.05); o.start(t); o.stop(t + dur + 0.05);
  }
  // engine state machine: run / sputter (fire) / winding down (out)
  function engineAt(G, i, t, st) {
    const E = G.eng[i];
    if (st === "out" && E.state !== "out") {
      E.state = "out"; count("engineOut");
      E.saw.frequency.cancelScheduledValues(t); E.buzz.frequency.cancelScheduledValues(t);
      E.saw.frequency.setValueAtTime(E.f0, t); E.saw.frequency.exponentialRampToValueAtTime(7, t + 7);
      E.buzz.frequency.setValueAtTime(E.f0 * E.kb, t); E.buzz.frequency.exponentialRampToValueAtTime(20, t + 7);
      // a few last coughs, then silence
      E.g.gain.cancelScheduledValues(t); E.g.gain.setValueAtTime(E.level, t);
      for (let k = 0; k < 6; k++) { const tt = t + 0.3 + k * 0.55; E.g.gain.setValueAtTime(0.02, tt); E.g.gain.setValueAtTime(E.level * (0.9 - k * 0.12), tt + 0.12); }
      E.g.gain.setValueAtTime(E.level * 0.2, t + 3.8); E.g.gain.exponentialRampToValueAtTime(0.0001, t + 7);
    } else if (st === "sputter" && E.state === "run") { E.state = "sputter"; count("engineSputter"); }
    else if (st === "run" && E.state === "sputter") { E.state = "run"; E.g.gain.setValueAtTime(E.level, t); }
    if (E.state === "sputter" && t > E.sput) { // random misfires + pitch sag
      E.sput = t + 0.18 + Math.random() * 0.5;
      E.g.gain.setValueAtTime(E.level * 0.15, t); E.g.gain.setValueAtTime(E.level, t + 0.06 + Math.random() * 0.1);
      E.saw.frequency.setValueAtTime(E.f0 * (0.92 + Math.random() * 0.06), t); E.saw.frequency.linearRampToValueAtTime(E.f0, t + 0.4);
    }
  }

  // ---------- live instance ----------
  let ctx = null, G = null;
  const L = { fx: 0, fy: 0, fz: 1, rx: -1, ry: 0, rz: 0, cx: 0, cy: 0, cz: 0 }; // listener basis (view)
  const budget = { t: 0, n: 0 };
  const shotClock = { t: 0, real: 0, last: 0, n: 0, fired: 0, P: 0.05 }; // own-gun belt clock + rounds since the last end sound
  const passes = new Map(); // fighter id → {minD, done}
  let muted = false, lastDistGun = 0, nextFarFlak = 0;
  function ok() { return !!(ctx && G && ctx.state === "running") && !muted; }
  function panOf(x, y, z) { const dx = x - L.cx, dy = y - L.cy, dz = z - L.cz, d = Math.hypot(dx, dy, dz) || 1; return { d, pan: (dx * L.rx + dy * L.ry + dz * L.rz) / d }; }
  const API = {
    stats, distTable: () => DIST_TABLE.map((r) => ({ d: r.d, rows: r.rows.map((x) => ({ src: x.src, fire: x.fire, delay: +x.delay.toFixed(3), gain: +x.gain.toFixed(3), lp: Math.round(x.lp) })) })),
    unlock() {
      try {
        if (!AC) return;
        if (!ctx) { ctx = new AC({ latencyHint: "playback" }); G = Graph(ctx); }
        if (ctx.state !== "running") ctx.resume();
        G.master.gain.setTargetAtTime(0.8, ctx.currentTime, 0.8);
        stats.unlocked = true;
      } catch (e) { stats.errors++; stats.lastError = String(e); }
    },
    frame(s) {
      if (!ok()) return;
      try {
        const t = ctx.currentTime;
        if (shotClock.n > 0 && s.firing === false && t - shotClock.last > 0.35) API.gunRelease(); // safety net: a missed trigger-release edge still gets its single end sound
        Object.assign(L, s.listener || {});
        G.master.gain.setTargetAtTime(s.playing ? 0.8 : 0.35, t, 0.5);
        { const h = s.down ? 0 : Math.max(0, s.holes || 0), k = Math.sqrt(h); // 1.5.4 wind through the holes: level ∝ √holes (cap 0.17), pitch & flutter rise with holes
          G.holeWind.gain.setTargetAtTime(h > 0 ? Math.min(0.17, 0.02 + 0.02 * k) : 0, t, 0.6);
          G.holeBP.frequency.setTargetAtTime(700 + 130 * Math.min(k, 8), t, 0.8);
          G.holeFlutter.gain.setTargetAtTime(h > 0 ? Math.min(0.17, 0.02 + 0.02 * k) * Math.min(0.5, 0.1 + 0.05 * k) : 0, t, 0.6); }
        if (s.down === "chute") { // under the canopy: the battle recedes — wind fades, the box's drone recedes, far flak
          const k = 1 / (1 + (s.boxDist || 0) / 350);
          chuteBed(G, t, s.chuteT || 0, s.boxDist || 0);
          if (t - lastDistGun > 0.5 + Math.random() * 1.2 && k > 0.18) { lastDistGun = t; const d = (s.boxDist || 300) + Math.random() * 200; for (let q = 0; q < 3; q++) withDM(d, 260, () => sGun(G, t + Math.min(DELAY_CAP, d / U_PER_S) + q * 0.07, d, (Math.random() - 0.5) * 0.6, false)); }
          if (t > nextFarFlak) { nextFarFlak = t + 2.2 + Math.random() * 4.5; sFarFlak(G, t, 700 + Math.random() * 1400, (Math.random() - 0.5) * 1.4); count("farFlak"); }
          return;
        }
        if (s.engines) for (let i = 0; i < 4 && i < s.engines.length; i++) { const e = s.engines[i]; engineAt(G, i, t, e.out ? "out" : e.fire > 0.25 ? "sputter" : "run"); }
        // fly-bys: when a 109 passes its closest point within ~220u at speed
        if (s.fighters) for (const f of s.fighters) {
          const dx = f.x - L.cx, dy = f.y - L.cy, dz = f.z - L.cz, d = Math.hypot(dx, dy, dz);
          let p = passes.get(f.id); if (!p) { p = { minD: 1e9, done: false }; passes.set(f.id, p); }
          const closing = -(dx * f.vx + dy * f.vy + dz * f.vz) / (d || 1);
          if (d > 400) { p.done = false; p.minD = 1e9; continue; }
          if (!p.done && d < 220 && closing < 30 * 0.3 && Math.hypot(f.vx, f.vy, f.vz) > 60) { // just past the closest point
            p.done = true;
            const pan0 = panOf(f.x - f.vx * 0.5, f.y - f.vy * 0.5, f.z - f.vz * 0.5).pan, pan1 = panOf(f.x + f.vx * 0.6, f.y + f.vy * 0.6, f.z + f.vz * 0.6).pan;
            sWhoosh(G, t, pan0, pan1, 0.9 / (1 + d / 60), Math.hypot(f.vx, f.vy, f.vz), 1.3); count("whoosh");
          }
        }
      } catch (e) { stats.errors++; stats.lastError = String(e); }
    },
    gun(x, y, z) { // another Fortress's gunner fires a round: 1.5.7 → the player's round sample through the distant-gun model (delay = d / speed of sound, muffled, faint, thinned, capped)
      if (!ok()) return;
      const q = panOf(x, y, z); if (q.d >= AI_CUTOFF) return;
      const t = ctx.currentTime + distModel(q.d, 260).delay + Math.random() * 0.02;
      if (!aiGunAllowed(t, q.d)) return; aiRound(G, t, q.d, q.pan); count("boxGun");
    },
    p51Gun(x, y, z) { // a P-51's six .50s: the same distant-gun model (the caller already fires every other tick)
      if (!ok()) return;
      const q = panOf(x, y, z); if (q.d >= AI_CUTOFF) return;
      const t = ctx.currentTime + distModel(q.d, 300).delay + Math.random() * 0.02;
      if (!aiGunAllowed(t, q.d)) return; aiRound(G, t, q.d, q.pan); count("p51Gun");
    },
    // 1.6.0: crew voices ride on their own bus straight to the destination (post master/EQ/compressor, so they are never ducked or squashed by the battle); duck(on) dips everything else 6 dB (50 ms attack, ~150 ms release)
    voiceBus() { if (!ctx || !G || ctx.state !== "running" || muted) return null; if (!G.vbus) { // the battle mix (soft-clipped to −0.5 dBFS) and the voices share ONE final limiter, so a line landing on a full-scale gun burst cannot clip (measured: 136 clipped samples / 110 s without it, 0 with)
        G.vbus = ctx.createGain(); G.vbus.gain.value = 1.4; // +3 dB: a line must stay readable over the player's own guns (the limiter below catches the peaks)
        const fin = ctx.createGain(), lim = ctx.createDynamicsCompressor(); lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.1;
        try { G.sat.disconnect(); } catch (e) {} G.sat.connect(fin); G.vbus.connect(fin); fin.connect(lim); lim.connect(ctx.destination); G.vlim = lim;
      } return { ctx, bus: G.vbus }; },
    duck(on) { if (!ctx || !G || !G.duckG) return; const t = ctx.currentTime; G.duckG.gain.cancelScheduledValues(t); G.duckG.gain.setTargetAtTime(on ? 0.5 : 1, t, on ? 0.02 : 0.06); count(on ? "duckOn" : "duckOff"); },
    intercom() { if (!ok()) return; sIntercom(G, ctx.currentTime); count("intercom"); },
    ownShot(side) { // 1.5.6: rounds ride a steady belt clock (real guns are mechanical: ~6 % timing jitter, not the 20 % the frame loop gives), re-synced after a pause
      if (!ok()) return;
      const now = ctx.currentTime, gap = now - shotClock.real, burst = shotClock.last > 0 && gap < 0.14;
      if (burst) shotClock.P = Math.min(0.075, Math.max(0.04, shotClock.P * 0.85 + gap * 0.15)); // belt period follows the game's real average cadence (frame-quantised 50/66 ms → smooth ~58)
      let t = burst ? shotClock.t + shotClock.P * (0.97 + Math.random() * 0.06) : now + 0.004;
      if (t < now + 0.002 || t > now + 0.09) t = now + 0.004 + Math.random() * 0.004; // fell behind / ran ahead of the real trigger → resync
      shotClock.t = t; shotClock.real = now; shotClock.last = t; shotClock.n++; shotClock.fired++;
      sGun(G, t, 0, side ? 0.25 : -0.25, true); count("ownGun");
      if (Math.random() < 0.28) { sBrass(G, t + 0.18 + Math.random() * 0.25, side ? 0.35 : -0.35); count("brass"); }
    },
    gunRelease() { // 1.5.6: trigger let go (finger lifted, guns overheated/cut, or the run ended): ONE end sound if at least one round was fired since the last end sound, else nothing
      if (!ok()) { shotClock.n = 0; return false; }
      if (shotClock.n < 1) return false;
      shotClock.n = 0; sGunEnd(G, Math.max(ctx.currentTime + 0.002, shotClock.last + 0.02), true); count("gunEnd"); stats.gunEnds = (stats.gunEnds || 0) + 1; return true;
    },
    hitEnemy() { if (!ok()) return; const t = ctx.currentTime + 0.05; tink(G, t, 0.12, 0); sHitThump(G, t + 0.01); count("hitEnemy"); },
    hitOwn(kind, pan, n) { // 1.5.3: kind mg|cannon|engine|self|flak; pan -1..1 = which side of the ship; n>1 = a strafing burst (hit count)
      if (!ok()) return; const t = ctx.currentTime;
      if (n > 1 && kind !== "flak") sStrafe(G, t, Math.min(14, n), kind === "cannon" || kind === "engine", (pan || 0) - 0.3, (pan || 0) + 0.3); else sHitOwn2(G, t, kind || "mg", pan);
      count("hitOwn");
    },
    rocketImpact(onShip, x, y, z) { // 1.5.3: a WGr.21 detonating on / near our airframe (onShip) or somewhere in the box
      if (!ok()) return; const t = ctx.currentTime;
      if (onShip) sRocketImpact(G, t, 8, (Math.random() - 0.5) * 0.8); else { const q = panOf(x, y, z); withDM(q.d, 650, (m) => sRocketImpact(G, t + m.delay, q.d, q.pan)); }
      count("rocketImpact");
    },
    structure(kind, pan) { // 1.5.3: engine | creak | wind | fire | decomp | wingOff | tailOff
      if (!ok()) return; const t = ctx.currentTime;
      if (kind === "engine") sEngineHit(G, t); else if (kind === "creak") sCreak(G, t, 1.6 + Math.random() * 0.8, 0.5, pan || 0);
      else if (kind === "wind") sWindRoar(G, t, 2.2, 0.35); else if (kind === "fire") sFireWhoosh(G, t, 0.7); else if (kind === "decomp") sDecomp(G, t, 0.8);
      else if (kind === "wingOff") sBreakOff(G, t, "wing"); else if (kind === "tailOff") sBreakOff(G, t, "tail");
      count("struct_" + kind);
    },
    enemyGun(x, y, z) { if (!ok()) return; const q = panOf(x, y, z); if (q.d >= AI_CUTOFF) return; sEnemyGun(G, ctx.currentTime + distModel(q.d, 320).delay, q.d, q.pan, true); count("enemyGun"); },
    // 1.5.8: a B-17 (or a piece of one) hits the ground thousands of units below: a low, muffled thump + long rumble, delayed by the distance (d / 228.7 u/s, capped at 7 s), quiet but never lost
    crash(x, y, z, size) {
      if (!ok()) return; const q = panOf(x, y, z), sz = Math.max(0.3, size || 1), delay = Math.min(7, q.d / U_PER_S), gain = 0.9 / (1 + q.d / 3500), lp = 300 + 900 * Math.exp(-q.d / 3000);
      DM = { d: q.d, delay, gain, lp }; const t = ctx.currentTime + delay;
      try { thump(G, t, 52, 19, 1.5 + sz, 1.25 * sz, q.pan, 420); noiseHit(G, t, 2.6 + 1.6 * sz, 150, 0.4, 0.95 * sz, q.pan, 380, 0.06); noiseHit(G, t + 0.22, 1.3, 320, 0.5, 0.45 * sz, q.pan, 600, 0.02); } finally { DM = null; }
      count("crash");
    },
    boom(x, y, z, big) { if (!ok()) return; const q = panOf(x, y, z); withDM(q.d, big ? 900 : 650, (m) => sBoom(G, ctx.currentTime + m.delay, q.d, q.pan, big)); count("boom"); },
    rocket(x, y, z) { if (!ok()) return; const q = panOf(x, y, z); withDM(q.d, 420, (m) => sRocket(G, ctx.currentTime + m.delay, q.d, q.pan)); count("rocket"); },
    flak(x, y, z) { if (!ok()) return; const q = panOf(x, y, z); withDM(q.d, 700, (m) => sFlak2(G, ctx.currentTime + m.delay, q.d, q.pan)); count("flak"); },
    fallStart(cause) { if (!ok()) return; sFallStart(G, ctx.currentTime); count("fall"); },
    bell() { if (!ok()) return; sBell(G, ctx.currentTime); count("bell"); },
    bail() { if (!ok()) return; sBail(G, ctx.currentTime); count("bail"); },
    chuteOpen() { if (!ok()) return; sChuteOpen(G, ctx.currentTime); count("chuteOpen"); },
    bombsAway() { if (!ok()) return; sBombsAway(G, ctx.currentTime); count("bombsAway"); },
    mute(b) { muted = !!b; if (ctx && G) G.master.gain.setTargetAtTime(b ? 0.0001 : 0.35, ctx.currentTime, 0.05); },
    results() { muted = false; if (ctx && G) { restoreGraph(G, ctx.currentTime); G.master.gain.setTargetAtTime(0.35, ctx.currentTime, 0.6); } count("results"); },
    earRing(depth) { if (!ok()) return false; const r = earRingNow(G, ctx.currentTime + 0.01, depth); if (r) count("earRing"); return r; },
    reset() { muted = false; stats.ringsThisRun = 0; passes.clear(); if (ctx && G) restoreGraph(G, ctx.currentTime); count("reset"); },
    // offline demo: the same synth graph rendered to a buffer (verification + a listenable sample)
    renderSample(sec, part) {
      if (part === "dist") return renderDist(sec);
      if (part === "clip154") return renderClip154(sec);
      if (part === "bailout") return renderBailout(sec);
      if (part === "hits141") return renderHits141(sec);
      if (part === "gun153" || part === "gun153x") return renderGun153(sec, part === "gun153x"); if (part === "hits153") return renderHits153(sec); if (part === "hits153x") return renderHits153(sec, true);
      sec = sec || 28;
      const oc = new OAC(2, Math.floor(44100 * sec), 44100);
      const g = Graph(oc); g.master.gain.value = 0.8;
      // 0–1.5 s drone + wind alone; 1.5 s our guns (1.2 s burst); 3.0 s box gunners around us;
      // 4.6 s 109 fly-by left→right with its cannon burst just before; 6.2 s rounds hitting our ship;
      // 6.8 s #3 engine hit: sputters, then winds down from 8.2 s; 9.0/9.8 s flak crumps; 10.6 s a 109 explodes.
      for (let k = 0; k < 30; k++) sGun(g, 1.5 + k / 26, 0, k % 2 ? 0.25 : -0.25, true);
      for (let k = 0; k < 40; k++) { const d = 60 + Math.random() * 500; sGun(g, 3.0 + Math.random() * 1.6, d, Math.random() * 2 - 1, false); }
      sEnemyGun(g, 4.1, 250, -0.6);
      sWhoosh(g, 4.6, -0.8, 0.8, 0.8, 300, 1.3);
      for (let k = 0; k < 5; k++) sHitOwn(g, 6.2 + k * 0.09, k === 2 ? "cannon" : "mg");
      const E = g.eng[2];
      for (let tt = 6.8; tt < 8.2; tt += 0.3 + Math.random() * 0.2) { E.g.gain.setValueAtTime(0.03, tt); E.g.gain.setValueAtTime(0.25, tt + 0.08); E.saw.frequency.setValueAtTime(E.f0 * 0.93, tt); E.saw.frequency.linearRampToValueAtTime(E.f0, tt + 0.3); }
      engineAt(g, 2, 8.2, "out");
      sFlak(g, 9.0, 320, 0.4); sFlak(g, 9.8, 180, -0.3);
      sBoom(g, 10.6, 400, 0.5, true);
      if (sec > 12.5) { // 1.3.8: 12.2 s flak barrage walking in (the last one close: shrapnel on the skin);
        // 16.0 s shot down: falling wind + howl, engines die; 19.6 s bail-out bell; 21.2 s out; 22.6 s canopy; distant fight fades
        const fl = [[12.2, 600, -0.5], [12.7, 420, 0.3], [13.1, 300, 0.6], [13.6, 200, -0.2], [14.0, 120, 0.4], [14.4, 60, -0.3], [14.9, 30, 0.2]];
        for (const [t, d, p] of fl) sFlak(g, t, d, p);
        sHitOwn(g, 14.95, "flak");
        if (sec > 16) {
          sFallStart(g, 16.0);
          for (let i = 0; i < 4; i++) engineAt(g, i, 16.3 + i * 0.9, "out");
          sBell(g, 19.6); sBail(g, 21.2); sChuteOpen(g, 22.6);
          for (let tt = 23.2; tt < sec - 0.5; tt += 0.35 + Math.random() * 0.5) { const d = 300 + (tt - 23) * 160; for (let q = 0; q < 3; q++) sGun(g, tt + q * 0.07, d, (Math.random() - 0.5) * 0.6, false); }
          g.distDrone.gain.setValueAtTime(0.06, 23); g.distDrone.gain.linearRampToValueAtTime(0.012, sec);
          sFlak(g, 24.5, 900, 0.5); sFlak(g, 26.2, 1300, -0.4);
        }
      }
      return oc.startRendering();
    },
  };
  // 1.5.4 offline distance test: the same .50 burst, flak and 20 mm at 100/500/1500/4000 u (each section 8 s apart); the table of model values is returned in DIST_TABLE
  const DIST_D = [100, 500, 1500, 4000], DIST_TABLE = [];
  function renderDist(sec) {
    sec = sec || 86; DIST_TABLE.length = 0;
    const oc = new OAC(2, Math.floor(44100 * sec), 44100), g = Graph(oc); g.master.gain.value = 0.12; // low master so the compressor/clipper stay out of the way and the level ratios between distances are readable
    for (const p of [g.busE.gain, g.wind.gain, g.rumble.gain, g.distDrone.gain]) p.value = 0; // beds off: only the test sources are heard
    DIST_D.forEach((d, i) => {
      const rows = [];
      [["gun", 260], ["flak", 700], ["cannon", 320]].forEach(([src, ref], j) => {
        const slot = 1 + (i * 3 + j) * 7, fire = slot + 1; // each source in its own 7 s slot: it "fires" at slot+1 s; an own-gun click marks the slot start (own guns are never delayed)
        sGun(g, slot, 0, 0, true);
        withDM(d, ref, (m) => {
          rows.push({ src, fire, ...m });
          if (src === "gun") for (let k = 0; k < 6; k++) sGun(g, fire + m.delay + k * 0.07, d, 0.5, false);
          else if (src === "flak") sFlak2(g, fire + m.delay, d, -0.5); else sEnemyGun(g, fire + m.delay, d, 0.2);
        });
      });
      DIST_TABLE.push({ d, rows });
    });
    return oc.startRendering();
  }
  // 1.5.4 clip-like demo: ~16 s of what the user's recording is (our own .50s streaming, flak thumps, contrail ambience) + the new holes bed and engine bed
  function renderClip154(sec) {
    sec = sec || 14;
    const oc = new OAC(2, Math.floor(44100 * sec), 44100), g = Graph(oc); g.master.gain.value = 0.8;
    let t = 0.3; while (t < sec - 0.3) { sGun(g, t + 0.003 + Math.random() * 0.006, 0, (Math.random() < 0.5 ? 0.25 : -0.25), true); t += 0.052 + Math.random() * 0.05; }
    for (const [ft, d, p] of [[2.1, 300, -0.4], [5.0, 160, 0.5], [8.5, 420, -0.2], [11.2, 220, 0.3]]) withDM(d, 700, (m) => sFlak2(g, ft + m.delay, d, p));
    g.holeWind.gain.setValueAtTime(0.0, 0); g.holeWind.gain.linearRampToValueAtTime(0.16, sec * 0.95);
    return oc.startRendering();
  }
  function renderBailout(sec) { // the bail-out video's soundtrack: t=0 shot down … fall 8 s, chute 15 s
    sec = sec || 23;
    const oc = new OAC(2, Math.floor(44100 * sec), 44100);
    const g = Graph(oc); g.master.gain.value = 0.8;
    sHitOwn(g, 0.0, "cannon"); sHitOwn(g, 0.12, "mg");
    sFallStart(g, 0.05);
    for (let i = 0; i < 4; i++) engineAt(g, i, 0.4 + i * 1.1, "out");
    for (let k = 0; k < 20; k++) sGun(g, 0.5 + Math.random() * 6, 80 + Math.random() * 400, Math.random() * 2 - 1, false);
    sBell(g, 4.2); sBail(g, 8.0); sChuteOpen(g, 9.3);
    for (let tt = 9.8; tt < sec - 0.4; tt += 0.35 + Math.random() * 0.5) { const d = 250 + (tt - 9.8) * 120; for (let q = 0; q < 3; q++) sGun(g, tt + q * 0.07, d, (Math.random() - 0.5) * 0.6, false); }
    g.distDrone.gain.setValueAtTime(0.06, 9.5); g.distDrone.gain.linearRampToValueAtTime(0.01, sec);
    sFlak(g, 12.5, 700, 0.4); sFlak(g, 16.0, 1000, -0.4); sFlak(g, 19.5, 1400, 0.2);
    return oc.startRendering();
  }
  // 1.4.1 demo: 0.6–7.4 s our ship taking hits (single MG strikes, a pair, a 20 mm cannon shell, a friendly .50, a
  // flak burst close aboard); 8.2 s BOMBS AWAY (shackles, the lift); 10.5 s bail-out; 11.8 s canopy open; then ~16 s
  // drifting — the wind dies away, the box's drone recedes, far-off flak thumps and distant gunfire.
  function renderHits141(sec) {
    sec = sec || 28;
    const oc = new OAC(2, Math.floor(44100 * sec), 44100);
    const g = Graph(oc); g.master.gain.value = 0.8;
    const H = [[0.6, "mg"], [1.3, "mg"], [1.42, "mg"], [2.2, "cannon"], [3.1, "mg"], [3.5, "self"], [4.3, "mg"], [4.38, "mg"], [4.47, "mg"], [5.2, "cannon"], [6.2, "engine"]];
    for (const [t, k] of H) sHitOwn(g, t, k);
    sFlak(g, 6.9, 40, 0.3); sHitOwn(g, 6.95, "flak");
    sBombsAway(g, 8.2);
    sBail(g, 10.5); sChuteOpen(g, 11.8);
    const t0 = 12.6;
    for (let tt = t0; tt < sec - 0.2; tt += 0.25) { const ct = tt - 11.8; chuteBed(g, tt, ct, 200 + ct * 70); }
    for (let tt = t0 + 0.5; tt < sec - 3; tt += 0.9 + Math.random() * 1.6) { const d = 260 + (tt - t0) * 90; if (d < 1500) for (let q = 0; q < 3; q++) sGun(g, tt + q * 0.07, d, (Math.random() - 0.5) * 0.6, false); }
    for (const [t, d, p] of [[14.0, 900, 0.5], [16.8, 1400, -0.6], [19.1, 1100, 0.2], [22.4, 1800, -0.3], [25.0, 1600, 0.6]]) if (t < sec - 1) sFarFlak(g, t, d, p);
    return oc.startRendering();
  }

  // 1.5.3 demo / verification mix: drone bed + airframe hits, a 190 strafing pass, flak (distant → close), structural damage. LABELS gives the timeline.
  const LABELS153 = [[0.6, "MG hit"], [1.6, "MG pair"], [2.7, "20 mm cannon hit"], [3.9, "Fw 190 strafing pass (cannon + MG)"], [6.6, "ricochet MGs"], [8.0, "flak: distant crump (900 u)"], [9.6, "flak: far (500 u)"], [11.2, "flak: mid (200 u)"], [12.9, "flak: CLOSE burst + shrapnel + ear-ring"], [16.2, "flak: very close + fragments hit skin"], [19.6, "engine hit: sputter + grind"], [21.4, "wing / tail creak"], [23.4, "wind roar through holes"], [25.2, "fire whoosh"], [26.8, "decompression"], [28.2, "WING tears off"], [31.0, "TAIL tears off"], [33.6, "ROCKET: launch + flight whoosh"], [36.0, "ROCKET: impact on airframe"]];
  function renderHits153(sec, noBed) {
    sec = sec || 39;
    const oc = new OAC(2, Math.floor(44100 * sec), 44100);
    const g = Graph(oc); g.master.gain.value = 0.8;
    if (noBed) { g.busE.gain.value = 0; g.wind.gain.value = 0; g.rumble.gain.value = 0; }
    hitMG(g, 0.6, -0.3, 1, false);
    sStrafe(g, 1.6, 2, false, 0.2, 0.3);
    hitCannon(g, 2.7, 0.4, 1);
    sStrafe(g, 3.9, 12, true, -0.8, 0.8);
    for (const [t, p] of [[6.6, -0.5], [6.95, 0.1], [7.2, 0.6]]) hitMG(g, t, p, 1, true);
    sFlak2(g, 8.0, 900, 0.4); sFlak2(g, 9.6, 500, -0.5); sFlak2(g, 11.2, 200, 0.2); sFlak2(g, 12.9, 70, -0.3);
    sFlak2(g, 16.2, 22, 0.1); sHitOwn2(g, 16.3, "flak", 0.1);
    sEngineHit(g, 19.6); sCreak(g, 21.4, 1.8, 0.6, -0.3); sCreak(g, 22.0, 1.6, 0.5, 0.4); sWindRoar(g, 23.4, 2.2, 0.4);
    sFireWhoosh(g, 25.2, 0.7); sDecomp(g, 26.8, 0.8); sBreakOff(g, 28.2, "wing"); sBreakOff(g, 31.0, "tail");
    sRocket(g, 33.6, 260, -0.4); sRocketImpact(g, 36.0, 8, 0.2);
    return oc.startRendering();
  }

  // 1.5.3 gun verification mix: 0.5–3.5 s our twin .50s (12.5 Hz per gun, alternating), 4–7 s a strafing pass on the airframe (cannon + MG), 7.5–10.5 s box gunners at 80–500 u
  function renderGun153(sec, noBed) {
    sec = sec || 11;
    const oc = new OAC(2, Math.floor(44100 * sec), 44100);
    const g = Graph(oc); g.master.gain.value = 0.8;
    if (noBed) { g.busE.gain.value = 0; g.wind.gain.value = 0; g.rumble.gain.value = 0; }
    for (let k = 0; k < 75; k++) { sGun(g, 0.5 + k / 25, 0, k % 2 ? 0.25 : -0.25, true); if (k % 4 === 0) sBrass(g, 0.7 + k / 25, 0.3); }
    sStrafe(g, 4.0, 22, true, -0.7, 0.7); sStrafe(g, 5.6, 18, true, 0.6, -0.6);
    for (let k = 0; k < 90; k++) { const d = 80 + Math.random() * 420; sGun(g, 7.5 + Math.random() * 3.0, d, Math.random() * 2 - 1, false); }
    return oc.startRendering();
  }
  API.hits153Labels = LABELS153;
  window.FGAudio = API;
  const unlock = () => API.unlock();
  ["pointerdown", "touchstart", "mousedown", "keydown"].forEach((ev) => window.addEventListener(ev, unlock, { passive: true }));
})();
