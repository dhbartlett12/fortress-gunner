/* Fortress Gunner 1.5.0 — per-part combat model (pure: no DOM, no Three). Used by game.js (window.FGCombat) and by
   playtest/combat_mc.js (node). Local B-17 frame: nose +Z, +Y up, game +X = PORT (so starboard = −X); 1 u = 1.5 m. */
(function (root) {
  "use strict";
  const U_PER_YD = 0.9144 / 1.5; // 1 yd in game units
  const toYd = (u) => u / U_PER_YD;

  // ===== weapons (spec §3). k = calibration: component damage per hit = (bs·sm + bp·pm + he·0.5) · k · rangeFactor
  const GUNS = {
    m2:    { id: "m2",    name: "AN/M2 .50",   rpm: 800, bs: 4,  bp: 8, he: 0,  inc: 3,  hull: 0.5, k: 0.0125, full: 600, half: 1000, junk: 1200 },
    mg131: { id: "mg131", name: "MG 131 13mm", rpm: 900, bs: 5,  bp: 7, he: 0,  inc: 2,  hull: 0.6, k: 0.0150, full: 600, half: 1000, junk: 1200 },
    mg151: { id: "mg151", name: "MG 151/20",   rpm: 700, bs: 18, bp: 4, he: 16, inc: 6,  hull: 4.5, k: 0.20, full: 400, half: 700,  junk: 900 },
    mk108: { id: "mk108", name: "MK 108 30mm", rpm: 650, bs: 55, bp: 3, he: 50, inc: 10, hull: 20,  k: 0.19,  full: 250, half: 400,  junk: 500 },
    wgr21: { id: "wgr21", name: "WGr.21",      rpm: 1,   bs: 80, bp: 2, he: 70, inc: 15, hull: 40,  k: 0.22,  full: 500, half: 800,  junk: 1200 },
  };
  // range falloff (damage AND hit chance): full → 1, half-way point → 0.5, junk range → 0.1, beyond → fades to 0
  function rangeFactor(g, yd) {
    if (yd <= g.full) return 1;
    if (yd <= g.half) return 1 - 0.5 * (yd - g.full) / (g.half - g.full);
    if (yd <= g.junk) return 0.5 - 0.4 * (yd - g.half) / (g.junk - g.half);
    return Math.max(0, 0.1 - 0.1 * (yd - g.junk) / (g.junk * 0.5));
  }

  // ===== B-17 hitboxes (local frame). Same IDs the spec lists; first box along the ray wins =====
  const ENG_X = [-5.6, -3.04, 3.04, 5.6];             // game engine index 0..3 (x), starboard outer → port outer
  const ENG_ID = ["engine_4", "engine_3", "engine_2", "engine_1"]; // spec ids by game index (starboard = −X)
  const ID_ENG = { engine_1: 3, engine_2: 2, engine_3: 1, engine_4: 0 };
  const BOXES = [];
  const box = (id, lo, hi) => BOXES.push({ id, lo, hi, prop: id.startsWith("prop_") });
  box("nose", [-0.75, -0.75, 5.3], [0.75, 0.65, 6.6]);
  box("cockpit", [-0.8, -0.5, 3.0], [0.8, 0.95, 5.3]);
  box("fuselage_fwd", [-0.7, -0.7, 1.0], [0.7, 0.68, 3.0]);
  box("fuselage_mid", [-0.7, -0.7, -2.0], [0.7, 0.68, 1.0]);
  box("fuselage_aft", [-0.6, -0.65, -4.6], [0.6, 0.6, -2.0]);
  box("tail", [-0.5, -0.55, -6.6], [0.5, 0.55, -4.6]);
  box("empennage", [-3.4, -0.3, -6.4], [3.4, 0.15, -5.0]);   // horizontal stabiliser
  box("empennage", [-0.2, 0.3, -7.0], [0.2, 3.0, -4.7]);     // fin
  for (const s of [1, -1]) { // +1 = port (+X), −1 = starboard (−X); spec "l" = port
    const L = s > 0 ? "l" : "r", x = (a, b) => (s > 0 ? [a, b] : [-b, -a]);
    let X = x(0.8, 2.4); box("wingroot_" + L, [X[0], -0.4, -0.45], [X[1], 0.2, 2.37]);
    X = x(2.4, 4.2); box("wing_" + L + "_inboard", [X[0], -0.4, -0.45], [X[1], 0.2, 2.37]);
    X = x(4.2, 8.2); box("wing_" + L + "_outboard", [X[0], -0.4, -0.15], [X[1], 0.2, 1.6]);
    X = x(0.7, 1.2); box("gun_cheek_" + L, [X[0], -0.2, 4.9], [X[1], 0.3, 5.5]);
    X = x(0.8, 1.3); box("gun_waist_" + L, [X[0], -0.1, -3.3], [X[1], 0.5, -2.3]);
  }
  for (let k = 0; k < 4; k++) {
    const cx = ENG_X[k], id = ENG_ID[k];
    box(id, [cx - 0.62, -0.81, 0.9], [cx + 0.62, 0.43, 3.6]);
    box("prop_" + (4 - k), [cx - 1.05, -1.24, 3.6], [cx + 1.05, 0.86, 3.85]);
  }
  box("gun_top", [-0.5, 0.8, 2.3], [0.5, 1.7, 3.4]);
  box("gun_ball", [-0.5, -1.7, -1.0], [0.5, -0.8, 0.1]);
  box("gun_chin", [-0.4, -1.1, 5.4], [0.4, -0.7, 6.5]);
  box("gun_nose", [-0.3, -0.2, 6.5], [0.3, 0.3, 6.9]);
  box("gun_tail", [-0.4, -0.1, -7.3], [0.4, 0.5, -6.6]);

  // (struct_mult, pen_mult) per hitbox family (spec §4); hull share = how much of a hit also loads hull_integrity
  const MULT = {
    cockpit: [0.4, 1.6, 0.6], nose: [0.6, 1.2, 0.8], engine: [0.3, 2.0, 0.25], prop: [0.15, 0.6, 0.1],
    wingroot: [1.8, 0.8, 0.8], wing_in: [1.2, 0.8, 0.7], wing_out: [1.0, 0.6, 0.5], fuel: [0.5, 1.0, 0.5],
    fuselage: [1.0, 0.6, 1.0], tail: [0.9, 0.6, 0.9], gun: [0.4, 1.4, 0.3],
  };
  const TUNE_C = { fireExt: 0.13, hullMul: 0.75, pOut151: 0.35 }; // engine fire put out by crew / extinguisher: per-second chance (feathered engines burn out faster)
  function famOf(id) {
    if (id.startsWith("engine_")) return "engine";
    if (id.startsWith("prop_")) return "prop";
    if (id.startsWith("wingroot")) return "wingroot";
    if (id.endsWith("_inboard")) return "wing_in";
    if (id.endsWith("_outboard")) return "wing_out";
    if (id.startsWith("fuselage")) return "fuselage";
    if (id.startsWith("gun_")) return "gun";
    if (id === "tail" || id === "empennage") return "tail";
    return id; // cockpit, nose
  }
  const FAM = {}; for (const b of BOXES) FAM[b.id] = famOf(b.id);

  // ray vs the box set, in the ship's local frame. Returns the nearest {id, t, x, y, z} with 0 ≤ t ≤ maxT, or null.
  function rayBoxes(ox, oy, oz, dx, dy, dz, maxT, withProps) {
    let best = null, bt = maxT;
    for (let i = 0; i < BOXES.length; i++) {
      const b = BOXES[i], lo = b.lo, hi = b.hi;
      if (!withProps && b.prop) continue; // 1.5.0: a prop disc is open air to a round — it only counts when asked for
      let t0 = 0, t1 = bt;
      // x
      if (dx > -1e-9 && dx < 1e-9) { if (ox < lo[0] || ox > hi[0]) continue; }
      else { let a = (lo[0] - ox) / dx, c = (hi[0] - ox) / dx; if (a > c) { const q = a; a = c; c = q; } if (a > t0) t0 = a; if (c < t1) t1 = c; if (t0 > t1) continue; }
      if (dy > -1e-9 && dy < 1e-9) { if (oy < lo[1] || oy > hi[1]) continue; }
      else { let a = (lo[1] - oy) / dy, c = (hi[1] - oy) / dy; if (a > c) { const q = a; a = c; c = q; } if (a > t0) t0 = a; if (c < t1) t1 = c; if (t0 > t1) continue; }
      if (dz > -1e-9 && dz < 1e-9) { if (oz < lo[2] || oz > hi[2]) continue; }
      else { let a = (lo[2] - oz) / dz, c = (hi[2] - oz) / dz; if (a > c) { const q = a; a = c; c = q; } if (a > t0) t0 = a; if (c < t1) t1 = c; if (t0 > t1) continue; }
      if (t0 < bt) { bt = t0; best = { id: b.id, t: t0, x: ox + dx * t0, y: oy + dy * t0, z: oz + dz * t0 }; }
    }
    return best;
  }
  // nearest box to a local point (0 if inside) — used to classify strikes found by the rendered-mesh raycast
  function boxAt(x, y, z) {
    let best = null, bd = 1e9;
    for (let i = 0; i < BOXES.length; i++) {
      const b = BOXES[i];
      const ex = Math.max(b.lo[0] - x, 0, x - b.hi[0]), ey = Math.max(b.lo[1] - y, 0, y - b.hi[1]), ez = Math.max(b.lo[2] - z, 0, z - b.hi[2]);
      const d = ex * ex + ey * ey + ez * ez;
      if (d < bd - 1e-9) { bd = d; best = b; }
    }
    return best ? best.id : "fuselage_mid";
  }
  function boxCenter(id) { // centre of the (first) box of that id
    for (const b of BOXES) if (b.id === id) return [(b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2, (b.lo[2] + b.hi[2]) / 2];
    return [0, 0, 0];
  }

  // ===== aim-part choice (spec §4 weights) =====
  const W_HEADON = [ // [weight, ids]
    [22, ["cockpit", "cockpit", "nose"]],
    [28, ["engine_1", "engine_2", "engine_3", "engine_4", "prop_1", "prop_2", "prop_3", "prop_4"]],
    [20, ["wingroot_l", "wingroot_r", "wing_l_inboard", "wing_r_inboard"]],
    [18, ["fuselage_fwd", "fuselage_mid"]],
    [12, ["wing_l_outboard", "wing_r_outboard", "tail", "gun_top", "gun_chin"]],
  ];
  const W_BEAM = [
    [35, ["wing_l_inboard", "wing_r_inboard", "wing_l_outboard", "wing_r_outboard", "wingroot_l", "wingroot_r"]],
    [25, ["fuselage_fwd", "fuselage_mid", "fuselage_aft"]],
    [20, ["tail", "empennage", "gun_waist_l", "gun_waist_r", "gun_tail", "gun_top", "gun_ball"]],
    [15, ["engine_1", "engine_2", "engine_3", "engine_4"]],
    [5, ["cockpit"]],
  ];
  const W_HAMMER = [ // Fw 190: the wing root between the inboard engine and the fuselage
    [38, ["wingroot_l", "wingroot_r"]],
    [20, ["wing_l_inboard", "wing_r_inboard", "engine_2", "engine_3"]],
    [18, ["fuselage_aft", "fuselage_mid", "tail", "empennage"]],
    [14, ["gun_tail", "gun_ball", "gun_waist_l", "gun_waist_r", "gun_top"]],
    [10, ["engine_1", "engine_4", "wing_l_outboard", "wing_r_outboard"]],
  ];
  // role: "slash" (109 from ahead, wants cockpit / engine_3 / inboard root), "hammer" (190), "beam"
  function pickAimBox(mode, rng) {
    rng = rng || Math.random;
    if (mode === "slash") {
      const r = rng();
      if (r < 0.34) return "cockpit";
      if (r < 0.70) return "engine_3";
      if (r < 0.80) return rng() < 0.5 ? "wingroot_r" : "wingroot_l";
    }
    const tab = mode === "hammer" ? W_HAMMER : mode === "beam" ? W_BEAM : W_HEADON;
    let sum = 0; for (const t of tab) sum += t[0];
    let r = rng() * sum;
    for (const t of tab) { r -= t[0]; if (r <= 0) return t[1][(rng() * t[1].length) | 0]; }
    return "fuselage_mid";
  }

  // ===== ship damage state (spec §5) =====
  const STATIONS = ["chin", "nose", "cheek_l", "cheek_r", "top", "ball", "waist_l", "waist_r", "tail"];
  function newShip(rng) {
    rng = rng || Math.random;
    const gun = {}; for (const s of STATIONS) gun[s] = 25;
    return {
      hull: 100, crew: 100, pilotCrit: 0,
      eng: [0, 1, 2, 3].map(() => ({ hp: 40, out: false, fire: false, fireT: 0, leak: 0 })),
      wr: [50, 50],                       // wingroot port (+X) / starboard (−X)
      fuel: [0, 1].map(() => ({ hp: 30, seal: 2 + ((rng() * 2) | 0), fire: false, fireT: 0 })),
      tail: 35, gun, controls: 40, oxygen: 20, oxyAt: -1, ctlJitter: 0,
      fireMax: 0, t: 0, acc: 0,
      out: false, outReason: null, outAt: -1, destroyed: false, destroyReason: null,
      tally: {},                           // box id → hits taken
      hits: 0,
    };
  }
  function engOutCount(sd) { let n = 0; for (const e of sd.eng) if (e.out) n++; return n; }
  function health(sd) { // single 0–100 "structural look" for the existing damage visuals / HUD bar (derived, not a pool)
    const wr = Math.min(sd.wr[0], sd.wr[1]) / 50;
    const h = 0.55 * sd.hull / 100 + 0.15 * Math.max(0, wr) + 0.10 * Math.max(0, sd.tail) / 35 + 0.10 * Math.max(0, sd.crew) / 100 + 0.10 * (1 - engOutCount(sd) / 4);
    return Math.max(0, Math.min(100, 100 * h));
  }
  const isHE = (g) => g.he > 0;

  // One round (or a pellet of a burst) that reached hitbox `id`. opts: rf (range factor, default 1), rng, scale, own (friendly fire)
  // Returns { ev: [...events], dmg }.
  function applyHit(sd, id, gunId, opts) {
    opts = opts || {};
    const g = GUNS[gunId], rng = opts.rng || Math.random, rf = opts.rf == null ? 1 : opts.rf, ev = [];
    if (sd.destroyed) return { ev, dmg: 0 };
    const fam = FAM[id] || "fuselage", M = MULT[fam];
    const base = (g.bs * M[0] + g.bp * M[1] + g.he * 0.5) * g.k * rf * (opts.scale || 1);
    let dmg = base;
    sd.hits++; sd.tally[id] = (sd.tally[id] || 0) + 1;
    sd.hull = Math.max(0, sd.hull - g.hull * M[2] * rf * (opts.scale || 1) * TUNE_C.hullMul);
    const he = isHE(g);
    if (fam === "engine" || fam === "prop") {
      const k = ID_ENG[fam === "engine" ? id : "engine_" + id.slice(5)];
      const e = sd.eng[k];
      if (!e.out) {
        e.hp -= fam === "prop" ? dmg * 0.5 : dmg;
        if (fam === "engine") {
          let pOut = gunId === "m2" || gunId === "mg131" ? 0.08 : gunId === "mg151" ? TUNE_C.pOut151 : gunId === "mk108" ? 0.7 : 1;
          let pFire = (gunId === "mg151" ? 0.30 : gunId === "mk108" ? 0.5 : gunId === "wgr21" ? 0.7 : g.inc / 100 * 0.5) * (opts.fireMul == null ? 1 : opts.fireMul);
          const pLeak = gunId === "m2" || gunId === "mg131" ? 0.2 : 0.1;
          if (rng() < pOut * rf) { e.hp = 0; ev.push({ t: "engine_out", i: k, how: "hit" }); }
          else if (rng() < pFire * rf && !e.fire) { e.fire = true; e.fireT = 0; ev.push({ t: "engine_fire", i: k }); }
          else if (!e.leak && rng() < pLeak * rf) { e.leak = 20 + rng() * 20; ev.push({ t: "oil_leak", i: k }); }
        }
        if (e.hp <= 0 && !e.out) { e.out = true; e.hp = 0; ev.push({ t: "engine_out", i: k, how: "dmg" }); }
      }
    } else if (fam === "cockpit") {
      sd.crew = Math.max(0, sd.crew - dmg * 1.2);
      const pCrit = he ? 0.35 : 0.05;
      if (rng() < pCrit * rf && sd.pilotCrit < 2) { sd.pilotCrit++; sd.crew = Math.min(sd.crew, 100 - 50 * sd.pilotCrit); ev.push({ t: "pilot_crit", n: sd.pilotCrit }); }
      if (rng() < (he ? 0.2 : 0.03)) damageGun(sd, "nose", dmg * 0.5, ev);
    } else if (fam === "nose") {
      if (rng() < 0.3) damageGun(sd, rng() < 0.5 ? "chin" : "nose", dmg, ev);
    } else if (fam === "wingroot") {
      const s = id.endsWith("_l") ? 0 : 1;
      sd.wr[s] = Math.max(0, sd.wr[s] - dmg);
      if (sd.wr[s] <= 0 && !sd.destroyed) ev.push({ t: "wing_fold", side: s });
      if (rng() < 0.3) fuelHit(sd, s, gunId, rf * (opts.fireMul == null ? 1 : opts.fireMul), rng, ev, dmg * 0.5);
    } else if (fam === "wing_in" || fam === "wing_out") {
      const s = id.startsWith("wing_l") ? 0 : 1;
      sd.wr[s] = Math.max(0, sd.wr[s] - dmg * (fam === "wing_in" ? 0.5 : 0.2));
      if (rng() < (fam === "wing_in" ? 0.4 : 0.3)) fuelHit(sd, s, gunId, rf * (opts.fireMul == null ? 1 : opts.fireMul), rng, ev, dmg);
    } else if (fam === "fuselage") {
      if (rng() < (he ? 0.15 : 0.04)) { sd.controls = Math.max(0, sd.controls - dmg * 1.5 - 1); sd.ctlJitter = 1; ev.push({ t: "controls" }); }
      if (id !== "fuselage_aft" && rng() < (he ? 0.12 : 0.04)) { sd.oxygen = Math.max(0, sd.oxygen - dmg * 1.5 - 0.5); if (sd.oxygen <= 0 && sd.oxyAt < 0) { sd.oxyAt = sd.t + 30 + rng() * 30; ev.push({ t: "oxygen" }); } }
      if (id === "fuselage_fwd" && he && rng() < 0.15) damageGun(sd, "top", dmg * 0.6, ev);
    } else if (fam === "tail") {
      sd.tail = Math.max(0, sd.tail - dmg);
      if (rng() < (he ? 0.12 : 0.03)) { sd.controls = Math.max(0, sd.controls - dmg * 1.2); ev.push({ t: "controls" }); }
    } else if (fam === "gun") {
      damageGun(sd, id.slice(4), dmg, ev);
    }
    // incendiary → fire anywhere near fuel/engine is handled above; generic ignition in fuselage is just smoke
    sd.last = id;
    return { ev, dmg };
  }
  function damageGun(sd, st, dmg, ev) {
    if (sd.gun[st] == null || sd.gun[st] <= 0) return;
    sd.gun[st] = Math.max(0, sd.gun[st] - dmg);
    if (sd.gun[st] <= 0) ev.push({ t: "gun_dead", st });
  }
  function fuelHit(sd, s, gunId, rf, rng, ev, dmg) {
    const f = sd.fuel[s];
    const mg = gunId === "m2" || gunId === "mg131";
    if (mg && f.seal > 0) { f.seal--; return; } // self-sealing tank: the first 2–3 .50s do nothing
    f.hp = Math.max(0, f.hp - dmg);
    const p = gunId === "mg151" ? 0.25 : gunId === "mk108" ? 0.5 : gunId === "wgr21" ? 0.8 : 0.08;
    if (!f.fire && rng() < p * rf) { f.fire = true; f.fireT = 0; ev.push({ t: "fuel_fire", side: s }); }
    else if (f.hp <= 0 && !f.fire && rng() < 0.5) { f.fire = true; f.fireT = 0; ev.push({ t: "fuel_fire", side: s }); }
  }

  // fires and leaks tick every 0.25 s (spec §7.5). Returns events.
  function tick(sd, dt, rng) {
    rng = rng || Math.random;
    const ev = [];
    if (sd.destroyed) return ev;
    sd.t += dt; sd.acc += dt;
    while (sd.acc >= 0.25) {
      sd.acc -= 0.25; const h = 0.25;
      let fm = 0;
      for (let k = 0; k < 4; k++) {
        const e = sd.eng[k];
        if (e.leak > 0 && !e.out) { e.leak -= h; if (e.leak <= 0) { e.out = true; e.hp = 0; ev.push({ t: "engine_out", i: k, how: "oil" }); } }
        if (e.fire) {
          e.fireT += h; fm = Math.max(fm, e.fireT);
          sd.hull -= 1.2 * h;
          if (e.out ? rng() < 0.45 * h : rng() < TUNE_C.fireExt * h) { e.fire = false; ev.push({ t: "fire_out", i: k }); } // feathered engines burn out; crew fights the rest
          else if (!e.out && e.fireT > 6 && rng() < 0.15 * h) { e.out = true; ev.push({ t: "engine_out", i: k, how: "fire" }); }
        }
      }
      for (let s = 0; s < 2; s++) {
        const f = sd.fuel[s];
        if (!f.fire) continue;
        f.fireT += h; fm = Math.max(fm, f.fireT);
        sd.hull -= (4 + 4 * Math.min(1, f.fireT / 12)) * h; // 4–8 hull HP/s
        const near = s === 0 ? [2, 3] : [0, 1], c = near[(rng() * 2) | 0];
        if (!sd.eng[c].out) { sd.eng[c].hp -= 1.5 * h; if (sd.eng[c].hp <= 0) { sd.eng[c].out = true; ev.push({ t: "engine_out", i: c, how: "cooked" }); } }
        if (rng() < 0.03 * h) { f.fire = false; ev.push({ t: "fire_out", side: s }); }
      }
      sd.fireMax = fm;
      sd.hull = Math.max(0, sd.hull);
      if (sd.oxyAt >= 0 && sd.t >= sd.oxyAt) sd.oxyDegrade = true;
      sd.ctlJitter = Math.max(0, sd.ctlJitter - 0.02);
    }
    return ev;
  }
  // leave-box (German score) and destroyed checks
  function status(sd) {
    const r = { leave: null, destroy: null };
    const eo = engOutCount(sd);
    if (sd.hull <= 0) r.destroy = "breakup";
    else if (sd.wr[0] <= 0 || sd.wr[1] <= 0) r.destroy = "wing_fold";
    else if (eo >= 3) r.destroy = "engines";
    else if (sd.fireMax > 30) r.destroy = "fire";
    if (eo >= 2) r.leave = "engines";
    else if (sd.pilotCrit >= 2 || sd.crew <= 0) r.leave = "pilots";
    else if (Math.min(sd.wr[0], sd.wr[1]) < 15) r.leave = "wingroot";
    else if (sd.fireMax > 8 && (sd.eng.some((e) => e.fire) || sd.fuel.some((f) => f.fire))) r.leave = "fire";
    else if (sd.controls < 10) r.leave = "controls";
    else if (sd.hull < 35) r.leave = "hull";
    else if (sd.tail <= 0) r.leave = "tail";
    return r;
  }

  // ===== fighters (spec §5 "phone-build shortcut") =====
  const FIGHTER = {
    "109": { hp: 10, cockpit: 1.85 }, "190": { hp: 14 }, p51: { hp: 12 },
  };
  const PART_MUL = { cockpit: 1.85, wingroot: 1.55, engine: 1.35, tail: 0.72, wing: 1.05, hull: 1 };
  function classifyFighterHit(lx, ly, lz) { // model-local metres-ish axes: spec §5
    const ax = Math.abs(lx), ay = Math.abs(ly);
    if (lz > 0.55 && ax < 0.45 && ay < 0.45) return "cockpit";
    if (ax > 0.35 && ax < 1.6 && ay < 0.35 && lz > -0.4 && lz < 0.9) return "wingroot";
    if (ax < 0.35 && ay < 0.4 && lz > -0.2 && lz < 1.1) return "engine";
    if (lz < -0.7) return "tail";
    if (ax > 0.9) return "wing";
    return "hull";
  }
  // .50 round (player / box gunner / Mustang) damage on a fighter of `type`; sturm = Sturmbock cowl armour
  function fighterRound(type, part, base, sturm) {
    let d = base * (PART_MUL[part] || 1) * (type === "190" ? 0.82 : 1);
    if (sturm && (part === "engine" || part === "hull" || part === "cockpit")) d *= 0.7;
    return d;
  }

  const API = {
    GUNS, BOXES, ENG_X, ENG_ID, ID_ENG, STATIONS, U_PER_YD, toYd, rangeFactor,
    rayBoxes, boxAt, boxCenter, pickAimBox, newShip, applyHit, tick, status, health, engOutCount,
    TUNE_C, PART_MUL, FIGHTER, classifyFighterHit, fighterRound, FAM,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.FGCombat = API;
})(typeof window !== "undefined" ? window : globalThis);
