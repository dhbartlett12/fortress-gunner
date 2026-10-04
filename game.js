/* Fortress Gunner — B-17 Sperry upper turret */
(function () {
  "use strict";

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d", { alpha: true });

  const scoreEl = document.getElementById("score");
  const waveEl = document.getElementById("wave");
  const killsEl = document.getElementById("kills");
  const healthFill = document.getElementById("healthfill");
  const heatFill = document.getElementById("heatfill");
  const calloutEl = document.getElementById("callout");
  const titleEl = document.getElementById("title");
  const gameoverEl = document.getElementById("gameover");
  const goEyebrow = document.getElementById("goEyebrow");
  const goTitle = document.getElementById("goTitle");
  const goStats = document.getElementById("goStats");

  const TAU = Math.PI * 2;
  // 1.3.2: vertical FOV 50° but capped so horizontal FOV ≤ ~82° on 2:1+ phones (less stretched
  // edge perspective that made level B-17s look banked). Passed to the Three.js camera every frame.
  let FOV = 50 * Math.PI / 180;
  function computeFov(w, h) {
    return Math.min(50 * Math.PI / 180, 2 * Math.atan(Math.tan(41 * Math.PI / 180) / Math.max(1, w / h)));
  }
  const CAM = { x: 0, y: 10.2, z: 6.5 };
  const YAW_MIN = -Infinity; // 1.3.3: unlimited spin (yaw wraps)
  const YAW_MAX = Infinity;
  // Cycle 127: allow look-down so plane-aim tracks diving fighters (was 0.04 → glued to lead pip)
  const PITCH_MIN = -1.55; // 1.3.5: ~−89°, straight down past our own wings/fuselage (no cap)
  const PITCH_MAX = 1.54;  // ~88°, straight overhead

  // --- Flight model (see FLIGHT_MODEL.md) ---
  // 1 world unit = 100 feet. Bomber-relative: +Z north (nose), +Y up, +X starboard.
  const FT_PER_UNIT = 100;
  const MPH_TO_UPS = (5280 / 3600) / FT_PER_UNIT; // ~0.014667 units/s per mph
  const B17_MPH = 180; // 1.5.7: formation TAS 180 mph (was 280)
  const B17_UPS = B17_MPH * MPH_TO_UPS;          // ~4.107 u/s north
  const BF109_MPH_CRUISE = 320;
  const BF109_MPH_MAX = 400;
  const BF109_UPS_MAX = BF109_MPH_MAX * MPH_TO_UPS; // ~5.867
  const BOMBER_AIM_Y = 8; // dorsal-turret aim height in world Y
  // Cloud scroll exaggerated ~2× for phone readability
  const CLOUD_SCROLL = B17_UPS * 2.2;
  // Cycle 136: visible .50 travel on phone — deflection required (was 420)
  const TRACER_UPS = 220;
  // 1.3.1: screen-space barrel tip positions for the compact muzzle flash (tuned to GLB guns)
  const MUZZLE_SX = [0.44, 0.56];
  const MUZZLE_SY = 0.80;
  // 1.3.2: real ballistic .50 rounds (box-relative u/s; world is ~12× visually scaled)
  const BULLET_UPS = 430;
  const BULLET_LIFE = 2.0; // 1.3.9: ~2 s, tracer burns out at the end (was 1.25)
  // 1.3.9 BALLISTICS for every round in the air (ours, the box gunners', the 109s'): gravity + quadratic
  // drag against the AIR, which in the box frame streams aft at the formation speed VF. 1 u ≈ 1.2 m.
  const BAL_G = 9.81 / 1.2;       // u/s²
  const BAL_K = 6.3e-4;           // 1/u: a round loses ~35% of its airspeed in 2 s
  const TRACER_BURN = 0.35;       // s: the tracer compound fades out over the last 0.35 s of life
  function balStep(o, dt) { // semi-implicit Euler, box frame; air velocity = (0, 0, -VF)
    const wx = o.vx, wy = o.vy, wz = o.vz + VF;
    const kw = BAL_K * Math.hypot(wx, wy, wz);
    o.vx -= kw * wx * dt; o.vy -= (kw * wy + BAL_G) * dt; o.vz -= kw * wz * dt;
    o.px = o.x; o.py = o.y; o.pz = o.z;
    o.x += o.vx * dt; o.y += o.vy * dt; o.z += o.vz * dt;
  }
  // Launch direction from (ox,oy,oz) at speed V whose ballistic path passes through (ax,ay,az).
  // Shoot, measure the miss where the round reaches the target range, move the aim point by the miss.
  const _bal = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  function solveBallistic(ox, oy, oz, ax, ay, az, V, iters, sdt) {
    const dx = ax - ox, dy = ay - oy, dz = az - oz, D = Math.hypot(dx, dy, dz) || 1;
    const fx = dx / D, fy = dy / D, fz = dz / D;
    let px = ax, py = ay, pz = az, t = D / V, err = 0;
    for (let it = 0; it < iters; it++) {
      const qx = px - ox, qy = py - oy, qz = pz - oz, L = Math.hypot(qx, qy, qz) || 1;
      const o = _bal; o.x = ox; o.y = oy; o.z = oz; o.vx = qx / L * V; o.vy = qy / L * V; o.vz = qz / L * V;
      t = 0;
      let along = 0, prevAlong = 0;
      while (t < 4) {
        balStep(o, sdt); t += sdt;
        prevAlong = along;
        along = (o.x - ox) * fx + (o.y - oy) * fy + (o.z - oz) * fz;
        if (along >= D) break;
      }
      const k = along > prevAlong ? (D - prevAlong) / (along - prevAlong) : 1; // interpolate back onto the target plane
      const hx = o.px + (o.x - o.px) * k, hy = o.py + (o.y - o.py) * k, hz = o.pz + (o.z - o.pz) * k;
      t -= sdt * (1 - k);
      const mx = hx - ax, my = hy - ay, mz = hz - az;
      err = Math.hypot(mx, my, mz);
      px -= mx; py -= my; pz -= mz;
    }
    const qx = px - ox, qy = py - oy, qz = pz - oz, L = Math.hypot(qx, qy, qz) || 1;
    return { ux: qx / L, uy: qy / L, uz: qz / L, t, err, cx: px - ax, cy: py - ay, cz: pz - az };
  }
  // Precomputed harmonisation table for OUR guns: for each look direction (box-frame yaw × pitch,
  // 10° grid) the aim-point correction that makes a BULLET_UPS round cross the sight line at 320 u.
  const CONV_R = 320;
  let AIMTAB_ = null;
  const AIMTAB_build = () => {
    const NY = 37, NP = 19, T = new Float32Array(NY * NP * 3);
    for (let j = 0; j < NP; j++) for (let i = 0; i < NY; i++) {
      const yw = (-180 + i * 10) * Math.PI / 180, pt = (-90 + j * 10) * Math.PI / 180;
      const fx = Math.sin(yw) * Math.cos(pt), fy = Math.sin(pt), fz = Math.cos(yw) * Math.cos(pt);
      const r = solveBallistic(0, 0, 0, fx * CONV_R, fy * CONV_R, fz * CONV_R, BULLET_UPS, 6, 1 / 120);
      const o = (j * NY + i) * 3; T[o] = r.cx; T[o + 1] = r.cy; T[o + 2] = r.cz;
    }
    return { NY, NP, T };
  };
  const AIMTAB_get = () => AIMTAB_ || (AIMTAB_ = AIMTAB_build());
  function aimCorr(fx, fy, fz) {
    const AIMTAB = AIMTAB_get(); // bilinear lookup → correction vector (u) to add to the 320 u aim point
    const yw = Math.atan2(fx, fz) * 180 / Math.PI, pt = Math.asin(Math.max(-1, Math.min(1, fy))) * 180 / Math.PI;
    const gi = (yw + 180) / 10, gj = (pt + 90) / 10;
    const i0 = Math.min(AIMTAB.NY - 2, Math.max(0, Math.floor(gi))), j0 = Math.min(AIMTAB.NP - 2, Math.max(0, Math.floor(gj)));
    const a = gi - i0, b = gj - j0, T = AIMTAB.T, NY = AIMTAB.NY;
    const out = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const v00 = T[(j0 * NY + i0) * 3 + c], v10 = T[(j0 * NY + i0 + 1) * 3 + c], v01 = T[((j0 + 1) * NY + i0) * 3 + c], v11 = T[((j0 + 1) * NY + i0 + 1) * 3 + c];
      out[c] = (v00 * (1 - a) + v10 * a) * (1 - b) + (v01 * (1 - a) + v11 * a) * b;
    }
    return out;
  }
  // time of flight of one of our rounds to range r (drag slows it: t = (e^{kr} − 1)/(kV))
  function ownTof(r) { return (Math.exp(BAL_K * r) - 1) / (BAL_K * BULLET_UPS); }
  const FIGHTER_R = 2.9; // hit radius at base mesh scale


  // ===== MISSION MODE 1.3.1 — combat box / bomb run / 44× Bf 109 =====
  const MISSION_DURATION = 240;       // 1.3.8: 4:00 to target (was 2:00)
  const MISSION_DOORS_AT = 90;        // 1.3.8: bay doors open on the bomb run, 1:30 before release
  const GEO_LEAD = 120;               // 1.3.8: extra route (s) vs the 2:00 layout — the town is still under us at 0:00
  const MISSION_RELEASE_AT = 0;       // bombs away over the target (0:00)
  const MISSION_EVAL_DELAY = 60;
  const TURN_BANK = 0.36;             // 1.3.6: ~21° bank in the turn for home
  const TURN_TOTAL = Math.PI / 2;     // ~90° wheel in the 60 s after bombs away      // 1.3.5: ~60 s after release (the box turns for home) → debrief
  const MISSION_BOMBERS = 19;         // including player
  const MISSION_N109 = 20, MISSION_N190 = 16, MISSION_NP51 = 20; // 1.5.0: three doctrines — 109 slash, 190 hammer, P-51 sheriff
  const MISSION_FIGHTERS = MISSION_N109 + MISSION_N190; // Axis only (Mustangs are not on the HUD count)
  const FIGHTERS_OUT_WIN = 8;         // 1.5.0: 8+ B-17s out of the box = Luftwaffe victory (reported on the results screen)
  const MISSION_WIN_DROPS = 15;
  const BF109_FLAT_MAX_MPH = 350;     // brief: flat max 350 mph
  const MISSION_MODE = true;          // default play mode
  // Tuning (1.3.1): engine loss rare & meaningful; box attrition ~2–6 on a good run
  const TUNE = {
    playerTargetFrac: 0.12,    // 1.3.8: 0.15 → 0.2; share of passes aimed at the player's ship (rest spread over box)
    playerHitChance: 0.5,     // burst actually connects
    playerDmg: 5.8,           // 1.4.0: 7 → 5.8 (tougher Fortress) //          // HP per connecting burst (1.3.8: no floor — 0.6 → 7 so a neglected ship can be shot down)
    playerEngineChance: 0.3,  // 1.3.6: share of connecting bursts that strike the engine they aimed at (was 0.02 random)
    engineAim: 0.5,           // 1.3.6: share of connecting bursts on a friendly that strike the aimed engine
    friendlyHitChance: 0.58,   // 1.3.6: 0.42 → 0.58 (fast slashing passes connect less often per pass count; idle must mostly fail)
    friendlyDmg: 30,          // 1.4.0: 34 → 30 (tougher Fortresses) //          // 1.3.6: 25 → 52; 1.3.7: 56 (spread box fire made idle runs sit right on the 15-drop line)
    openDmgMul: 1.0,          // 1.4.0: 1.2 → 1.0 — the opening head-on pass no longer kills two Fortresses in 13 s
    friendlyEngineChance: 0.14,
    cpuHitChance: 0.07,       // (legacy per-shot)
    cpuHitPerTracer: 0.029,   // 1.3.8: per yellow tracer at point-blank; ÷(1+(d/cpuHitD0)²)
    cpuHitD0: 150,           // 1.3.8: range (u) where the per-tracer hit chance halves (~250 m)
    cpuHitDmg: 2.0,          // 1.3.8: a striking yellow tracer = a few .50 rounds
    fHitTolAng: 0.005,       // 1.3.8: our rounds vs the rendered 109 — line may pass within ~0.3° of the skin (strike lands ON the skin)
    fRoundDmg: 3.3,          // 1.3.8: per .50 strike on a 109 (the exact mesh is a smaller target than the old 2.9u sphere)
    cpuTracerRate: 11,        // 1.3.7: tracers/s per twin mount (singles ×0.5–0.6); arcs now limit who can fire
    cpuBurstMul: 1, gerDmg: 0.14, gerPlayerMul: 0.5, // 1.5.1: global scale on German hits to B-17s (balance after the fighters got tougher/more accurate)
    burstsPerPass: 1, bursts190: 2,         // 1.4.0: 2 → 3 — tougher 109s press their attacks (balances the tougher Fortresses)
    open1Km: 4.0, open1Up: 1400,  // 1.3.5 opening: Staffel 1 start (km ahead, m above), diving
    open2Km: 5.5,
    dmgMul109: 1.0, dmgMul190: 1.35, dmgMulSturm: 2.05, // 1.5.6: md constants — German damage multiplier vs a B-17 by type (on top of gerDmg)
    fighterHp: 26, fighterHp190: 34, fighterHpP51: 12, quiet: 18, // 1.5.1: tougher fighters (a 109 takes ~6 hull hits), 18 s quiet opening
     // 1.5.0 (spec §5 phone shortcut): single pool per fighter
    p51Leash: 2300, p51TickHit: 0.075, p51HitDmg: 18, // 1.5.0: Mustang leash (u from the box centre), .50 damage per connecting Mustang burst
    aim109: [6.5, 4.5], aim190: [30, 13], p51Jit: 1, p190Player: 0.06, // aim error (mrad): per-burst bias σ, per-round σ
    burst109: [0.8, 1.6], burst190: [0.9, 1.5], // trigger time per burst (s)
               // 1.4.0: 8 → 10 — every kill is earned //            // .50 hits to down a 109 (1.3.8: 5 → 8 — one gunner no longer shreds a 109 with a single burst)
    engineSeverity: [0.5, 1.0],
    cpuRange: 600,          // 1.3.6: gunners open fire at ~900 m (1.3.4: 420 m)
    ffPlayerDmg: 0.9,       // HP per .50 round on a friendly B-17 (1.3.5: 1.3 → 0.9)
    ownDmg: 0.35,           // HP per .50 round into our own ship (floors at 1%)
    ownEngFire: 0.09,       // own engine fire per round (≥0.9 → out)
    ownTailFire: 0.07,      // own tail fire/smoke per round
    ffCpuDmg: 0.8,          // HP per stray CPU tracer striking a friendly (1.3.6: more tracers, less each)
  };
  // Staffel arrivals: 44 total, all committed before bomb drop
  // 1.3.4: all 44 are in the air from the start, high ahead (see spawnMissionFighters)
  const MISSION_WAVES = [{ at: 0, n: 36 }];

  let mission = null;
  // 1.3.8: the player's B-17 can be shot down → death spiral from the turret, bail-out, parachute view
  let downSeq = null;           // { T, phase: "fall"|"chute"|"done", cause, ... }
  let chutes = [];              // parachutes in the air (109 pilots, B-17 crews, our crew) — box frame
  let chuteSeq = 0;
  const EYE = { x: 0, y: 10.2, z: 6.5 }; // where the eye actually is (CAM, or falling / hanging under a canopy)
  const FALL_T = 8.0, CHUTE_T = 80.0, SKIP_AT = 3.0; // 1.4.0: a long drift under the canopy (auto-end cap 80 s) — END MISSION button once it's open
  let viewRoll = 0;
  let forcedRoll = null;

  function makeEngineSet() {
    return [0, 1, 2, 3].map((id) => ({ id, fire: 0, out: false }));
  }

  /**
   * 1.3.1 combat box (group of three 6-ship squadrons + 1 spare = 19).
   * 1.3.5: player flies the port wing (#3) of the LEAD squadron — the middle of the box.
   * Units 100 ft, but spacing/scale exaggerated for phone readability (B-17 mesh ~13u span).
   * Returns the 18 friendly offsets relative to the player's ship.
   */
  function combatBoxSlots() {
    const el = [ // squadron pattern: two 3-ship Vs, 2nd element stepped down & back
      { x: 0, y: 0, z: 0 }, { x: -22, y: -2, z: -16 }, { x: 22, y: -2, z: -16 },
      { x: 0, y: -7, z: -38 }, { x: -22, y: -9, z: -54 }, { x: 22, y: -9, z: -54 },
    ];
    const sq = {
      lead: { x: 0, y: 0, z: 0 },
      // +X is the turret's LEFT (port). Lead squadron ahead-port, high squadron (us) starboard
      // stepped up & back, low squadron further port stepped down & back.
      high: { x: -58, y: 16, z: -40 },
      low: { x: 58, y: -16, z: -40 },
    };
    // 1.3.5: the player flies the port wing of the LEAD squadron (#3 slot) — the middle of the
    // box: the lead ship ahead-right, the high squadron above-right, the low squadron below-left,
    // the lead's second element below and behind.
    const player = { x: sq.lead.x + el[2].x, y: sq.lead.y + el[2].y, z: sq.lead.z + el[2].z };
    const out = [];
    for (const key of ["lead", "high", "low"]) {
      for (let i = 0; i < el.length; i++) {
        if (key === "lead" && i === 2) continue; // that's us
        out.push({
          x: sq[key].x + el[i].x - player.x,
          y: sq[key].y + el[i].y - player.y,
          z: sq[key].z + el[i].z - player.z,
          sq: key, el: i,
        });
      }
    }
    // 19th ship: "tail-end Charlie" low behind the lead squadron
    out.push({ x: 0 - player.x, y: -15 - player.y, z: -78 - player.z, sq: "lead", el: 6 });
    return out; // 5 lead + 6 high + 6 low + 1 tail-end Charlie = 18 friendlies (+ player = 19)
  }

  function initMissionState() {
    gunner.lift = 0; gunner.liftP = 0; gunner.liftAt = null; // 1.4.1 bomb-release lurch
    mission = {
      t: 0,
      timeLeft: MISSION_DURATION,
      post: 0,
      fightersSpawned: 0,
      fightersKilled: 0,
      waveIdx: 0,
      pendingSpawn: 0,
      spawnAcc: 0,
      doorsOpen: false,
      bombsAway: false,
      turningBack: false,
      evaluated: false,
      bombersDropped: 0, tgt: null,
      friendliesLost: 0,
      friendlyHits: 0, friendlyHitsCpu: 0, friendlyFFLost: 0,
      gunnerTick: 0,
      phase: "ingress",
      lastIncoming: -9,
    };
    viewRoll = 0;
  }

  function friendlyOk(f) { return f && f.alive && !f.spiraling && f.health > 0; }

  function countBombCapable() {
    let n = bomber && !bomber.dead && !bomber.out ? 1 : 0; // 1.3.8: the player's ship can be shot down; 1.5.0: a ship that left the box can't bomb with it
    for (const f of friendlies) if (friendlyOk(f) && !f.out) n++;
    return n;
  }
  function countAliveBombers() { return countBombCapable(); }

  function engineOutCount(engs) {
    let n = 0;
    for (const e of engs) if (e.out) n++;
    return n;
  }

  function hitEngine(engs, severity) {
    // Prefer an engine that's still running
    const running = engs.filter((e) => !e.out);
    const eng = running.length ? running[(Math.random() * running.length) | 0] : engs[(Math.random() * 4) | 0];
    eng.fire = Math.min(1, eng.fire + severity);
    if (eng.fire >= 0.9) eng.out = true;
    return eng;
  }

  // 1.5.2 DEATH VARIETY — what was destroyed decides how she goes: a wing root gone (30 mm / rockets / 20 mm) → that wing folds off and
  // she rolls toward it; the tail gone (or a plain break-up, which keeps the classic look) → the tail tears away; engine fires / lost
  // engines → a burning spiral with the airframe intact.
  function pickDeath(s, why) {
    if (s.forceDeath) return s.forceDeath;
    // 1.5.3: the style of the death is random per ship (equal odds, independent of which part was hit): tail tears off / a wing folds off / she goes down intact (burning fall)
    const sd = s.sd, wr0 = sd ? sd.wr[0] : 50, wr1 = sd ? sd.wr[1] : 50;
    const q = Math.random(), wSide = (wr0 !== wr1 && sd) ? (wr0 < wr1 ? 1 : -1) : (Math.random() < 0.5 ? 1 : -1);
    return q < 1 / 3 ? { kind: "tail", side: 0 } : q < 2 / 3 ? { kind: "wing", side: wSide } : { kind: "fire", side: 0 };
  }
  function logDeath(who, dk) { if (!mission) return; const L = mission.deathLog || (mission.deathLog = []); L.push({ who, kind: dk.kind, side: dk.side || 0, t: +mission.t.toFixed(1) }); }
  function downFriendly(f, why) {
    if (!f.alive) return;
    f.alive = false;
    { const dk = pickDeath(f, why); f.deathKind = dk.kind; f.deathSide = dk.side || 0; logDeath(f.name || "AI", dk); }
    f.spiraling = true;
    f.spiralT = 0;
    f.vy = -rand(1.5, 3);
    f.vx = rand(-3, 3);
    f.vz = -rand(1, 4);
    f.spinDir = Math.random() < 0.5 ? -1 : 1;
    if (f.deathKind === "wing") { f.spinDir = f.deathSide; f.vy = -rand(3, 6); f.vx = f.deathSide * rand(2, 4); }
    else if (f.deathKind === "tail") f.vy = -rand(2.5, 4.5);
    // 1.3.8: some of the ten get out — realistically not all (1–7 chutes, over ~2–11 s)
    { const n = 1 + ((Math.random() * 7) | 0), plan = []; for (let k = 0; k < n; k++) plan.push(rand(1.8, 11)); f.bailPlan = plan.sort((a, b) => a - b); }
    if (mission) mission.friendliesLost++;
    if (window.FGAudio) window.FGAudio.boom(f.x, f.y, f.z, true);
    pushCallout((f.name || "FORTRESS") + (why === "engines" ? " LOSING ALTITUDE — ABORTING!" : " GOING DOWN!"), 1.8, true);
    sfxDamage();
    // 1.4.0: no score penalty for box losses — they are shown separately on the results screen
  }

  // ===== 1.5.0 PER-PART DAMAGE (FGCombat) — every B-17, the player's included. No single HP bar: hull_integrity is a backstop
  // (breakup at 0); engines, wing roots, tanks, tail, crew, guns, controls and oxygen are their own components. `ship.health`
  // is only a derived 0–100 "how battered she looks" number that the existing visual-damage ladder reads. =====
  const FC = window.FGCombat;
  const OWN_SCALE = 1.5, OWN_OFF = [0, 1.05, 2.8]; // own-ship frame (eye-relative, ~1.5× the box ships) ↔ the shared hitbox frame
  const PLAYER_GUN_WOUND = { m2: 1.2, mg131: 1.5, mg151: 14, mk108: 45, wgr21: 100 }; // crew HP lost by the gunner per round that strikes his turret volume
  function frameAngles(s) {
    if (s === bomber) { const p = ownPose(); return { o: p.o, aY: p.Y, aP: p.P, aB: p.Rl, own: true }; }
    const P = s.spiraling ? -0.35 - Math.min(0.5, (s.spiralT || 0) * 0.08) : 0;
    return { o: s, aY: s.yaw || 0, aP: -P, aB: -(s.bank || 0), own: false };
  }
  function rotL(a, x, y, z) {
    let c = Math.cos(a.aY), sn = Math.sin(a.aY);
    const x1 = x * c - z * sn, z1 = x * sn + z * c;
    c = Math.cos(a.aP); sn = Math.sin(a.aP);
    const y2 = y * c + z1 * sn, z2 = -y * sn + z1 * c;
    c = Math.cos(a.aB); sn = Math.sin(a.aB);
    return [x1 * c + y2 * sn, -x1 * sn + y2 * c, z2];
  }
  function rotW(a, x, y, z) {
    let c = Math.cos(a.aB), sn = Math.sin(a.aB);
    const x1 = x * c - y * sn, y2 = x * sn + y * c;
    c = Math.cos(a.aP); sn = Math.sin(a.aP);
    const y1 = y2 * c - z * sn, z1 = y2 * sn + z * c;
    c = Math.cos(a.aY); sn = Math.sin(a.aY);
    return [x1 * c + z1 * sn, y1, -x1 * sn + z1 * c];
  }
  function toShipA(a, wx, wy, wz) {
    const o = a.o, l = rotL(a, wx - o.x, wy - o.y, wz - o.z);
    return a.own ? [l[0] / OWN_SCALE + OWN_OFF[0], l[1] / OWN_SCALE + OWN_OFF[1], l[2] / OWN_SCALE + OWN_OFF[2]] : l;
  }
  function fromShipA(a, lx, ly, lz) {
    if (a.own) { lx = (lx - OWN_OFF[0]) * OWN_SCALE; ly = (ly - OWN_OFF[1]) * OWN_SCALE; lz = (lz - OWN_OFF[2]) * OWN_SCALE; }
    const w = rotW(a, lx, ly, lz), o = a.o;
    return [w[0] + o.x, w[1] + o.y, w[2] + o.z];
  }
  function shipLive(s) { return s === bomber ? !!(bomber && !bomber.dead) : friendlyOk(s); }
  function shipName(s) { return s === bomber ? "OUR SHIP" : (s.name || "A FORTRESS"); }
  function normBox(id) { return id.startsWith("prop_") ? "engine_" + id.slice(5) : id; }
  function logHit(src, gun, id, vic) {
    if (!mission) return;
    const L = mission.hitLog || (mission.hitLog = {}), k = src + ":" + gun, m = L[k] || (L[k] = {});
    m[id] = (m[id] || 0) + 1;
    const V = mission.hitVic || (mission.hitVic = {}); V[vic] = (V[vic] || 0) + 1;
  }
  let lastShipCall = 0, lastHitSnd = 0;
  function shipCall(s, text, life, force) { // friendlies' trouble is chatter (rate-limited); the player's own ship always speaks
    if (s === bomber) { pushCallout(text, life || 1.6, true); return; }
    if (force || elapsed - lastShipCall > 2.2) { lastShipCall = elapsed; pushCallout(text, life || 1.4, false); }
  }
  function shipEvents(s, evs) {
    const isP = s === bomber, nm = shipName(s);
    for (const e of evs) {
      if (e.t === "engine_out") shipCall(s, isP ? (s.lastSrc === "own" ? "WE SHOT OUT OUR OWN #" + (e.i + 1) + "!" : "ENGINE " + (e.i + 1) + " OUT — FEATHERING!") : nm + " — ENGINE OUT");
      else if (e.t === "engine_fire") shipCall(s, isP ? "ENGINE " + (e.i + 1) + " ON FIRE!" : nm + " — ENGINE ON FIRE");
      else if (e.t === "oil_leak") { if (isP) shipCall(s, "ENGINE " + (e.i + 1) + " — OIL LEAK!"); }
      else if (e.t === "fuel_fire") shipCall(s, isP ? "FIRE IN THE WING!" : nm + " — FIRE IN THE WING");
      else if (e.t === "fire_out") { if (isP) shipCall(s, "FIRE'S OUT"); }
      else if (e.t === "pilot_crit") shipCall(s, isP ? (e.n >= 2 ? "BOTH PILOTS HIT!" : "PILOT'S HIT!") : nm + " — PILOT HIT");
      else if (e.t === "gun_dead") { if (isP) { if (e.st === "top") { pushCallout("TURRET HIT — GUNS DEAD!", 2.2, true); } else pushCallout(e.st.toUpperCase().replace("_", " ") + " GUN OUT", 1.4, true); } }
      else if (e.t === "wing_fold") shipCall(s, isP ? "WING'S FOLDING!" : nm + " — WING FOLDING", 1.6, true);
      else if (e.t === "controls") { if (isP) { shipCall(s, "CONTROLS SLOPPY!"); } }
      else if (e.t === "oxygen") { if (isP) shipCall(s, "OXYGEN SYSTEM HIT"); }
      else if (e.t === "gear") { if (isP) shipCall(s, "HYDRAULICS SHOT UP — NO GEAR!"); }
      else if (e.t === "ammo_cook") { if (isP) shipCall(s, "AMMO BOX BURNING!"); }
    }
  }
  function syncShip(s) {
    const sd = s.sd; if (!sd) return;
    for (let k = 0; k < 4; k++) {
      const e = s.engines[k], q = sd.eng[k];
      e.out = q.out;
      if (q.fire) e.fire = Math.max(e.fire, 0.92);
      else if (q.leak > 0) e.fire = Math.max(e.fire, 0.26);
      else if (!q.out && q.hp < 26) e.fire = Math.max(e.fire, 0.14);
    }
    for (let side = 0; side < 2; side++) if (sd.fuel[side].fire) { const e = s.engines[side === 0 ? 3 : 0]; e.fire = Math.max(e.fire, 0.85); }
    if (sd.fuse && sd.fuse.fire) for (const k of [1, 2]) s.engines[k].fire = Math.max(s.engines[k].fire, 0.7); // 1.5.6 bomb-bay tank fire shows on the inboard nacelles
    if (s === bomber ? !bomber.dead : !s.spiraling) s.health = Math.max(0.5, FC.health(sd));
    if (s !== bomber) { // dead side's wing drops a few degrees
      const left = (s.engines[0].out ? 1 : 0) + (s.engines[1].out ? 1 : 0), right = (s.engines[2].out ? 1 : 0) + (s.engines[3].out ? 1 : 0);
      s.listTarget = (right - left) * 0.035;
    }
  }
  function playerHitFx(gun, id) {
    const heavy = gun === "mg151" || gun === "mk108" || gun === "wgr21";
    rumble = 1; gunner.shake = Math.max(gunner.shake, heavy ? 1.45 : 0.55);
    bomber.flash = 1.0;
    if (heavy) { addKick('cannon', gun === 'wgr21' ? 0.3 : 0.17); cabinHit(gun === 'wgr21' ? 0.9 : 0.55, gun); } else { addKick('mg', 0.04); fx154.accum += 0.16; if (fx154.accum > 0.55) { fx154.accum = 0.1; cabinHit(0.3, gun); } } // 1.5.4 shaped kick + cabin specks / sparks / vignette
    for (let i = 0, n = heavy ? 4 : 2; i < n; i++) { // torn-skin chips blown past the turret by the slipstream
      const a = rand(0, TAU), d = rand(3, 9);
      particles.push({ x: CAM.x + Math.cos(a) * d, y: CAM.y + rand(-1, 4), z: CAM.z + Math.sin(a) * d * 0.6 + rand(0, 5), vx: rand(-4, 4), vy: rand(0, 7), vz: rand(-30, -12), life: rand(0.35, 0.7), max: 0.7, kind: "chip", r: rand(0.8, 1.8) });
    }
    if (elapsed - lastHitSnd > (heavy ? 0.09 : 0.06)) { // 1.5.3: rapid strafing hits all sound (voice budget in audio.js caps the pile-up), panned to the side of the airframe that was hit
      lastHitSnd = elapsed;
      const side = /(^|_)(l|port|left|1|2|3)$/.test(id) ? -1 : /(^|_)(r|stbd|right|4|5|6)$/.test(id) ? 1 : 0, pan = side * (0.45 + Math.random() * 0.35) + (Math.random() - 0.5) * 0.2;
      if (window.FGAudio) { window.FGAudio.hitOwn(id.startsWith("engine_") ? "engine" : heavy ? "cannon" : "mg", pan); if (id.startsWith("engine_") && Math.random() < 0.5) window.FGAudio.structure("engine", pan); else if (/^wing|^tail/.test(id) && Math.random() < 0.18) window.FGAudio.structure("creak", pan); else if (heavy && bomber.health < 55 && Math.random() < 0.2) window.FGAudio.structure(Math.random() < 0.5 ? "wind" : "decomp", pan); else if (id.startsWith("engine_") && bomber.health < 70 && Math.random() < 0.12) window.FGAudio.structure("fire", pan); }
      if (heavy) sfxDamage();
    }
  }
  // one round that reached hitbox `id` of ship s. src: "109" | "190" | "flak" | "own" | "ff" | "cpu" ...
  function shipHit(s, id, gun, rf, src, opts) {
    if (!shipLive(s) || (s === bomber && godMode)) return null;
    id = normBox(id);
    const isP = s === bomber;
    s.lastSrc = src;
    const gm = (src === "109" || src === "190") ? TUNE.gerDmg * (isP ? TUNE.gerPlayerMul : 1) * ((opts && opts.dm) || 1) : 1; // 1.5.6: md dmgMul109 1.0 / dmgMul190 1.35 / dmgMulSturm 2.05 ride in opts.dm
    const r = FC.applyHit(s.sd, id, gun, { rf: rf * gm, scale: opts && opts.scale, fireMul: opts && opts.fireMul });
    logHit(src, gun, id, isP ? "player" : "box");
    if (!isP) s.flash = 1;
    if (isP) {
      playerHitFx(gun, id);
      if (id === "gun_top") { // the gunner himself is in this volume: wounds, never a one-round kill
        bomber.crewHp = Math.max(0, bomber.crewHp - (PLAYER_GUN_WOUND[gun] || 1) * rf);
        if (bomber.crewHp < 60 && !bomber.wounded) { bomber.wounded = true; pushCallout("YOU'RE HIT!", 1.4, true); }
        if (bomber.crewHp <= 0) { shipEvents(s, r.ev); syncShip(s); playerShotDown(src === "own" ? "own" : "wounded"); return r; }
      }
    }
    shipEvents(s, r.ev);
    syncShip(s);
    checkShip(s);
    return r;
  }
  function checkShip(s) {
    const st = FC.status(s.sd);
    if (st.destroy) destroyShip(s, st.destroy);
    else if (st.leave && !s.out) leaveBox(s, st.leave);
  }
  const LEAVE_TXT = { engines: "TWO ENGINES OUT", pilots: "PILOTS DOWN", wingroot: "WING ROOT GONE", fire: "FIRE ON BOARD", controls: "CONTROLS SHOT AWAY", hull: "BADLY HOLED", tail: "TAIL SHOT AWAY" };
  function leaveBox(s, why) {
    if (s.out) return;
    s.out = true; s.outReason = why; s.outAt = mission ? mission.t : 0;
    if (mission) { mission.outBox = (mission.outBox || 0) + 1; (mission.outLog || (mission.outLog = [])).push({ t: +mission.t.toFixed(1), who: s === bomber ? "PLAYER" : s.name, why, by: s.lastSrc }); }
    if (s === bomber) { pushCallout("WE'RE FALLING OUT OF FORMATION — " + (LEAVE_TXT[why] || why).toUpperCase() + "!", 2.4, true); if (mission) { mission.playerOutT = mission.t; mission.playerOutWhy = why; mission.playerOutHp = Math.round(s.health); } }
    else {
      pushCallout(shipName(s) + " LEAVING THE FORMATION — " + (LEAVE_TXT[why] || why), 1.8, true);
      if (why === "pilots") s.doomAt = mission.t + rand(10, 18);
      else if (why === "wingroot") s.doomAt = mission.t + rand(14, 30);
    }
  }
  function destroyShip(s, why) {
    const src = s.lastSrc || "109";
    if (s === bomber) {
      { const dk = pickDeath(s, why); s.deathKind = dk.kind; s.deathSide = dk.side || 0; logDeath("PLAYER", dk); }
      if (!s.out) leaveBoxQuiet(s, why);
      playerShotDown(src === "own" ? "own" : src === "flak" ? "flak" : src);
      return;
    }
    if (!s.alive) return;
    if (!s.out) leaveBoxQuiet(s, why);
    if (mission) { mission.lostBy = mission.lostBy || {}; mission.lostBy[src] = (mission.lostBy[src] || 0) + 1; if (src === "own" || src === "ff") mission.friendlyFFLost++; }
    downFriendly(s, why === "engines" ? "engines" : "hp");
  }
  function leaveBoxQuiet(s, why) {
    s.out = true; s.outReason = why; s.outAt = mission ? mission.t : 0;
    if (mission) { mission.outBox = (mission.outBox || 0) + 1; (mission.outLog || (mission.outLog = [])).push({ t: +mission.t.toFixed(1), who: s === bomber ? "PLAYER" : s.name, why: "DESTROYED:" + why, by: s.lastSrc }); }
  }
  function tickShip(s, dt) {
    const sd = s.sd; if (!sd || sd.destroyed) return;
    if (s !== bomber && !friendlyOk(s)) return;
    const ev = FC.tick(sd, dt);
    if (ev.length) shipEvents(s, ev);
    if (s.sd.dirty !== false) syncShip(s);
    if (s.doomAt != null && mission && mission.t >= s.doomAt) { s.doomAt = null; destroyShip(s, "dive"); return; }
    checkShip(s);
  }
  // do-it-all hit report for a ship from a world-space segment (used by enemy rounds): nearest hitbox along it
  function segShip(s, x0, y0, z0, x1, y1, z1) {
    const a = frameAngles(s), p0 = toShipA(a, x0, y0, z0), p1 = toShipA(a, x1, y1, z1);
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
    const h = FC.rayBoxes(p0[0], p0[1], p0[2], dx, dy, dz, 1);
    if (!h) return null;
    const W = fromShipA(a, h.x, h.y, h.z);
    return { id: h.id, t: h.t, x: W[0], y: W[1], z: W[2] };
  }
  // flak fragments: a handful of HE hits (20 mm-class) at random boxes, scaled by closeness (player's ship takes ~0.3×)
  function flakDamage(s, k, mul) {
    const n = Math.max(1, Math.round(1.1 * k * mul * rand(0.6, 1.4) + (s === bomber ? 0.2 : 0)));
    for (let i = 0; i < n && shipLive(s); i++) shipHit(s, FC.pickStrike("beam"), "mg151", 1, "flak", { scale: 0.6, fireMul: 0.3 });
  }

  // ===== 1.3.4 FRIENDLY FIRE: B-17 hitboxes (matches the world3d mesh, B17_VIS = 16u span-ish) =====
  // local frame: nose +Z, +Y up; engines #1..#4 port→stbd at x = −7.0, −3.5, +3.5, +7.0
  const FF_ENG_X = [-5.6, -3.04, 3.04, 5.6];
  function friendlyPartAt(lx, ly, lz) {
    for (let k = 0; k < 4; k++) {
      const dx = lx - FF_ENG_X[k], dy = ly + 0.19;
      if (dx * dx + dy * dy < 0.62 * 0.62 && lz > 0.9 && lz < 3.6) return k; // nacelle
    }
    if (lz > -6.6 && lz < 6.1) { // fuselage (tapers toward the tail)
      const r = lz < -3 ? 0.75 - (-3 - lz) * 0.14 : 0.8;
      if (lx * lx + ly * ly < r * r) return "body";
    }
    const ax = Math.abs(lx);
    if (Math.abs(ly + 0.1) < 0.28) {
      if (ax < 4.16 && lz > -0.45 && lz < 2.37) return "wing";
      if (ax < 8.16 && lz > -0.15 && lz < 1.6) return "wing";
      if (ax < 3.36 && lz > -6.5 && lz < -5.0) return "tail";
    }
    if (ax < 0.2 && ly > 0 && ly < 3.0 && lz < -4.7 && lz > -7.0) return "tail";
    return null;
  }
  // swept segment vs every live friendly (except `skip`): returns { f, part, x, y, z } or null
  function hitFriendlySeg(x0, y0, z0, x1, y1, z1, skip, exact) {
    const sx = x1 - x0, sy = y1 - y0, sz = z1 - z0;
    const ss = sx * sx + sy * sy + sz * sz || 1e-6;
    let best = null, bestT = 2;
    for (let fi = 0; fi < friendlies.length; fi++) {
      const f = friendlies[fi];
      if (f === skip || !friendlyOk(f)) continue;
      const tt = clamp(((f.x - x0) * sx + (f.y - y0) * sy + (f.z - z0) * sz) / ss, 0, 1);
      const qx = x0 + sx * tt - f.x, qy = y0 + sy * tt - f.y, qz = z0 + sz * tt - f.z;
      if (qx * qx + qy * qy + qz * qz > 100) continue; // > 10u from the ship: miss
      const slot = f.slot != null ? f.slot : fi;
      if (exact && World3D && World3D.rayShip) { // 1.3.8: our rounds vs the rendered, banked mesh
        const h = World3D.rayShip(slot, x0, y0, z0, x1, y1, z1, friendlyRayPose(f));
        if (h && h.t < bestT) {
          const l = friendlyLocal(f, h.x - f.x, h.y - f.y, h.z - f.z);
          let part = friendlyPartAt(l.x, l.y, l.z);
          if (part == null) { let bi = -1, bd = 1.2; for (let k = 0; k < 4; k++) { const d = Math.abs(l.x - FF_ENG_X[k]); if (d < bd && l.z > 0.4 && l.z < 4.2) { bd = d; bi = k; } } part = bi >= 0 ? bi : Math.abs(l.x) > 0.9 ? "wing" : l.z < -4.7 ? "tail" : "body"; }
          bestT = h.t; best = { f, part, x: h.x, y: h.y, z: h.z, ray: h, slot };
        }
        continue;
      }
      const L = Math.sqrt(ss), n = Math.max(2, Math.ceil(L / 0.3));
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        if (u >= bestT) break;
        const px = x0 + sx * u - f.x, py = y0 + sy * u - f.y, pz = z0 + sz * u - f.z;
        const l = friendlyLocal(f, px, py, pz);
        const part = friendlyPartAt(l.x, l.y, l.z);
        if (part != null) { bestT = u; best = { f, part, x: f.x + px, y: f.y + py, z: f.z + pz, slot }; break; }
      }
    }
    return best;
  }
  // 1.3.8: world offset → the Fortress's own frame (inverse of world3d's YXZ: yaw, −pitch, −bank)
  function friendlyLocal(f, x, y, z) {
    const Y = f.yaw || 0, P = f.spiraling ? -0.35 - Math.min(0.5, (f.spiralT || 0) * 0.08) : 0, B = f.bank || 0;
    let c = Math.cos(Y), s = Math.sin(Y);
    const x1 = x * c - z * s, z1 = x * s + z * c;
    c = Math.cos(-P); s = Math.sin(-P);
    const y2 = y * c + z1 * s, z2 = -y * s + z1 * c;
    c = Math.cos(-B); s = Math.sin(-B);
    return { x: x1 * c + y2 * s, y: -x1 * s + y2 * c, z: z2 };
  }
  let lastFFCall = -99;
  // one .50 round (the player's, or a box gunner's stray) striking a friendly Fortress — 1.5.0: lands in a hitbox of the per-part model
  function friendlyFireHit(h, dmg, byPlayer) {
    const f = h.f;
    if (!friendlyOk(f)) return;
    const l = friendlyLocal(f, h.x - f.x, h.y - f.y, h.z - f.z);
    let id = FC.boxAt(l.x, l.y, l.z);
    if (typeof h.part === "number") id = FC.ENG_ID[h.part]; // struck a nacelle
    shipHit(f, id, "m2", 1, byPlayer ? "ff" : "cpu", { scale: byPlayer ? 1 : 0.9 });
    if (World3D && World3D.addHole) {
      let ray = h.ray;
      if (!ray && World3D.rayShip && h.slot != null) { const dx = h.x - CAM.x, dy = h.y - CAM.y, dz = h.z - CAM.z, dl = Math.hypot(dx, dy, dz) || 1; ray = World3D.rayShip(h.slot, h.x - dx / dl * 3, h.y - dy / dl * 3, h.z - dz / dl * 3, h.x + dx / dl * 3, h.y + dy / dl * 3, h.z + dz / dl * 3, friendlyRayPose(f)); }
      if (ray) { World3D.addHole(h.slot, ray, 0.16); h.x = ray.x; h.y = ray.y; h.z = ray.z; f.holeN = (f.holeN || 0) + 1; if (World3D.addTear && f.holeN % 8 === 0) { fx154.n.tears++; World3D.addTear(h.slot, ray, 0.45 + Math.min(0.7, f.holeN * 0.012)); } }
      hitCluster(h.x, h.y, h.z, 0, 0, 0, false, 1);
    }
    for (let i = 0; i < 5; i++) particles.push({
      x: h.x, y: h.y, z: h.z, vx: rand(-14, 14), vy: rand(-6, 12), vz: rand(-14, 14),
      life: rand(0.12, 0.3), max: 0.3, kind: i < 4 ? "spark" : "fire", r: rand(1.5, 3),
    });
    if (mission) { if (byPlayer) mission.friendlyHits++; else mission.friendlyHitsCpu++; }
    if (byPlayer) {
      score = Math.max(0, score - 5);
      if (elapsed - lastFFCall > 3) { lastFFCall = elapsed; pushCallout("CEASE FIRE! YOU'RE HITTING " + (f.name || "A FORTRESS") + "!", 1.3, true); }
    }
  }

  /** Pick who this fighter's next pass goes after. */
  /** Target-relative frame: AI steers against its target plane's position. */
  function tgtOffset(e) {
    if (e.nextTgt) { e.tgt = e.nextTgt; e.nextTgt = null; }
    const t = e.tgt;
    if (t && t.kind === "friendly") {
      if (friendlyOk(t.f)) return { x: t.f.x, y: t.f.y - BOMBER_AIM_Y, z: t.f.z };
      e.tgt = bomber && bomber.dead ? pickFormationTarget(e, e.mode) : { kind: "player" };
      if (e.tgt.kind === "friendly" && friendlyOk(e.tgt.f)) return { x: e.tgt.f.x, y: e.tgt.f.y - BOMBER_AIM_Y, z: e.tgt.f.z };
    }
    return { x: 0, y: 0, z: 0 };
  }

  function updatePlayerList(dt) {
    if (!bomber) return;
    tickShip(bomber, dt);
    const en = bomber.engines;
    for (const e of en) {
      // Fires burn out / get extinguished; a dead engine keeps trailing a little smoke
      e.fire = Math.max(e.out ? 0.15 : 0, e.fire - dt * (e.out ? 0.03 : 0.06));
    }
    if (bomber.tail) { // self-inflicted tail fire burns down to a lingering smoke trail
      const t = bomber.tail;
      t.peak = Math.max(t.peak || 0, t.fire);
      t.fire = Math.max(t.peak > 0.45 ? 0.14 : 0, t.fire - dt * 0.025);
    }
    const left = (en[0].out ? 1 : 0) + (en[1].out ? 1 : 0);
    const right = (en[2].out ? 1 : 0) + (en[3].out ? 1 : 0);
    const want = clamp((left - right) * 0.16, -0.35, 0.35); // dead side's wing drops
    bomber.list = lerp(bomber.list || 0, want, 1 - Math.pow(0.25, dt));
  }

  function updateFormation(dt) {
    const turning = mission && mission.turningBack;
    for (const f of friendlies) {
      f.flash = Math.max(0, (f.flash || 0) - dt * 2.5);
      for (const e of f.engines) e.fire = Math.max(e.out ? 0.2 : 0, e.fire - dt * (e.out ? 0.02 : 0.05));
      if (!f.spiraling) tickShip(f, dt);
      if (f.spiraling) {
        f.spiralT = (f.spiralT || 0) + dt;
        while (f.bailPlan && f.bailPlan.length && f.spiralT >= f.bailPlan[0]) { f.bailPlan.shift(); spawnChute(f.x + rand(-3, 3), f.y - 1, f.z + rand(-5, 3), (f.vx || 0) + rand(-2, 2), f.vy || -2, f.vz || 0, "us"); }
        { const dkW = f.deathKind === "wing", dkT = f.deathKind === "tail"; // the roll toward the missing wing is fast and keeps winding up
          f.bank = (f.bank || 0) + dt * (dkW ? Math.min(2.6, 1.0 + 0.5 * f.spiralT) : dkT ? 1.2 : 0.9) * (f.spinDir || 1);
          f.yaw = (f.yaw || 0) + dt * (dkW ? 0.7 : 0.35) * (f.spinDir || 1);
          f.vy = (f.vy || -2) - (dkW ? 4.6 : dkT ? 3.8 : 3.2) * dt; }
        f.x += (f.vx || 0) * dt + Math.sin(f.spiralT * 1.3) * 6 * dt;
        f.y += f.vy * dt;
        f.z += (f.vz || 0) * dt;
        if (f.spiralT > 14 || f.y < -170) f.health = -1; // gone below the deck → hide
        continue;
      }
      // 1.3.2: hold the slot rock-steady (tiny bob/drift). Hurt ships straggle: drift back and
      // down out of the slot. Everyone banks together (same angle as our own ship) on the turn.
      const eo = engineOutCount(f.engines);
      const hurt = f.out || eo > 0 || f.health < 45;
      f.straggle = clamp((f.straggle || 0) + dt * (f.out ? 0.06 : hurt ? 0.035 * (eo + 1) : -0.01), 0, 1);
      // 1.4.1: every ship on its own rhythm — two-tone bob, fore/aft surge, lateral drift and a slow wing rock
      const sl = f.slot || 0;
      const bob = Math.sin(elapsed * (0.42 + 0.05 * (sl % 5)) + sl * 1.7) + 0.4 * Math.sin(elapsed * (1.05 + 0.09 * (sl % 3)) + sl * 2.3);
      const tx = f.homeX + Math.sin(elapsed * (0.19 + 0.03 * (sl % 4)) + sl) * 0.9;
      const po = playerStragK(); // 1.5.2: our ship fell out — the box pulls away over ~50 s (1,500 u ahead, 240 u above)
      const fo = f.out && f.outAt != null && mission ? smooth01((mission.t - f.outAt) / 45) : 0; // an AI ship that left the box drops back and down
      const ty = f.homeY + bob * (0.5 + 0.08 * (sl % 3)) - f.straggle * (14 + (f.out ? 20 : 0)) + (f.lift || 0) + po * 240 - fo * 170;
      f.lift = (f.lift || 0) * Math.pow(0.35, dt);
      const tz = f.homeZ - f.straggle * (38 + (f.out ? 60 : 0)) + po * 1500 - fo * 900 + Math.sin(elapsed * (0.15 + 0.02 * (sl % 5)) + sl * 0.7) * 1.1;
      f.x = lerp(f.x, tx, 1 - Math.pow(0.5, dt));
      f.y = lerp(f.y, ty, 1 - Math.pow(f.out ? 0.8 : 0.5, dt));
      f.z = lerp(f.z, tz, 1 - Math.pow(f.out ? 0.85 : 0.6, dt));
      f.yaw = 0;
      const bankWant = clamp(f.listTarget || 0, -0.07, 0.07) + (turning ? (mission.turnRoll || 0) : 0) + bob * 0.008
        + 0.024 * Math.sin(elapsed * (0.33 + 0.045 * (sl % 4)) + sl * 0.9) + 0.007 * Math.sin(elapsed * 1.7 + sl);
      f.bank = lerp(f.bank || 0, bankWant, 1 - Math.pow(0.3, dt));
    }
    friendlies = friendlies.filter((f) => f.health >= 0);
  }

  /** 1.3.7 CPU gunners — every gun position is its own man. Each station only covers its real
   *  arc (chin/cheeks forward, top turret upper hemisphere, ball turret lower hemisphere, each waist
   *  its own beam, tail the rear cone), scans on its own schedule, only NOTICES a 109 with a
   *  probability that falls with range (limited awareness), prefers attackers inside its arc but
   *  avoids piling onto a 109 that several other guns in the box are already firing at, and keeps
   *  its man for a while once it has him. Result: the same bullet storm, spread across the sky. */
  const CPU_GUNS = [ // local (nose +Z, +X port): station, position, rate (twin = 1), arc test on unit dir (x,y,z)
    { n: "chin", p: [0, -0.5, 6.4], r: 1, ok: (x, y, z) => z > 0.5 && y > -0.75 && y < 0.45 },
    { n: "cheekL", p: [0.8, 0, 5.2], r: 0.5, ok: (x, y, z) => x > 0.1 && z > 0.3 && y > -0.6 && y < 0.35 },
    { n: "cheekR", p: [-0.8, 0, 5.2], r: 0.5, ok: (x, y, z) => x < -0.1 && z > 0.3 && y > -0.6 && y < 0.35 },
    { n: "top", p: [0, 1.05, 2.8], r: 1, ok: (x, y, z) => y > 0.03 },
    { n: "ball", p: [0, -1.25, -0.5], r: 1, ok: (x, y, z) => y < -0.03 },
    { n: "waistL", p: [0.95, 0.3, -2.8], r: 0.6, ok: (x, y, z) => x > 0.35 && Math.abs(z) < 0.85 && y > -0.6 && y < 0.65 },
    { n: "waistR", p: [-0.95, 0.3, -2.8], r: 0.6, ok: (x, y, z) => x < -0.35 && Math.abs(z) < 0.85 && y > -0.6 && y < 0.65 },
    { n: "tail", p: [0, 0.2, -6.9], r: 1, ok: (x, y, z) => z < -0.7 && Math.abs(y) < 0.62 },
  ];
  const CPU_STN = { chin: "chin", cheekL: "cheek_l", cheekR: "cheek_r", top: "top", ball: "ball", waistL: "waist_l", waistR: "waist_r", tail: "tail" };
  const gunEngaged = new Map(); // 109 id → number of box guns currently firing at it
  function updateCpuGunners(dt) {
    if (!mission || mission.evaluated) return;
    const bandits = enemies.filter((e) => e.alive && e.phase !== "debug" && e.team !== "allied" && !e.hold); // box gunners shoot Axis only
    const V = BULLET_UPS; // 1.5.1: box-gunner tracers fly at the player's tracer speed (was 330)
    const R = TUNE.cpuRange;
    gunEngaged.clear();
    for (const f of friendlies) if (f.guns && friendlyOk(f)) for (const g of f.guns) if (g.burst > 0 && g.tgt && g.tgt.alive) gunEngaged.set(g.tgt.id, (gunEngaged.get(g.tgt.id) || 0) + 1);
    const gs = mission.gunStats || (mission.gunStats = { samples: 0, firing: 0, distinct: 0, maxDistinct: 0, arcChecks: 0, arcViol: 0, byStation: {}, sampT: 0, maxOnOne: 0, onOneSum: 0 });
    for (const f of friendlies) {
      if (!friendlyOk(f)) continue;
      if (!f.guns || f.guns.length !== CPU_GUNS.length) f.guns = CPU_GUNS.map(() => ({ tgt: null, burst: 0, cd: rand(0, 2.0), acc: 0, keep: 0 }));
      const c = Math.cos(f.yaw || 0), sn = Math.sin(f.yaw || 0);
      for (let gi = 0; gi < CPU_GUNS.length; gi++) {
        const G = CPU_GUNS[gi], g = f.guns[gi];
        if (f.sd && f.sd.gun[CPU_STN[G.n]] <= 0) { g.burst = 0; continue; } // station knocked out
        const ox = f.x + G.p[0] * c + G.p[2] * sn, oy = f.y + G.p[1], oz = f.z - G.p[0] * sn + G.p[2] * c;
        const inArc = (e) => {
          const dx = e.x - ox, dy = e.y - oy, dz = e.z - oz, d = Math.hypot(dx, dy, dz);
          if (d > R * 1.4 || d < 12) return 0; // long-range (wasteful) bursts at 109s out to ~1.25 km
          if (d > R && !(e.phase === "attack" || e.phase === "break")) { if (d > R * 1.4) return 0; } else if (d > R) return 0;
          const lx = (dx * c - dz * sn) / d, lz = (dx * sn + dz * c) / d;
          return G.ok(lx, dy / d, lz) ? d : 0;
        };
        if (g.burst <= 0) {
          g.cd -= dt;
          if (g.cd > 0 || !bandits.length) continue;
          g.cd = rand(0.35, 1.2); // this man's own scan rhythm
          let best = null;
          // keep his man if he still bears (he has been tracking him)
          if (g.tgt && g.tgt.alive && g.keep > 0 && inArc(g.tgt) && Math.random() < 0.75) best = g.tgt;
          else {
            let sum = 0; const cand = [];
            for (const e of bandits) {
              const d = inArc(e);
              if (!d) continue;
              const hot = e.phase === "attack" || e.phase === "break";
              const pNotice = clamp(1.25 - d / R, 0.15, 1) * (hot ? 1 : 0.55); // limited awareness
              if (Math.random() > pNotice) continue;
              const ne = gunEngaged.get(e.id) || 0;
              const w = (1 / (0.35 + d / R)) * (hot ? 1.6 : 1) / Math.pow(1 + ne, 1.6) * (ne >= 8 ? 0.15 : 1);
              cand.push(e, w); sum += w;
            }
            let r = Math.random() * sum;
            for (let k = 0; k < cand.length; k += 2) { r -= cand[k + 1]; if (r <= 0) { best = cand[k]; break; } }
          }
          if (!best) continue;
          // hold fire when another Fortress is in the line of fire (mostly)
          const L = Math.hypot(best.x - ox, best.y - oy, best.z - oz) || 1;
          const ux = (best.x - ox) / L, uy = (best.y - oy) / L, uz = (best.z - oz) / L;
          let blocked = false;
          for (const o of friendlies) {
            if (o === f || !friendlyOk(o)) continue;
            const along = (o.x - ox) * ux + (o.y - oy) * uy + (o.z - oz) * uz;
            if (along < 0 || along > L + 10) continue;
            const px = o.x - ox - ux * along, py = o.y - oy - uy * along, pz = o.z - oz - uz * along;
            if (px * px + py * py + pz * pz < 12 * 12) { blocked = true; break; }
          }
          if (!blocked) for (const o of enemies) { // a Mustang in the line of fire: hold fire (mostly)
            if (!o.alive || o.type !== "p51") continue;
            const along = (o.x - ox) * ux + (o.y - oy) * uy + (o.z - oz) * uz;
            if (along < 0 || along > L + 10) continue;
            const px = o.x - ox - ux * along, py = o.y - oy - uy * along, pz = o.z - oz - uz * along;
            if (px * px + py * py + pz * pz < 8 * 8) { blocked = true; break; }
          }
          if (blocked && Math.random() < 0.9) continue;
          if (g.tgt !== best) g.keep = rand(3, 7);
          g.tgt = best; g.burst = rand(0.8, 2.2) * TUNE.cpuBurstMul; g.acc = 0;
          gunEngaged.set(best.id, (gunEngaged.get(best.id) || 0) + 1);
          g.err = [rand(-4, 4), rand(-3, 3), rand(-4, 4)]; // this burst's aim error, walked in over the burst
          continue;
        }
        const e = g.tgt;
        g.keep -= dt;
        if (!e || !e.alive || !inArc(e)) { g.burst = 0; g.cd = rand(0.2, 0.6); continue; } // out of his arc: he lets go
        g.burst -= dt;
        g.acc += dt * TUNE.cpuTracerRate * G.r;
        while (g.acc >= 1) {
          g.acc -= 1;
          const dx0 = e.x - ox, dy0 = e.y - oy, dz0 = e.z - oz, d = Math.hypot(dx0, dy0, dz0);
          if (d > R * 1.5) { g.burst = 0; break; }
          const tt = d / V;
          const w = Math.max(0.3, g.burst); // error shrinks as the gunner walks the stream in
          const ax = e.x + (e.vx || 0) * tt + g.err[0] * w + rand(-2, 2), ay = e.y + (e.vy || 0) * tt + g.err[1] * w + rand(-1.5, 1.5), az = e.z + (e.vz || 0) * tt + g.err[2] * w + rand(-2, 2);
          // 1.3.9: the gunner holds off for drop and drift (quick 2-pass ballistic solve)
          const sol = solveBallistic(ox, oy, oz, ax, ay, az, V, 2, 1 / 30);
          const ux = sol.ux, uy = sol.uy, uz = sol.uz;
          { // the gun stops at its arc limit: a round whose lead point is outside the arc is not fired
            const lx = ux * c - uz * sn, lz = ux * sn + uz * c;
            gs.arcChecks++;
            if (!G.ok(lx, uy, lz)) { gs.arcStops = (gs.arcStops || 0) + 1; continue; }
            gs.byStation[G.n] = (gs.byStation[G.n] || 0) + 1;
          }
          mission.cpuTracers = (mission.cpuTracers || 0) + 1;
          mission.cpuShots = (mission.cpuShots || 0) + 1;
          tracers.push({
            x: ox + ux * 2, y: oy + uy * 2, z: oz + uz * 2, vx: ux * V, vy: uy * V, vz: uz * V,
            life: BULLET_LIFE, maxLife: BULLET_LIFE, trav: 0, team: "allied",
            shooter: (mission.cpuTracers & 3) === 0 ? f : null, // every 4th round is swept against friends
            hid: ((mission.cpuTracers + (g.n | 0)) & 3) !== 0, // 1.4.0: only ~1 in 4 of these glows (1 tracer : 4 ball, like the belts) — hit rolls unchanged
          });
          if (window.FGAudio) window.FGAudio.gun(ox, oy, oz);
          // 1.3.8: each yellow tracer stands for ~5 rounds; hit chance falls with the square of range
          // (1.3.7 bug: the old 0.003·(1.4 − d/R) was ≈0 at the long ranges most bursts are fired at → box gunners scored 0 kills)
          const dq = d / TUNE.cpuHitD0;
          if (Math.random() < TUNE.cpuHitPerTracer / (1 + dq * dq) * (e.phase === "attack" ? (e.jinking ? 0.8 : 1.25) : e.evadeT > 0 ? 0.6 : 1)) {
            mission.cpuHits = (mission.cpuHits || 0) + 1;
            const cd = TUNE.cpuHitDmg * (e.type === "190" ? 0.82 : 1) * (e.sturm ? 0.85 : 1);
            e.hp -= cd;
            e.cHits = (e.cHits || 0) + cd;
            if (e.ps && e.phase === "attack") { e.ps.hit = true; if (!e.firedPass) e.ps.hitFirst = true; }
            if (e.burst && Math.random() < 0.12) { e.burst.jit = Math.max(e.burst.jit, 1.4); }
            if (e.hp <= 0) { killEnemy(e, e.cHits >= (e.pHits || 0)); g.burst = 0; break; }
            else spawnHit(e);
          }
        }
      }
    }
    // spread audit: how many distinct 109s are under fire at once, and the most guns on any one
    gs.sampT += dt;
    if (gs.sampT >= 0.5) {
      gs.sampT = 0;
      const on = new Map(); let firing = 0;
      for (const f of friendlies) if (f.guns && friendlyOk(f)) for (const g of f.guns) if (g.burst > 0 && g.tgt && g.tgt.alive) { firing++; on.set(g.tgt.id, (on.get(g.tgt.id) || 0) + 1); }
      if (firing) {
        gs.samples++; gs.firing += firing; gs.distinct += on.size; gs.maxDistinct = Math.max(gs.maxDistinct, on.size);
        let mx = 0; for (const v of on.values()) mx = Math.max(mx, v);
        gs.maxOnOne = Math.max(gs.maxOnOne, mx); gs.onOneSum += mx / firing;
      }
    }
  }

  // ===== 1.3.4: Bf 109 FLIGHT MODEL — each 109 is an aircraft flying through the AIR =====
  // Units ≈ 1.5 m. The box frame (our ship at the origin) moves north (+Z) through the air at
  // 280 mph. A 109 has an AIRSPEED V along its nose h (unit); its box-frame velocity is
  // V·h − (0,0,VF), so it can never hover or slide backward through the air. Energy: gravity
  // along the flight path, thrust/drag toward ~350 mph level (hard drag above ~425), induced
  // drag from g. Turns: it rolls (≤150°/s) to put lift where it wants to turn and pulls
  // ≤ nMax g, so turn radius is real (≈ V²/(g·√(n²−1)) ≈ 500–800 m).
  const U_PER_M = 1 / 1.5;
  const MPH = 0.44704 * U_PER_M;           // u/s per mph
  const VF = 180 * MPH;                    // formation airspeed (north, +Z) — 1.5.7: 180 mph = 53.6 u/s (was 280 mph = 83.4)
  const G_U = 9.81 * U_PER_M;
  const FAI = {
    vLevel: 380 * MPH, vFull: 420 * MPH, vDive: 440 * MPH, vMin: 250 * MPH, vSlow: 335 * MPH, // 1.5.7: 109 run-in 400–450 mph (closing ~600 mph on the 180 mph box)
    nMax: 5.0, rollRate: 2.4, rollAcc: 6.0, // rad/s, rad/s² — visible roll-in / roll-out
    maxActive: 22,
    camMiss: 34,
    shipMiss: [12, 22],
    fireMax: 430, fireOpen: 700, fireMin: 45,
    floorY: -650,
    v190: 410 * MPH, v190Cap: 430 * MPH, /* 1.5.7: 190 on the 5/7 o'clock run 410 mph (≈ ground speed; closing ~230 mph on the 180 mph box) */ v190Md: 540 * MPH, v190CapMd: 545 * MPH, /* 1.5.6: md v190 = 540 mph; the 580 cap let dives reach ~575 mph */ // 1.5.3: 440→500 mph run-in (dive attack; closing 220 mph on the box instead of 160)
    v190old: 440 * MPH, v190CapOld: 460 * MPH, // 1.5.1: 190 dive/zoom run-in 465 mph (closing 185 mph on the 280 mph box)
    alt15k: 4572 * U_PER_M,                // 15,000 ft above the box (109s at ~35,000 ft)
  };
  // 1.3.5: box centre = mean of all 19 slots (player in the lead squadron's port wing slot)
  const BOX_C = (() => {
    const sl = combatBoxSlots();
    let x = 0, y = 0, z = 0;
    for (const q of sl) { x += q.x; y += q.y; z += q.z; }
    const n = sl.length + 1;
    return { x: x / n, y: BOMBER_AIM_Y + y / n, z: z / n };
  })();
  const BOX_C0 = { x: BOX_C.x, y: BOX_C.y, z: BOX_C.z }; // 1.5.2: BOX_C slides ahead of the player once he is a straggler
  const APPROACH_DIRS = [ // box-frame sectors (unit-ish) for re-attacks
    [0.25, 0.45, 0.86], [-0.25, 0.45, 0.86],   // 12 high
    [0.15, 0.08, 1], [-0.15, 0.08, 1],         // 12 level (head-on)
    [0.85, 0.45, 0.3], [-0.85, 0.45, 0.3],     // high front quarter
    [1, 0.12, -0.1], [-1, 0.12, -0.1],         // beam
    [0.75, -0.35, 0.45], [-0.75, -0.35, 0.45], // low side, climbing through
    [0.3, 0.5, -0.86], [-0.3, 0.5, -0.86],     // 6 high (slow overtaking pass)
    [0.2, -0.3, -0.9], [-0.2, -0.3, -0.9],     // 6 low (sneak attack on the low squadron)
    [0.7, 0.45, -0.6], [-0.7, 0.45, -0.6],     // high rear quarter
  ];
  let aiActive = 0;
  let lastBanditCall = -99;
  function norm3(x, y, z) { const l = Math.hypot(x, y, z) || 1; return { x: x / l, y: y / l, z: z / l }; }
  function targetPoint(t) {
    if (t && t.kind === "friendly" && friendlyOk(t.f)) return { x: t.f.x, y: t.f.y, z: t.f.z };
    return { x: 0, y: BOMBER_AIM_Y, z: 0 };
  }
  // AIR-frame nose direction that makes the BOX-frame track point at (tx,ty,tz)
  function airDirTo(e, tx, ty, tz) {
    const u = norm3(tx - e.x, ty - e.y, tz - e.z);
    const V = Math.max(e.V, VF + 4);
    const b = VF * u.z;
    const sBox = -b + Math.sqrt(Math.max(0, b * b - VF * VF + V * V));
    return norm3(sBox * u.x, sBox * u.y, sBox * u.z + VF);
  }
  function boxClosing(u, V) { // box-frame speed achievable along unit u at airspeed V
    const b = VF * u.z;
    return -b + Math.sqrt(Math.max(0, b * b - VF * VF + V * V));
  }
  // ===== 1.3.6 Bf 109 FLIGHT MODEL — body axes: nose h + canopy/lift-up u (no horizon-frame flip) =====
  // Flown in the AIR frame, which is the GROUND frame (no wind): ground speed = V along the nose.
  // The box frame only re-bases positions: box-frame velocity = V·h − (0,0,VF). The renderer draws the
  // nose along h and the canopy along u, so the model always flies where its nose points (world),
  // banks into its turns (lift is only along u → coordinated bank = atan(V·ω/g)), with a roll-rate and
  // roll-acceleration limit so roll-in/roll-out is visible.
  function levelUpOf(hx, hy, hz) { // world-up projected ⊥ the nose (null when the nose is ~vertical)
    const x = -hy * hx, y = 1 - hy * hy, z = -hy * hz, l = Math.hypot(x, y, z);
    return l < 0.08 ? null : { x: x / l, y: y / l, z: z / l };
  }
  function flyStep(e, dx, dy, dz, dt, gain) {
    const d = norm3(dx, dy, dz);
    let hx = e.hx, hy = e.hy, hz = e.hz, ux = e.ux, uy = e.uy, uz = e.uz;
    const V = e.V;
    const c = clamp(hx * d.x + hy * d.y + hz * d.z, -1, 1);
    const th = Math.acos(c);
    let wx = d.x - c * hx, wy = d.y - c * hy, wz = d.z - c * hz;
    const wl = Math.hypot(wx, wy, wz);
    if (wl > 1e-5) { wx /= wl; wy /= wl; wz /= wl; } else { wx = ux; wy = uy; wz = uz; }
    const nMaxE = e.nMax || FAI.nMax, rrE = e.rollRate || FAI.rollRate, raE = e.rollAcc || FAI.rollAcc;
    const wRate = Math.min(th * (gain || 1.6), Math.sqrt(Math.max(0.04, nMaxE * nMaxE - 1)) * G_U / V); // nMax = total load factor; the turn gets the part beyond 1 g
    const gpx = G_U * hy * hx, gpy = -G_U + G_U * hy * hy, gpz = G_U * hy * hz; // gravity ⊥ path
    const ax = wx * V * wRate - gpx, ay = wy * V * wRate - gpy, az = wz * V * wRate - gpz; // wanted lift
    const aMag = Math.hypot(ax, ay, az);
    const lvl = levelUpOf(hx, hy, hz);
    let tx, ty, tz;
    if (aMag < G_U * 0.25) { if (lvl) { tx = lvl.x; ty = lvl.y; tz = lvl.z; } else { tx = ux; ty = uy; tz = uz; } }
    else {
      tx = ax / aMag; ty = ay / aMag; tz = az / aMag;
      // small pushes are flown with negative g, not by rolling inverted (unless a Split-S is wanted)
      const pushLim = e.type === "p51" ? 99 : e.phase === "attack" && e.phaseT > 1.0 ? 1.9 : 1.0; // Mustangs never roll inverted to follow a target down // 1.3.7: attackers roll upright and push rather than stay inverted
      if (!e.invert && aMag < G_U * pushLim && tx * ux + ty * uy + tz * uz < -0.2) { tx = -tx; ty = -ty; tz = -tz; }
      if (e.type === "p51" && lvl && tx * lvl.x + ty * lvl.y + tz * lvl.z < 0) { tx = -tx; ty = -ty; tz = -tz; } // stay upright: push over (negative g, floored at -1 g) instead of rolling inverted
    }
    const crx = uy * tz - uz * ty, cry = uz * tx - ux * tz, crz = ux * ty - uy * tx;
    const phiErr = Math.atan2(crx * hx + cry * hy + crz * hz, ux * tx + uy * ty + uz * tz);
    const pCmd = clamp(phiErr * 3.0, -rrE, rrE);
    const p0 = e.p || 0;
    e.p = p0 + clamp(pCmd - p0, -raE * dt, raE * dt);
    { // roll u about h (Rodrigues, u ⊥ h)
      const a = e.p * dt, ca = Math.cos(a), sa = Math.sin(a);
      const kx = hy * uz - hz * uy, ky = hz * ux - hx * uz, kz = hx * uy - hy * ux;
      ux = ux * ca + kx * sa; uy = uy * ca + ky * sa; uz = uz * ca + kz * sa;
    }
    const lift = clamp(ax * ux + ay * uy + az * uz, -1.0 * G_U, nMaxE * G_U); // lift only along u
    const pax = ux * lift + gpx, pay = uy * lift + gpy, paz = uz * lift + gpz;
    hx += (pax / V) * dt; hy += (pay / V) * dt; hz += (paz / V) * dt;
    const hl = Math.hypot(hx, hy, hz) || 1; hx /= hl; hy /= hl; hz /= hl;
    const du = ux * hx + uy * hy + uz * hz; ux -= du * hx; uy -= du * hy; uz -= du * hz;
    const ul = Math.hypot(ux, uy, uz) || 1;
    e.hx = hx; e.hy = hy; e.hz = hz; e.ux = ux / ul; e.uy = uy / ul; e.uz = uz / ul;
    e.turnW = Math.hypot(pax, pay, paz) / V;
    const n = lift / G_U;
    const vT = e.vT || FAI.vFull;
    let dV = -G_U * hy + 0.09 * (vT - V) - 0.25 * Math.max(0, Math.abs(n) - 1.5);
    { const vc = e.vCap || FAI.vDive; if (V > vc) dV -= 1.2 * (V - vc); }
    e.V = Math.max(e.vMin || FAI.vMin, V + dV * dt);
    e.gLoad = n; if (e.type === "p51") e.dbg = { th: +th.toFixed(2), a: +(aMag / G_U).toFixed(2), n: +n.toFixed(2), wl: +(wRate * V / G_U).toFixed(2) };
    e.vx = e.V * e.hx; e.vy = e.V * e.hy; e.vz = e.V * e.hz - VF;
    // bank relative to the horizon (+ = left wing down) — for tests/HUD; the renderer uses u directly
    const L2 = levelUpOf(e.hx, e.hy, e.hz);
    if (L2) {
      const cx2 = e.uy * L2.z - e.uz * L2.y, cy2 = e.uz * L2.x - e.ux * L2.z, cz2 = e.ux * L2.y - e.uy * L2.x;
      e.bank = Math.atan2(cx2 * e.hx + cy2 * e.hy + cz2 * e.hz, e.ux * L2.x + e.uy * L2.y + e.uz * L2.z);
    }
    e.phi = e.bank;
  }
  function initAttitude(e, h, bank) { // set nose h and a canopy-up rolled `bank` (+left) from level
    const hh = norm3(h.x, h.y, h.z);
    e.hx = hh.x; e.hy = hh.y; e.hz = hh.z;
    const L = levelUpOf(hh.x, hh.y, hh.z) || { x: 0, y: 0, z: 1 };
    const lx = hh.y * L.z - hh.z * L.y, ly = hh.z * L.x - hh.x * L.z, lz = hh.x * L.y - hh.y * L.x; // h × up = right… use up × h = left
    const b = bank || 0, cb = Math.cos(b), sb = Math.sin(b);
    e.ux = L.x * cb - lx * sb; e.uy = L.y * cb - ly * sb; e.uz = L.z * cb - lz * sb;
    e.p = 0; e.bank = b; e.phi = b;
    e.vx = e.V * e.hx; e.vy = e.V * e.hy; e.vz = e.V * e.hz - VF;
  }
  // steering modifiers: collision avoidance (turret glass, B-17s), deck, energy
  function safeDir(e, d) {
    let dx = d.x, dy = d.y, dz = d.z;
    const vb = Math.hypot(e.vx, e.vy, e.vz) || 1;
    const avoid = (ox, oy, oz, R, w) => {
      const rx = ox - e.x, ry = oy - e.y, rz = oz - e.z;
      const tca = clamp((rx * e.vx + ry * e.vy + rz * e.vz) / (vb * vb), 0, 2.2);
      if (tca <= 0 || Math.hypot(rx, ry, rz) > vb * 2.4 + R) return;
      const mx = e.x + e.vx * tca - ox, my = e.y + e.vy * tca - oy, mz = e.z + e.vz * tca - oz;
      const m = Math.hypot(mx, my, mz);
      if (m >= R) return;
      const k = w * (1 - m / R) / (m || 1);
      dx += (m ? mx : 0) * k; dy += (m ? my : 1) * k; dz += (m ? mz : 0) * k;
    };
    avoid(CAM.x, CAM.y, CAM.z, FAI.camMiss, 2.5);
    for (const f of friendlies) if (friendlyOk(f)) avoid(f.x, f.y, f.z, 11, 1.8);
    { const vm = e.vMin || FAI.vMin, vs = e.vSlow || FAI.vSlow; if (e.V < vs && dy > 0) dy *= Math.max(0, (e.V - vm) / (vs - vm)); } // no stall-climbs
    const yPred = e.y + Math.min(0, e.vy) * 6; // look 6 s ahead: pull out of dives in time (deck wins)
    if (yPred < FAI.floorY + 90) {
      // deck first: wings level-ish along the current track and pull
      const hl0 = Math.hypot(e.hx, e.hz) || 1, dl = Math.hypot(dx, dy, dz) || 1;
      dx = dx / dl * 0.3 + e.hx / hl0 * 0.7; dz = dz / dl * 0.3 + e.hz / hl0 * 0.7;
      const hx0 = Math.hypot(dx, dz) || 1, want = clamp(0.15 + (FAI.floorY + 90 - yPred) * 0.004, 0.15, 0.6);
      dy = Math.max(dy / dl, want * hx0);
    }
    return norm3(dx, dy, dz);
  }
  function slopeLimit(e, d, lo, hi) { // limit the path slope dy/horizontal to [lo,hi]
    let hx = d.x, hz = d.z, hl = Math.hypot(hx, hz);
    if (hl < 0.2) { hx = e.hx; hz = e.hz; const l2 = Math.hypot(hx, hz) || 1; hx = hx / l2 * 0.2 + d.x; hz = hz / l2 * 0.2 + d.z; hl = Math.hypot(hx, hz) || 1; }
    const s = clamp(d.y / hl, lo, hi);
    return norm3(hx / hl, s, hz / hl);
  }
  // ===== 1.3.6 LUFTWAFFE TACTICS — high-speed slashing passes, no pacing, no loitering =====
  // Sources (see ITERATION_LOG): VIII BC 3rd BD encounter study (Nov 1943), Hackl/Regensburg, Egon Mayer.
  //  • Staffel 1: line abreast 12 o'clock high, diving head-on at the lead element (first shots ≈11 s).
  //  • Staffel 2: from ~35,000 ft, rolls over into a full-dive head-on pass.
  //  • Staffeln 3/4: Rotten arriving from far ahead (out of sight at first) every ~8 s, alternating
  //    head-on and 10:30 / 1:30 high front-quarter diving passes (the old flank "double queue" that
  //    paced the box is gone). Every pass: a short burst at the ENGINES, a break at speed (Split-S,
  //    slicing wing-over, dive under or zoom), then extend 2.5 km+ away.
  //  • Re-attacks: they reform far out (3.5 km on a flank, a speck) and only come again when they
  //    are ahead of the box — or when the box's turn for home swings them ahead.
  const TAC = {
    // 1.5.0 (spec §1): 109 = the slash (open 700–900 yd, cease by ~100 m); 190 = the hammer (opens 400–600 yd, presses); ranges in world units (1 yd = 0.61 u)
    fire: { headon: [520, 85], fq: [480, 88], reattack: [480, 88], stern: [330, 85], lowq: [330, 90], rear: [420, 100] },
    brk: { headon: 70, fq: 72, reattack: 75, stern: 78, lowq: 70, rear: 80 },
    reformLat: [850, 1050], stationZ: [250, 850], stationUp: 380,
    waveGap: [7, 11], waveN: [3, 4], firstWave: 34, stationMax: 3,
    presserFrac: 0.34, presserBrk: [75, 95],
    ammo: 4,                  // passes per 109 ("three good passes and a 109 or 190 is dry")
    ammo190: 3,
    arriveV: 425,
    pairGap: 19, pairFirst: 29,
  };
  function pickFormationTarget(attacker, mode) {
    const live = friendlies.filter(friendlyOk);
    const pf = mode === "headon" ? TUNE.playerTargetFrac * 1.3 : TUNE.playerTargetFrac;
    if (!live.length || (!(bomber && bomber.dead) && Math.random() < pf)) return { kind: "player" };
    let sum = 0;
    const side = attacker.x > BOX_C.x ? 1 : -1;
    const w = live.map((f) => {
      const d = Math.hypot(attacker.x - f.x, attacker.y - f.y, attacker.z - f.z);
      let v = 1 / (1 + d * 0.0012);
      if (mode === "headon") v *= (f.sq === "lead" ? 2.2 : 1) * (f.el != null && f.el < 3 ? 1.8 : 1); // the lead element
      else v *= (f.sq === "low" ? 1.8 : 1) * (1 + Math.max(0, (f.x - BOX_C.x) * side) / 60); // outer ships on the attack side
      v *= (f.health < 45 ? 4 : f.health < 70 ? 2.2 : f.health < 88 ? 1.4 : 1) * (1 + (f.straggle || 0) * 4) * (1 + engineOutCount(f.engines) * 1.5); if (f.out) v *= 3; // 1.5.7: a straggler is the easy kill
      sum += v;
      return v;
    });
    let r = Math.random() * sum;
    for (let i = 0; i < live.length; i++) { r -= w[i]; if (r <= 0) return { kind: "friendly", f: live[i] }; }
    return { kind: "friendly", f: live[0] };
  }
  // 1.4.1: a "presser" goes for the ship nearest ours (sometimes us) so the pass comes by within ~200–400 m
  function presserTarget() {
    if (!(bomber && bomber.dead) && Math.random() < 0.22) return { kind: "player" };
    let best = null, bd = 1e9;
    for (const f of friendlies) { if (!friendlyOk(f)) continue; const d = Math.hypot(f.x, f.y - BOMBER_AIM_Y, f.z) * rand(0.8, 1.25); if (d < bd) { bd = d; best = f; } }
    return best ? { kind: "friendly", f: best } : { kind: "player" };
  }
  // ----- 1.5.0 targeting helpers -----
  function att190Count(f) { let n = 0; for (const q of enemies) if (q.alive && q.type === "190" && q.phase === "attack" && q.tgt && q.tgt.kind === "friendly" && q.tgt.f === f) n++; return n; }
  function pick190Target(e) { // the hammer: tail-end / low / trailing ships, stragglers; never more than 2–3 of them on one bomber
    if (e.hunt && huntOk(e.hunt)) return e.hunt; // 1.5.2: lone-ship hunting — a straggler draws the company front
    const live = friendlies.filter(friendlyOk);
    if (!live.length) return { kind: "player" };
    let sum = 0;
    const w = live.map((f) => {
      let v = 1 * (f.sq === "low" ? 1.5 : 1) * (f.el != null && f.el >= 3 ? 1.5 : 1) * (f.el === 6 ? 2.2 : 1) * (f.out ? 8 : 1) * (f.health < 70 ? 1.4 : 1);
      const d = Math.abs(f.x - e.x);
      v *= 1 / (1 + d * 0.004);
      const n = att190Count(f) + (e.frontPick && e.frontPick.get ? (e.frontPick.get(f) || 0) : 0);
      if (n >= 2) v = 0; else if (n >= 1) v *= 0.22; // spec: cap 2 (rarely 3) 190s on one bomber — mostly one
      sum += v; return v;
    });
    if (!(bomber && bomber.dead) && Math.random() < TUNE.p190Player) return { kind: "player" };
    if (sum <= 0) return { kind: "friendly", f: live[(Math.random() * live.length) | 0] };
    let r = Math.random() * sum;
    for (let i = 0; i < live.length; i++) { r -= w[i]; if (r <= 0) return { kind: "friendly", f: live[i] }; }
    return { kind: "friendly", f: live[0] };
  }
  function p51OnTail(e, R) { // a Mustang inside ~800 yd and closing on this German
    for (const q of enemies) {
      if (!q.alive || q.type !== "p51") continue;
      const dx = e.x - q.x, dy = e.y - q.y, dz = e.z - q.z, d = Math.hypot(dx, dy, dz);
      if (d > R || d < 1) continue;
      const cs = (q.hx * dx + q.hy * dy + q.hz * dz) / d;
      const clos = -((e.vx - q.vx) * dx + (e.vy - q.vy) * dy + (e.vz - q.vz) * dz) / d;
      if (cs > 0.8 && clos > 5) return q;
    }
    return null;
  }
  function p51OnHim(e, R) { // a Mustang that is actually hunting THIS German (intercept, target = him) with its nose on him inside R
    for (const q of enemies) {
      if (!q.alive || q.type !== "p51" || q.phase !== "intercept" || q.target !== e) continue;
      const dx = e.x - q.x, dy = e.y - q.y, dz = e.z - q.z, d = Math.hypot(dx, dy, dz);
      if (d > R || d < 1) continue;
      if ((q.hx * dx + q.hy * dy + q.hz * dz) / d > 0.8) return q;
    }
    return null;
  }
  function openPass(e, mode) {
    const ps = { type: e.type, mode, t0: mission ? mission.t : 0, bursts: 0, minR: 1e9, tgt: e.tgt && e.tgt.kind === "friendly" ? e.tgt.f : bomber, hit: false, p51: false, drive: false, done: false, outBefore: false };
    ps.outBefore = !!(ps.tgt && ps.tgt.out);
    e.ps = ps;
    if (mission) { (mission.passOpen || (mission.passOpen = [])).push(ps); (mission.passHist || (mission.passHist = [])).push(ps); }
  }
  function settlePasses() {
    const m = mission; if (!m || !m.passOpen) return;
    const A = m.passAgg || (m.passAgg = {});
    for (let i = m.passOpen.length - 1; i >= 0; i--) {
      const ps = m.passOpen[i];
      if (m.t < ps.t0 + 22 || ps.settle === false) continue;
      m.passOpen.splice(i, 1);
      if (ps.bursts <= 0 && !ps.hitFirst) continue;
      const t = ps.tgt, left = !!(t && !ps.outBefore && t.out && (t.outAt || 0) >= ps.t0 - 0.5);
      const ovl = m.passHist.some((o) => o !== ps && o.tgt === ps.tgt && o.bursts > 0 && Math.abs(o.t0 - ps.t0) < 12) ? "_ovl" : "_iso";
      const fr = ps.h0 == null ? (t && t.sd ? FC.health(t.sd) : 100) >= 92 : ps.h0 >= 92;
      const key = (ps.type === "109" ? (ps.hitFirst ? "109_hitfirst" : ps.hit ? "109_hitlate" : "109_clean") : (ps.minR <= 244 ? "190_400yd" : "190_short") + (ps.shared ? "_shared" : "_solo") + (ps.p51 ? "_p51" : "")) + (fr ? "_fresh" : "_hurt") + ovl;
      const a = A[key] || (A[key] = { n: 0, leave: 0 });
      a.n++; if (left) a.leave++;
    }
  }
  function recAz190(e, T, range) { // 1.5.5 telemetry: where (clock position from the target's nose / elevation) was this 190 when it crossed 1500 u, 900 u, 800 yd (488 u), 400 yd (244 u)
    if (e.type !== "190" || !mission) return;
    if (!e.azRec) e.azRec = {};
    for (const rr of [1500, 900, 488, 244]) if (range < rr && e.azRec[rr] == null) {
      const dx = e.x - T.x, dz = e.z - T.z, ang = Math.atan2(-dx, dz), clk = (((ang / TAU) * 12) % 12 + 12) % 12, el = Math.atan2(e.y - T.y, Math.hypot(dx, dz)) * 57.2958;
      e.azRec[rr] = { clk: +clk.toFixed(2), el: +el.toFixed(1), t: +mission.t.toFixed(1), mode: e.mode || e.phase, ship: e.tgt && e.tgt.kind === "friendly" ? "f" : "p", V: +(e.V / MPH).toFixed(0) };
      (mission.az190 || (mission.az190 = [])).push(Object.assign({ r: rr, id: e.id }, e.azRec[rr]));
    }
  }
  function commitPass(e, mode) {
    mode = mode || "headon";
    e.mode = mode;
    const is190 = e.type === "190";
    if (is190) e.tgt = pick190Target(e);
    else if (e.leader && e.leader.alive && e.leader.phase === "attack" && e.leader.tgt &&
      (e.leader.tgt.kind !== "friendly" || friendlyOk(e.leader.tgt.f))) e.tgt = e.leader.tgt; // the Rotte hits one ship
    else e.tgt = pickFormationTarget(e, mode);
    if (e.tgtPre) { if (e.tgtPre.kind !== "friendly" || friendlyOk(e.tgtPre.f)) e.tgt = e.tgtPre; e.tgtPre = null; }
    if (e.hunt && huntOk(e.hunt)) e.tgt = e.hunt;
    if (mission && e.tgt && e.tgt.kind === "player" && mission.playerOutT != null) { mission.stragPasses = (mission.stragPasses || 0) + 1; if (is190) mission.strag190Passes = (mission.strag190Passes || 0) + 1; }
    if (e.presser && !is190) e.tgt = presserTarget(); // 1.4.1: presses in on the ships right next to us
    const T = targetPoint(e.tgt);
    let d = norm3(T.x - e.x, T.y - e.y, T.z - e.z);
    let px = rand(-1, 1), py = rand(-0.5, 0.5), pz = rand(-1, 1); // slash past, never ram
    if (mode === "fq") py = -Math.abs(py) - 0.5; // diving through, pass under
    if (is190) e.pass190n = (e.pass190n || 0) + 1;
    if (is190) { py = -1.1; px = rand(0.7, 1) * (Math.random() < 0.5 ? -1 : 1); pz = 0; } // 190: through or under, off to one side
    const dp = px * d.x + py * d.y + pz * d.z;
    px -= dp * d.x; py -= dp * d.y; pz -= dp * d.z;
    const pl = Math.hypot(px, py, pz) || 1;
    const onUs = !e.tgt || e.tgt.kind !== "friendly";
    const miss = onUs ? rand(38, 52) : is190 ? rand(14, 22) : rand(FAI.shipMiss[0], FAI.shipMiss[1]);
    let ax = T.x + (px / pl) * miss, ay = T.y + (py / pl) * miss, az = T.z + (pz / pl) * miss;
    for (let it = 0; it < 4; it++) { // keep the run line clear of the turret glass
      d = norm3(ax - e.x, ay - e.y, az - e.z);
      const tc = (CAM.x - e.x) * d.x + (CAM.y - e.y) * d.y + (CAM.z - e.z) * d.z;
      const qx = e.x + d.x * tc - CAM.x, qy = e.y + d.y * tc - CAM.y, qz = e.z + d.z * tc - CAM.z;
      const q = Math.hypot(qx, qy, qz);
      if (q >= FAI.camMiss) break;
      const k = (FAI.camMiss - q + 6) / (q || 1);
      ax += (q ? qx : 1) * k; ay += (q ? qy : 0) * k; az += (q ? qz : 0) * k;
    }
    e.aimPt = { x: ax, y: ay, z: az };
    e.runDir = d;
    e.phase = "attack"; e.phaseT = 0; e.vT = FAI.vFull; e.invert = false;
    e.fireWin = TAC.fire[mode] || TAC.fire.headon;
    e.breakR = (TAC.brk[mode] || 120) * rand(0.9, 1.1);
    if (is190) { e.fireWin = [rand(250, 366), 80]; e.breakR = rand(74, 96); if (mission && !mission.called190) { mission.called190 = true; pushCallout("FW190s " + clockLabel(e.x - T.x, e.z - T.z) + " — LOW!", 1.8, true); sfxIntercom(); } } // 1.5.5: the hammer opens at 400-600 yd (244-366 u) and presses to ~130 yd
    e.az190 = null;
    if (e.presser && !is190) e.breakR = rand(TAC.presserBrk[0], TAC.presserBrk[1]);
    const r = Math.random();
    e.breakType = is190 ? "under" : r < 0.55 ? "splitS" : "under"; // 109: Split-S or under the box — no lazy pull-up in front of the top turret
    e.burstsLeft = is190 ? TUNE.bursts190 : TUNE.burstsPerPass; e.burst = null; e.burstGap = 0; e.firedPass = false;
    e.fireCd = 0;
    openPass(e, mode);
    if (mission) { mission.passes = (mission.passes || 0) + 1; const ms = mission.modeStats || (mission.modeStats = {}); (ms[mode] || (ms[mode] = { p: 0, b: 0 })).p++; }
    if (!is190 && elapsed - lastBanditCall > 5 && mission && !mission.bombsAway) {
      lastBanditCall = elapsed;
      const rel = e.y - BOMBER_AIM_Y;
      pushCallout("BANDITS " + clockLabel(e.x, e.z) + (rel > 45 ? " HIGH" : rel < -30 ? " LOW" : ""), 1.1);
    }
  }
  // setup point for a pass from ahead: head-on (12 high) or front quarter (10:30 / 1:30 high)
  function frontSetup(mode, side, type) {
    if (type === "190") return { x: BOX_C.x + side * 420, y: BOX_C.y + 360, z: BOX_C.z + 1500 }; // 1.5.4: 190s dive through the front quarter at full speed
    if (mode === "fq") return { x: BOX_C.x + side * 380, y: BOX_C.y + 440, z: BOX_C.z + 1250 }; // 1.3.6: ~11 o'clock high (1.4.1: 1700 → 1250 ahead, closer in)
    return { x: BOX_C.x + side * 90, y: BOX_C.y + 240, z: BOX_C.z + 1300 };
  }
  // engine nacelle world position on a friendly (box frame) / on our own ship
  const OWN_ENG = [[8.3, -2.4, 3.2], [4.3, -2.6, 3.5], [-4.3, -2.6, 3.5], [-8.3, -2.4, 3.2]]; // eye-relative, own-ship units ≈ box units near the eye
  function enginePos(tgt, k) {
    if (tgt && tgt.kind === "friendly" && tgt.f) {
      const f = tgt.f, c = Math.cos(f.yaw || 0), s = Math.sin(f.yaw || 0);
      const lx = FF_ENG_X[k], lz = 2.4;
      return { x: f.x + lx * c + lz * s, y: f.y - 0.2, z: f.z - lx * s + lz * c };
    }
    const o = OWN_ENG[k] || OWN_ENG[1];
    return { x: CAM.x + o[0] * 0.55, y: CAM.y + o[1] * 0.55, z: CAM.z + o[2] * 0.55 };
  }
  // ===== 1.5.0 FIGHTER GUNS — every round is traced against the per-part hitboxes of the B-17s (first box wins) =====
  // 109 (G-6): MG 151/20 hub + 2× MG 131 cowl · 190 (A-8): 2× MG 131 + 4× MG 151/20 (outer pair → MK 108 on a Sturmbock) · +20 % of wave-2 109s carry R6 gondolas (+2× 20 mm).
  // off = [lateral (port +), vertical] from the fighter's centre in its own axes.
  const GUNSET_109 = [{ g: "mg151", rate: 700 / 60, off: [0, 0.1] }, { g: "mg131", rate: 15, off: [0.45, 0.35] }, { g: "mg131", rate: 15, off: [-0.45, 0.35] }];
  const GUNSET_109R6 = GUNSET_109.concat([{ g: "mg151", rate: 700 / 60, off: [1.7, -0.2] }, { g: "mg151", rate: 700 / 60, off: [-1.7, -0.2] }]);
  const GUNSET_190 = [{ g: "mg131", rate: 15, off: [0.5, 0.35] }, { g: "mg131", rate: 15, off: [-0.5, 0.35] }, { g: "mg151", rate: 700 / 60, off: [1.4, 0] }, { g: "mg151", rate: 700 / 60, off: [-1.4, 0] }, { g: "mg151", rate: 700 / 60, off: [2.6, 0] }, { g: "mg151", rate: 700 / 60, off: [-2.6, 0] }];
  const GUNSET_190S = GUNSET_190.slice(0, 4).concat([{ g: "mk108", rate: 650 / 60, off: [2.6, 0] }, { g: "mk108", rate: 650 / 60, off: [-2.6, 0] }]);
  function gunSetOf(e) { return e.type === "190" ? (e.sturm ? GUNSET_190S : GUNSET_190) : (e.r6 ? GUNSET_109R6 : GUNSET_109); }
  function gaussR() { return (Math.random() + Math.random() + Math.random() + Math.random() - 2) * 1.2247; }
  function shipTargetOf(e) { // the B-17 this fighter's pass is on
    if (!e.tgt) return null;
    if (e.tgt.kind === "friendly") return friendlyOk(e.tgt.f) ? e.tgt.f : null;
    return bomber && !bomber.dead ? bomber : null;
  }
  // 1.5.0: a Mustang on his tail spoils the shot (spec: aim jitter in the 1-second window)
  function pressureOn(e) {
    for (const q of enemies) if (q.alive && q.type === "p51" && q.target === e && q.phase === "intercept" && (q.x - e.x) * (q.x - e.x) + (q.y - e.y) * (q.y - e.y) + (q.z - e.z) * (q.z - e.z) < 500 * 500) return TUNE.p51Jit;
    return 1;
  }
  function startBurst(e, ship) {
    const is190 = e.type === "190", ae = is190 ? TUNE.aim190 : TUNE.aim109, du = is190 ? TUNE.burst190 : TUNE.burst109;
    const aimMode = is190 ? "hammer" : e.mode === "rear" ? "beam" : "slash";
    e.burst = { t: 0, dur: rand(du[0], du[1]), ship, aimId: FC.pickAimBox(aimMode), ba: gaussR() * ae[0] / 1000, bb: gaussR() * ae[0] / 1000, sr: ae[1] / 1000, acc: [0, 0, 0, 0, 0, 0, 0], jit: 1, snd: 0, trc: 0, hits: 0, rounds: 0, fxT: 0 };
    e.flash = Math.max(e.flash || 0, 0.35);
    if (mission) { const fs = mission.fireSpeeds || (mission.fireSpeeds = []); if (fs.length < 120) fs.push({ ty: e.type, m: e.mode, t: +mission.t.toFixed(1), V: Math.round(e.V / MPH), cl: Math.round(Math.hypot(e.vx, e.vy, e.vz) / MPH), r: e.dbg ? e.dbg.range : null }); }
    if (e.ps) { e.ps.bursts++; if (e.ps.h0 == null) e.ps.h0 = FC.health(ship.sd); }
    if (is190 && e.tgt && e.tgt.kind === "friendly" && att190Count(e.tgt.f) > 1) for (const q of enemies) if (q.alive && q.type === "190" && q.tgt && q.tgt.f === e.tgt.f && q.ps) q.ps.shared = true;
    if (onUsCheck(e) && mission && elapsed - mission.lastIncoming > 4) {
      mission.lastIncoming = elapsed;
      pushCallout("INCOMING " + clockLabel(e.x, e.z).replace(" O'CLOCK", ""), 0.8);
    }
  }
  function onUsCheck(e) { return !e.tgt || e.tgt.kind !== "friendly"; }
  const _rs = { id: null, s: null, t: 0, x: 0, y: 0, z: 0 };
  // nearest hitbox strike along a world segment among every live B-17 (the one aimed at, or whoever stands behind it)
  function rayShips(mx, my, mz, dx, dy, dz, maxT) {
    let best = null, bt = 1e9;
    const test = (s) => {
      const c = s === bomber ? CAM : s;
      const rx = c.x - mx, ry = c.y - my, rz = c.z - mz;
      const al = clamp(rx * dx + ry * dy + rz * dz, 0, maxT);
      const px = rx - dx * al, py = ry - dy * al, pz = rz - dz * al, lim = s === bomber ? 20 : 13;
      if (px * px + py * py + pz * pz > lim * lim) return;
      const h = segShip(s, mx, my, mz, mx + dx * maxT, my + dy * maxT, mz + dz * maxT);
      if (h && h.t * maxT < bt) { bt = h.t * maxT; best = { s, id: h.id, t: bt, x: h.x, y: h.y, z: h.z }; }
    };
    if (bomber && !bomber.dead) test(bomber);
    for (const f of friendlies) if (friendlyOk(f)) test(f);
    return best;
  }
  function holeAt(s, ax, ay, az, bx, by, bz, size) { // bullet hole on the rendered skin (throttled)
    if (!World3D || !World3D.rayShip || !World3D.addHole) return;
    if (elapsed - (s.holeT || 0) < 0.08) return;
    s.holeT = elapsed;
    const isP = s === bomber, slot = isP ? "own" : (s.slot != null ? s.slot : 0);
    const ray = World3D.rayShip(slot, ax, ay, az, bx, by, bz, isP ? ownRayPose(ownPose()) : friendlyRayPose(s));
    if (ray) World3D.addHole(slot, ray, size);
    s.holeN = (s.holeN || 0) + 1;
    if (ray && World3D.addTear && (size >= 0.19 ? Math.random() < 0.5 : s.holeN % 9 === 0)) { fx154.n.tears++; World3D.addTear(slot, ray, (size >= 0.19 ? 0.7 : 0.45) + Math.min(0.7, s.holeN * 0.012)); } // 1.5.4: torn skin with exposed ribs, bigger as the damage piles up
  }
  function fighterFireTick(e, dt) {
    const b = e.burst; if (!b) return;
    const ship = b.ship;
    b.t += dt;
    if (((b.pc = (b.pc || 0) + 1) & 3) === 0) b.jit = Math.max(b.jit, pressureOn(e));
    if (!shipLive(ship) || b.t > b.dur) { e.burst = null; e.burstGap = rand(0.5, 0.8); return; }
    const a = frameAngles(ship), c = FC.boxCenter(b.aimId), aw = fromShipA(a, c[0], c[1], c[2]);
    const sx = e.uy * e.hz - e.uz * e.hy, sy = e.uz * e.hx - e.ux * e.hz, sz = e.ux * e.hy - e.uy * e.hx; // port side
    const set = gunSetOf(e), isP = ship === bomber, src = e.type;
    e.mf = 0.1; b.snd -= dt; if (b.snd <= 0) { b.snd = 0.14; if (window.FGAudio) window.FGAudio.enemyGun(e.x, e.y, e.z); }
    for (let gi = 0; gi < set.length; gi++) {
      const G = set[gi]; b.acc[gi] += G.rate * dt;
      while (b.acc[gi] >= 1) {
        b.acc[gi] -= 1; b.rounds++;
        const mx = e.x + e.hx * 2.6 + sx * G.off[0] + e.ux * G.off[1], my = e.y + e.hy * 2.6 + sy * G.off[0] + e.uy * G.off[1], mz = e.z + e.hz * 2.6 + sz * G.off[0] + e.uz * G.off[1];
        let dx = aw[0] - mx, dy = aw[1] - my, dz = aw[2] - mz;
        const range = Math.hypot(dx, dy, dz) || 1; dx /= range; dy /= range; dz /= range;
        // two axes ⊥ the line of fire
        let rx = -dz, rz = dx; const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
        const ux2 = dy * rz, uy2 = dz * rx - dx * rz, uz2 = -dy * rx;
        const ea = (b.ba + gaussR() * b.sr) * b.jit, eb = (b.bb + gaussR() * b.sr) * b.jit;
        let fx = dx + rx * ea + ux2 * eb, fy = dy + uy2 * eb, fz = dz + rz * ea + uz2 * eb;
        const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
        if ((++b.trc & 3) === 1) { // a visible tracer every 4th round, bent away from the glass when we are the target
          let vx = fx, vy = fy, vz = fz;
          if (isP) {
            const cx = CAM.x - mx, cy = CAM.y - my, cz = CAM.z - mz, al = cx * vx + cy * vy + cz * vz;
            const px = cx - vx * al, py = cy - vy * al, pz = cz - vz * al, pd = Math.hypot(px, py, pz);
            if (al > 0 && pd < 5.5) { const k = (5.5 - pd) / Math.max(40, al), qx = pd > 1e-3 ? -px / pd : 1, qy = pd > 1e-3 ? -py / pd : 0, qz = pd > 1e-3 ? -pz / pd : 0; vx += qx * k; vy += qy * k; vz += qz * k; const vl = Math.hypot(vx, vy, vz); vx /= vl; vy /= vl; vz /= vl; }
          }
          const V = BULLET_UPS; // 1.5.1: same muzzle speed as the player's tracers (was 520)
          tracers.push({ x: mx + vx * 2, y: my + vy * 2, z: mz + vz * 2, vx: vx * V + e.vx, vy: vy * V + e.vy, vz: vz * V + e.vz, life: Math.min(1.8, range / 400 + 0.35), maxLife: 1.8, trav: 0, team: "axis", hid: false, k190: src === "190" }); // 1.5.3: 190 tracers are RED. 1.5.1: 1 round in 4 glows, like the player's
        }
        const h = rayShips(mx, my, mz, fx, fy, fz, range + 70);
        if (!h) continue;
        const gun = FC.GUNS[G.g], rf = FC.rangeFactor(gun, FC.toYd(h.t));
        if (Math.random() > rf) continue;
        b.hits++;
        shipHit(h.s, h.id, G.g, rf, src, { dm: src === "190" ? (e.sturm ? TUNE.dmgMulSturm : TUNE.dmgMul190) : TUNE.dmgMul109 });
        if (mission) mission.gunHits = (mission.gunHits || 0) + 1;
        if (Math.random() < 0.7) for (let i = 0; i < 2; i++) particles.push({ x: h.x, y: h.y, z: h.z, vx: rand(-9, 9), vy: rand(-3, 9), vz: rand(-9, 9), life: rand(0.1, 0.25), max: 0.25, kind: "spark", r: rand(1, 2.2) });
        if (Math.random() < 0.55) particles.push({ x: h.x, y: h.y, z: h.z, vx: rand(-8, 8), vy: rand(2, 12), vz: rand(-8, 8), life: rand(0.4, 0.8), max: 0.8, kind: "chip", r: rand(0.9, 1.8) });
        hitCluster(h.x, h.y, h.z, 0, 0, 0, G.g === "mk108" || G.g === "mg151", h.s === bomber ? 0.3 : 1);
        holeAt(h.s, mx, my, mz, mx + fx * (range + 70), my + fy * (range + 70), mz + fz * (range + 70), G.g === "mk108" ? 0.3 : G.g === "mg151" ? 0.2 : 0.13);
      }
    }
  }

  // ===== 1.5.2 P-51D — escort in flights of four (see /workspace/fg_152/ESCORT_TACTICS.md) =====
  // 5 flights × 4 (two 2-ship elements, loose deuce): ahead-high, starboard flank, port flank, astern-high, top cover up-sun.
  // cap: straight-and-level cruise (~290–340 mph) on a slow S-weave about the flight station, bank only as the turn needs.
  // bounce: the element leader spots a threat, the element dives (400+ mph), 1–2 firing passes from ~400 yd closing to ~150 yd,
  // then zoom-climbs back to station. Never turn-fights, never follows a bandit to the deck, breaks off at the leash.
  const P51_FL = [
    { dx: 0,    dy: 210, dz: 360,  A: 120, B: 70,  T: 52, rdy: [44, 54] },
    { dx: 300,  dy: 150, dz: 90,   A: 80,  B: 110, T: 58, rdy: [31, 40] },
    { dx: -300, dy: 150, dz: 90,   A: 80,  B: 110, T: 58, rdy: [33, 42] },
    { dx: 0,    dy: 170, dz: -330, A: 130, B: 70,  T: 54, rdy: [27, 33] },
    { dx: 130,  dy: 300, dz: 140,  A: 100, B: 100, T: 64, rdy: [30, 38] },
  ];
  let p51Fl = [], stragNow = null;
  function p51Home(e) { return e.fl === 3 && e.slot < 2 && stragNow ? stragNow : BOX_C; } // the astern element may follow a straggler (leash-bound)
  function p51Station(e, tAhead) {
    const F = P51_FL[e.fl], C = p51Home(e), t = (mission ? mission.t : elapsed) + (tAhead || 0), ph = e.flPh;
    return { x: C.x + F.dx + F.A * Math.sin(TAU * t / F.T + ph), y: C.y + 16 + F.dy + 12 * Math.sin(TAU * t / (F.T * 1.7) + ph), z: C.z + F.dz + F.B * Math.sin(TAU * t / (F.T * 1.3) + ph * 2) };
  }
  function p51Follow(L, lat, back, up) { // a point `lat` to L's right, `back` behind, `up` above (L's horizontal heading)
    const hl = Math.hypot(L.hx, L.hz) || 1, fx = L.hx / hl, fz = L.hz / hl;
    return { x: L.x + fz * lat - fx * back, y: L.y + up, z: L.z - fx * lat - fz * back };
  }
  function p51Roles(e) {
    const F = p51Fl[e.fl] || [], ok = (q) => q && q.alive, okc = (q) => ok(q) && (q.phase === "cap" || q === e); // a Mustang off on a bounce is not anybody's leader
    const flLead = [F[0], F[2], F[1], F[3]].find(okc) || [F[0], F[2], F[1], F[3]].find(ok), elLead = (e.slot < 2 ? [F[0], F[1]] : [F[2], F[3]]).find(okc) || (e.slot < 2 ? [F[0], F[1]] : [F[2], F[3]]).find(ok);
    const mate = (e.slot < 2 ? [F[0], F[1]] : [F[2], F[3]]).find((q) => ok(q) && q !== e);
    return { flLead, elLead, mate };
  }
  function p51PickThreatOld(e) {
    let best = null, bs = -1e9;
    const H = p51Home(e);
    for (const q of enemies) {
      if (!q.alive || q.team === "allied" || q.phase === "debug" || q.hold) continue;
      if ((q.p51n || 0) >= 2) continue; // one element (two Mustangs) per German
      const dBox = Math.hypot(q.x - H.x, q.y - H.y, q.z - H.z);
      if (dBox > TUNE.p51Leash + 350) continue; // inside the leash plus the last stretch of a setup
      if (q.y < H.y - 330) continue;             // not down on the deck
      let sc = 0;
      const ph = q.phase;
      if (q.type === "190" && (ph === "stack" || ph === "quarter" || ph === "attack" || ph === "break" || ph === "rollin") && q.z < H.z + 180) sc = 3; // closing rear / low run
      else if (q.type === "109" && (ph === "attack" || ph === "arrive" || ph === "inbound") && q.z > H.z + 120 && q.mode !== "rear") sc = 2; // last 2,000 yd of a head-on setup
      else if ((ph === "extend" || ph === "break" || ph === "reform" || ph === "rollin") && (q.V < FAI.vSlow || q.hy > 0.15 || q.y < H.y - 60)) sc = 1; // just passed through, slow / climbing / reforming
      if (!sc) continue;
      const de = Math.hypot(q.x - e.x, q.y - e.y, q.z - e.z);
      const s = sc * 1000 - de + (q.hp < q.maxHp ? 250 : 0) + (q.r6 ? 300 : 0) + (q.p51n ? -120 : 0);
      if (s > bs) { bs = s; best = q; }
    }
    return best;
  }

  // ===== 1.5.7 MUSTANGS DISRUPT: a Mustang with a firing solution on a German who is running at a B-17 makes him BREAK OFF (abort the pass, dive away, re-plan); no dogfight =====
  const ATTACKING_PH = { attack: 1, quarter: 1, stack: 1, arrive: 1, inbound: 1 };
  function isStragTgt(t) { return !!t && ((t.kind === "player" && !!(bomber && !bomber.dead && bomber.out)) || (t.kind === "friendly" && t.f && friendlyOk(t.f) && !!t.f.out)); }
  function driveOff(g, p) { // true if g was in a run and has now broken it off
    if (!g || !g.alive || g.hold || !ATTACKING_PH[g.phase]) return false;
    g.burst = null; g.burstsLeft = 0; if (g.ps) { g.ps.p51 = true; g.ps.drive = true; }
    g.phase = "break"; g.phaseT = 0; g.breakType = g.type === "190" ? "under" : "splitS"; g.invert = g.breakType === "splitS"; g.brkSide = Math.random() < 0.5 ? -1 : 1; g.evadeT = 2.6;
    if (g.opening) { g.opening = false; if (mission) mission.openingPassed = (mission.openingPassed || 0) + 1; }
    g.drivenAt = mission ? mission.t : 0; g.drives = (g.drives || 0) + 1;
    if (p) { p.drove = g; p.followT = 0; }
    if (mission) {
      mission.breakoffs = (mission.breakoffs || 0) + 1; mission.breakoffsBy = mission.breakoffsBy || {}; mission.breakoffsBy[g.type] = (mission.breakoffsBy[g.type] || 0) + 1;
      if (isStragTgt(g.tgt)) mission.breakoffsStrag = (mission.breakoffsStrag || 0) + 1;
      if (mission.t - (mission.driveCallT == null ? -99 : mission.driveCallT) > 14 && Math.hypot(g.x - CAM.x, g.y - CAM.y, g.z - CAM.z) < 1800) { mission.driveCallT = mission.t; pushCallout("MUSTANGS ON " + (g.type === "190" ? "THE 190s" : "THE 109s") + " — THEY'RE BREAKING OFF!", 1.6, true); }
    }
    return true;
  }
  // ===== 1.5.4 MUSTANGS ENGAGE — every pilot hunts; a bounce is a chase that ends in a visible 6-gun burst, not a fly-by =====
  function p51PickThreat(e, wide) { // the German a Mustang can catch that is running at a B-17 (box or straggler); not already shared by two
    let best = null, bs = -1e9;
    const H = p51Home(e);
    for (const q of enemies) {
      if (!q.alive || q.team === "allied" || q.phase === "debug" || q.hold || q.type === "p51") continue;
      if ((q.p51n || 0) >= 2) continue;
      const strag = isStragTgt(q.tgt) && ATTACKING_PH[q.phase] || (q.hunt && huntOk(q.hunt));
      const HQ = strag && q.tgt && q.tgt.kind ? huntPos(q.tgt.kind === "player" || (q.tgt.f && q.tgt.f.out) ? q.tgt : q.hunt) : H; // a straggler's attackers are measured from the straggler, not from the box
      const dBox = Math.hypot(q.x - HQ.x, q.y - HQ.y, q.z - HQ.z);
      if (dBox > TUNE.p51Leash + 350) continue;
      if (q.y < H.y - 520) continue;
      const de = Math.hypot(q.x - e.x, q.y - e.y, q.z - e.z);
      if (de > (strag ? 7000 : wide ? 3600 : 2600)) continue;
      const ph = q.phase;
      let sc = 0.3;
      if (ATTACKING_PH[ph]) sc = 3;                                  // running at a bomber: the target
      else if (ph === "rollin") sc = 2.5;                           // a 109 curving in for his run
      else continue;                                                    // breaking / extending / reforming: not a run, let him go
      const s2 = sc * 700 - de + (strag ? 1200 : 0) + (q.hp < q.maxHp ? 150 : 0) + (q.p51n ? -200 : 0) - Math.max(0, dBox - 1300) * 0.4;
      if (s2 > bs) { bs = s2; best = q; }
    }
    return best;
  }

  const P51_TR = { x: [-2.2, 2.2], span: 5.4 };
  function p51Tick(e, T, range, hm) { // one 70 ms slice of a six-gun burst: a pair of tracers, a muzzle flash, and the hit roll
    const hl = Math.hypot(e.hx, e.hz) || 1, sx = e.hz / hl, sz = -e.hx / hl; // right wing direction
    const dx = T.x - e.x, dy = T.y - e.y, dz = T.z - e.z, dl = Math.hypot(dx, dy, dz) || 1;
    const lead = clamp(dl / BULLET_UPS, 0, 1.0), ax = T.x + T.vx * lead * 0.5 - e.x, ay = T.y + T.vy * lead * 0.5 - e.y, az = T.z + T.vz * lead * 0.5 - e.z, al = Math.hypot(ax, ay, az) || 1;
    for (let i = 0; i < 2; i++) {
      e.gunI = ((e.gunI || 0) + 1) % 6;
      const wing = e.gunI < 3 ? -1 : 1, off = (e.gunI % 3) * 1.15 + 2.6; // three guns a side, 2.6–4.9 u out from the centreline
      tracers.push({ x: e.x + e.hx * 4 + sx * wing * off, y: e.y + e.hy * 4 - 0.4, z: e.z + e.hz * 4 + sz * wing * off,
        vx: ax / al * BULLET_UPS + e.vx + rand(-5, 5), vy: ay / al * BULLET_UPS + e.vy + rand(-5, 5), vz: az / al * BULLET_UPS + e.vz + rand(-5, 5),
        life: Math.min(1.3, dl / 380 + 0.35), maxLife: 1.3, trav: 0, team: "allied", p51: true, delay: i * 0.03 });
    }
    e.mf = 0.1; e.mfI = (e.mfI || 0) + 1;
    if (window.FGAudio && (e.gunI & 1) === 0) window.FGAudio.p51Gun ? window.FGAudio.p51Gun(e.x, e.y, e.z) : window.FGAudio.gun(e.x, e.y, e.z);
    const rf = FC.rangeFactor(FC.GUNS.m2, FC.toYd(range));
    const bankPen = clamp(1 - Math.abs(T.gLoad || 1) * 0.06, 0.6, 1);
    const p = TUNE.p51TickHit * rf * bankPen * (range < 150 ? 1.2 : 1) * (hm || 1);
    if (Math.random() > p) return false;
    const L = mission ? (mission.hitLog || (mission.hitLog = {})) : {};
    const m = L["p51:m2"] || (L["p51:m2"] = {});
    const r = Math.random();
    const part = r < 0.14 ? "cockpit" : r < 0.34 ? "engine" : r < 0.48 ? "wingroot" : r < 0.58 ? "tail" : r < 0.78 ? "wing" : r < 0.84 ? "radiator" : r < 0.89 ? "fuel" : "hull"; // 1.5.6: radiator / fuselage-tank zones (md §4 fighter parts)
    m[part] = (m[part] || 0) + 1;
    const dmg = TUNE.p51HitDmg * 0.5 * FC.PART_MUL[part] * (T.type === "190" ? 0.82 : 1) * (T.sturm && (part === "engine" || part === "hull" || part === "cockpit") ? 0.7 : 1);
    T.hp -= dmg; T.mHits = (T.mHits || 0) + dmg; T.flash = 1; T.smoke = Math.min(1, (T.smoke || 0) + 0.2);
    spawnHit(T, null);
    if (mission) mission.p51Hits = (mission.p51Hits || 0) + 1;
    if (T.hp <= 0) { killEnemy(T, "p51"); return true; }
    if (T.phase === "attack" && Math.random() < 0.3) { // rattled: spoils the run, breaks
      T.burst = null; T.burstsLeft = 0; T.phase = "break"; T.phaseT = 0; T.brkSide = Math.random() < 0.5 ? -1 : 1;
      T.breakType = T.type === "190" ? "under" : "splitS"; T.invert = T.breakType === "splitS"; if (T.opening) T.opening = false;
      if (T.ps) T.ps.drive = true;
      if (mission && T.type === "190" && !T.p51drove) { T.p51drove = true; mission.n190drove = (mission.n190drove || 0) + 1; }
      if (mission) mission.p51Drove = (mission.p51Drove || 0) + 1;
    }
    return true;
  }
  // Returns true while the guns are firing. A burst lasts 0.45–0.95 s (≈ 40 rounds a gun-pair), then a short gap; gun-camera rules: inside ~370 u, within a few degrees.
  function p51Fire(e, T, range, cosA, dt, hm) {
    const near = Math.hypot(e.x - CAM.x, e.y - CAM.y, e.z - CAM.z) < 1500;
    if (!e.pbOn) {
      e.pbGap = (e.pbGap || 0) - dt;
      if (e.pbGap <= 0 && range < 400 && range > 40 && cosA > (range < 160 ? 0.93 : 0.955)) {
        e.pbOn = true; e.pbT = rand(0.45, 0.95); e.pbAcc = 0; e.shot = (e.shot || 0) + 1;
        if (mission) { mission.p51Bursts = (mission.p51Bursts || 0) + 1; if (near) mission.p51BurstsNear = (mission.p51BurstsNear || 0) + 1; }
        dfBounced(T, e); // 1.5.5: a bounced German (even mid-run) may turn back
      }
      return false;
    }
    e.pbT -= dt;
    if (e.pbT <= 0 || range > 480 || range < 25 || cosA < 0.9) { e.pbOn = false; e.pbGap = rand(0.18, 0.45); return false; }
    e.pbAcc += dt;
    while (e.pbAcc >= 0.07) { e.pbAcc -= 0.07; if (!T.alive) break; p51Tick(e, T, range, hm); }
    if (mission) { mission.p51FireSec = (mission.p51FireSec || 0) + dt; if (near) mission.p51FireSecNear = (mission.p51FireSecNear || 0) + dt; }
    return true;
  }
  function p51Burst(e, T, range, mul) { // six .50s, ~0.25 s: connects with a probability that falls with range and bank
    const rf = FC.rangeFactor(FC.GUNS.m2, FC.toYd(range));
    const bankPen = clamp(1 - Math.abs(T.gLoad || 1) * 0.06, 0.6, 1);
    const p = 0.8 * rf * bankPen * (range < 150 ? 1.15 : 1) * (mul || 1);
    const L = mission ? (mission.hitLog || (mission.hitLog = {})) : {};
    const m = L["p51:m2"] || (L["p51:m2"] = {});
    const dx = T.x - e.x, dy = T.y - e.y, dz = T.z - e.z, dl = Math.hypot(dx, dy, dz) || 1;
    for (let i = 0; i < 2; i++) tracers.push({ x: e.x + e.hx * 3, y: e.y + e.hy * 3, z: e.z + e.hz * 3, vx: dx / dl * BULLET_UPS + e.vx + rand(-6, 6), vy: dy / dl * BULLET_UPS + e.vy + rand(-6, 6), vz: dz / dl * BULLET_UPS + e.vz + rand(-6, 6), life: Math.min(1.2, dl / 400 + 0.3), maxLife: 1.2, trav: 0, team: "allied", hid: i === 1, delay: i * 0.04, src: e });
    if (window.FGAudio && Math.random() < 0.5) window.FGAudio.gun(e.x, e.y, e.z);
    if (Math.random() > p) return false;
    const r = Math.random();
    const part = r < 0.14 ? "cockpit" : r < 0.34 ? "engine" : r < 0.48 ? "wingroot" : r < 0.58 ? "tail" : r < 0.78 ? "wing" : r < 0.84 ? "radiator" : r < 0.89 ? "fuel" : "hull"; // 1.5.6: radiator / fuselage-tank zones (md §4 fighter parts)
    m[part] = (m[part] || 0) + 1;
    const dmg = TUNE.p51HitDmg * FC.PART_MUL[part] * (T.type === "190" ? 0.82 : 1) * (T.sturm && (part === "engine" || part === "hull" || part === "cockpit") ? 0.7 : 1);
    T.hp -= dmg; T.mHits = (T.mHits || 0) + dmg; T.flash = 1; T.smoke = Math.min(1, (T.smoke || 0) + 0.25);
    spawnHit(T, null);
    if (mission) mission.p51Hits = (mission.p51Hits || 0) + 1;
    if (T.hp <= 0) { killEnemy(T, "p51"); return true; }
    if (T.phase === "attack" && Math.random() < 0.55) { // rattled: spoils the run, breaks
      T.burst = null; T.burstsLeft = 0; T.phase = "break"; T.phaseT = 0; T.brkSide = Math.random() < 0.5 ? -1 : 1;
      T.breakType = T.type === "190" ? "under" : "splitS"; T.invert = T.breakType === "splitS"; if (T.opening) T.opening = false;
      if (T.ps) T.ps.drive = true;
      if (mission && T.type === "190" && !T.p51drove) { T.p51drove = true; mission.n190drove = (mission.n190drove || 0) + 1; }
      if (mission) mission.p51Drove = (mission.p51Drove || 0) + 1;
    }
    return true;
  }
  function p51Cruise(e, P, dt, vNow, nMax) { // straight-and-level flying toward P with gentle banks
    e.nMax = nMax; e.rollRate = 0.6; e.rollAcc = 1.4;
    let d = airDirTo(e, P.x, P.y, P.z); d = slopeLimit(e, d, -0.22, 0.28); d = safeDir(e, d);
    e.vT = vNow; flyStep(e, d.x, d.y, d.z, dt, 0.9);
  }
  function updateP51(e, dt) {
    if (e.phase === "duel") return duelStep(e, dt);
    e.phaseT += dt;
    const R = p51Roles(e), T = e.target, H = p51Home(e);
    const Hi = T && T.alive && T.tgt && isStragTgt(T.tgt) ? huntPos(T.tgt) : H; // chasing a straggler's attacker: the leash is measured from the straggler
    let d;
    if (e.phase === "intercept") {
      e.nMax = 4.2; e.rollRate = 2.0; e.rollAcc = 4.5;
      if (e.phaseT < 0) { // the wingman follows his leader down, ~1 s behind
        const L = R.mate && R.mate.phase === "intercept" ? R.mate : null;
        if (!L) { endIntercept(e); return; }
        p51Cruise(e, p51Follow(L, 45, 70, 8), dt, L.V + 30 * MPH, 2.6); return;
      }
      if (!T || !T.alive || T.hold || e.phaseT > 16 || Math.hypot(e.x - Hi.x, e.y - Hi.y, e.z - Hi.z) > TUNE.p51Leash + 350) { if (mission) { if (!T || !T.alive || T.hold) mission.p51EndLost = (mission.p51EndLost || 0) + 1; else if (e.phaseT > 16) mission.p51EndT = (mission.p51EndT || 0) + 1; else mission.p51EndLeash = (mission.p51EndLeash || 0) + 1; } endIntercept(e); return; }
      const rx = T.x - e.x, ry = T.y - e.y, rz = T.z - e.z, range = Math.hypot(rx, ry, rz) || 1;
      if (T.y < H.y - 900 || (T.hy < -0.6 && range > 700 && T.y < H.y - 600)) { if (mission) mission.p51EndDive = (mission.p51EndDive || 0) + 1; endIntercept(e); return; } // he dived away: let him go
      const tL = clamp(range / Math.max(120, e.speed || 150), 0, 1.4);
      const lx = T.x + T.vx * tL * 0.9, ly = T.y + T.vy * tL * 0.9 + clamp(range * 0.1, 0, 55) * (e.phaseT < 4 ? 1 : 0.3), lz = T.z + T.vz * tL * 0.9; // bounce from above and astern
      e.vT = 430 * MPH; e.vCap = 470 * MPH; // 1.5.7: ~410 mph cruise (P-51D: ~437 mph max at 25,000 ft, ~380-400 mph combat cruise); a dive adds up to 470 to run a 190 down
      d = airDirTo(e, lx, ly, lz); d = safeDir(e, d); flyStep(e, d.x, d.y, d.z, dt, 1.9);
      const vb = Math.hypot(e.vx, e.vy, e.vz) || 1;
      const cosA = (rx * e.vx + ry * e.vy + rz * e.vz) / (range * vb);
      e.minR = Math.min(e.minR || 1e9, range);
      p51Fire(e, T, range, cosA, dt, 1);
      if (mission && range < 900 && Math.hypot(e.x - CAM.x, e.y - CAM.y, e.z - CAM.z) < 1500 && mission.fightT !== mission.t) { mission.fightT = mission.t; mission.p51FightNearSec = (mission.p51FightNearSec || 0) + dt; }
      if (mission && range < 420 && cosA > 0.9) mission.p51FireWinSec = (mission.p51FireWinSec || 0) + dt / 3; // seconds with a German in the gun window (averaged per Mustang)
      const passed = e.minR < 150 && range > e.minR + 45 && range < 400;
      // 1.5.5 (md BUG B): once he is actually on the German (inside 420 u, nose on) he DUELS - even if that German is still pressing his run
      if (range < 520 && cosA > 0.88 && T.y > BOX_C.y - 900) { // 1.5.7: a firing solution on a German who is running at a bomber → he breaks the run off; we give him a couple of bursts, then go
        if (e.icptT0 != null && mission) { (mission.p51Icpt || (mission.p51Icpt = [])).push({ t: +(mission.t).toFixed(1), dt: +(mission.t - e.icptT0).toFixed(1), type: T.type, strag: isStragTgt(T.tgt) ? 1 : 0, fl: e.fl }); e.icptT0 = null; }
        driveOff(T, e);
      }
      // he broke it off (driven, rattled or finished): a few more bursts if he is right there, then back up to station
      if (!ATTACKING_PH[T.phase] && T.phase !== "rollin") { e.followT = (e.followT || 0) + dt; if (e.followT > 2.6 || range > 1100) { if (mission) mission.p51Follow = (mission.p51Follow || 0) + 1; endIntercept(e); return; } }
      if (range > 330) e.passArm = true;
      if ((range < 55 || passed) && e.passArm) {
        e.pass = (e.pass || 0) + 1; e.passArm = false; e.minR = 1e9; if (mission) mission.p51EndPass = (mission.p51EndPass || 0) + 1;
        if (e.pass >= 2) { endIntercept(e); return; } // two passes: back up to station (a Mustang disrupts, he does not loiter)
        // otherwise carry on: yo-yo high and come around again (the chase continues up to 22 s)
      }
      if (e.pass && range < 260 && cosA < 0.8) { e.phaseT += dt * 0.5; }
      return;
    }
    if (e.phase === "zoom") { // back to station: climb and swing home (1.5.7: steered at the station, not a straight-ahead zoom that carries a 430 mph Mustang 1,500 u past the leash)
      e.nMax = 3.4; e.rollRate = 1.6; e.rollAcc = 3.2;
      const S = p51Station(e, 3), dd = Math.hypot(S.x - e.x, S.y - e.y, S.z - e.z);
      e.vT = (dd > 1500 ? 400 : 320) * MPH;
      d = airDirTo(e, S.x, S.y, S.z); d = slopeLimit(e, d, -0.2, 0.4); d = safeDir(e, d); flyStep(e, d.x, d.y, d.z, dt, 1.3);
      if (dd < 900 && e.y > S.y - 80 || e.phaseT > 12) { e.phase = "cap"; e.phaseT = 0; e.scanT = rand(0.8, 1.6); }
      return;
    }
    // cap: station keeping
    let P, vNow, nMax = 1.15;
    const flLead = R.flLead || e;
    if (e === flLead) { const S = p51Station(e, 3); P = S; vNow = clamp(VF + 0.18 * (S.z - e.z), 215 * MPH, 300 * MPH); }
    else if (e === R.elLead) { const L = flLead, off = L.slot < 2 ? -130 : 130; P = p51Follow(L, off, 75, 12); vNow = L.V + clamp(0.15 * ((P.x - e.x) * L.hx + (P.y - e.y) * L.hy + (P.z - e.z) * L.hz), -35 * MPH, 55 * MPH); }
    else { const L = R.elLead || flLead, side = (e.slot & 1) ? 1 : -1; P = p51Follow(L, 55 * (e.slot === 1 || e.slot === 3 ? 1 : side), 48, -4); vNow = L.V + clamp(0.15 * ((P.x - e.x) * L.hx + (P.y - e.y) * L.hy + (P.z - e.z) * L.hz), -35 * MPH, 55 * MPH); }
    const dist = Math.hypot(P.x - e.x, P.y - e.y, P.z - e.z);
    if (e !== flLead) { const L2 = e === R.elLead ? flLead : (R.elLead || flLead), la = Math.hypot(L2.vx, L2.vy, L2.vz + VF) * 3.5; P = { x: P.x + L2.hx * la, y: P.y + L2.hy * la * 0.5, z: P.z + L2.hz * la }; } // aim ahead of the slot: no overshoot, no hard turns
    if (dist > 250) { nMax = clamp(1.15 + dist / 900, 1.15, 2.4); vNow = Math.max(vNow, 300 * MPH); }
    vNow = clamp(vNow, 200 * MPH, 330 * MPH);
    e.sweep = 0;
    if (mission && mission.t >= e.readyAt && (e === flLead || e === R.elLead)) { // 1.5.4: a flight with nobody to bounce HUNTS — it heads for the nearest German inside the umbrella instead of orbiting its slot
      let bq = null, bd = 1e9;
      for (const q of enemies) {
        if (!q.alive || q.team === "allied" || q.hold || q.phase === "debug" || q.type === "p51" || !(ATTACKING_PH[q.phase] || q.phase === "rollin")) continue; // 1.5.7: only a German running at a bomber is worth a sweep
        if (Math.hypot(q.x - H.x, q.y - H.y, q.z - H.z) > TUNE.p51Leash + 900) continue;
        const dq = Math.hypot(q.x - e.x, q.y - e.y, q.z - e.z); if (dq < bd) { bd = dq; bq = q; }
      }
      if (bq && bd > 350) {
        const la = clamp(bd / 400, 0, 4);
        let sx = bq.x + bq.vx * la, sy = Math.max(bq.y + 80, H.y - 150), sz = bq.z + bq.vz * la;
        const hx = sx - H.x, hy = sy - H.y, hz = sz - H.z, hh = Math.hypot(hx, hy, hz); if (hh > TUNE.p51Leash - 150) { const k = (TUNE.p51Leash - 150) / hh; sx = H.x + hx * k; sy = H.y + hy * k; sz = H.z + hz * k; }
        P = { x: sx, y: sy, z: sz }; vNow = 410 * MPH; nMax = 2.4; e.sweep = 1; e.sweepD = Math.round(bd);
      }
    }
    if (e !== flLead && e !== R.elLead) { const L3 = R.elLead || flLead; e.sweep = L3 ? L3.sweep || 0 : 0; } // a wingman flies his leader's sweep
    p51Cruise(e, P, dt, vNow, nMax); e.dbg2 = { dist: Math.round(dist), role: e === flLead ? "FL" : e === R.elLead ? "EL" : "W", nMax: +nMax.toFixed(2) };
    if (mission && dist <= 250) { const c = mission.p51cap || (mission.p51cap = { n: 0, sum: 0, max: 0, over45: 0, over60: 0, rejoin: 0 }), bk = Math.abs(e.bank || 0); c.n++; c.sum += bk; if (bk > c.max) c.max = bk; if (bk > 0.785) c.over45++; if (bk > 1.05) c.over60++; } else if (mission && mission.p51cap) mission.p51cap.rejoin++;
    e.scanT = (e.scanT || 0) - dt;
    if (e.scanT <= 0 && mission && mission.t >= e.readyAt && mission.t >= (e.coolUntil || 0) && (e === R.elLead || e.phaseT > 3)) {
      e.scanT = rand(0.35, 0.7);
      const th = p51PickThreat(e);
      if (th) {
        const go = (q, delay, tt) => { tt = tt || th; q.target = tt; q.phase = "intercept"; q.phaseT = delay; q.fireCd = 0.4; q.minR = 1e9; q.pass = 0; q.followT = 0; q.drove = null; q.icptT0 = mission.t; tt.p51n = (tt.p51n || 0) + 1; };
        go(e, 0); if (R.mate && R.mate.phase === "cap" && mission.t >= (R.mate.coolUntil || 0)) go(R.mate, -0.9);
        { const F = p51Fl[e.fl] || [], oth = (e.slot < 2 ? [F[2], F[3]] : [F[0], F[1]]).filter((q) => q && q.alive && q.phase === "cap" && mission.t >= (q.coolUntil || 0)); // 1.5.7: the flight goes as a flight — the other element takes a second German of the group (or the same one)
          if (oth.length) { const th2 = p51PickThreat(oth[0], true) || th; go(oth[0], -0.5, th2); if (oth[1]) go(oth[1], -1.4, th2); } }
        if (th.ps) th.ps.p51 = true;
        if (mission && th.type === "190" && !th.p51seen) { th.p51seen = true; mission.n190seen = (mission.n190seen || 0) + 1; }
        if (mission) { mission.p51Jumps = (mission.p51Jumps || 0) + 1; if (th.type === "190") mission.p51On190 = (mission.p51On190 || 0) + 1; if (!mission.p51Called) { mission.p51Called = true; pushCallout("MUSTANGS HIGH!", 1.8, true); } }
      }
    }
  }
  function endIntercept(e) {
    if (e.target) e.target.p51n = Math.max(0, (e.target.p51n || 0) - 1);
    e.target = null; e.phase = "zoom"; e.phaseT = 0; e.coolUntil = (mission ? mission.t : elapsed) + (e.shot ? rand(3, 6) : rand(1.5, 3.5)); e.shot = 0; e.pbOn = false; // 1.5.2: a Mustang that has made his pass gets back up to station before the next bounce
  }

  // ===== 1.5.3 DOGFIGHTS — a Mustang that catches a German turns it into a visible, close 1v1 / 2v1 turning fight near the box =====
  // Both sides fly the same duel model (phase "duel", e.foe = opponent): whoever has his nose on the other is the aggressor (lead pursuit, bursts
  // at <360 u), the other defends (break turn across the line of sight, reversals / scissors, up-and-down jinks). The roles flip when the
  // angles flip. Fights are pulled back toward the box, end after 8–14 s, when a pilot dies, or when the loser drops away steeply.
  // Sources: USER_TACTICS.md (P-51 = sheriff, leash 520, zoom back; 109 abandons the slash and dives; "do not follow a 109 to the deck"),
  // ESCORT_TACTICS.md (energy fighting — here the fights are short, bounded, and end in a zoom or a dive away).
  const DF = { on: false, /* 1.5.7: Mustangs DISRUPT runs, they do not dogfight: duels are off (code kept dormant) */ hold: [8, 14], hitMul: 0.5, pBurst: [0.55, 1.0], dfProb: 0.85, defendProb: 0.8, pounceProb: 0.55, pounceRange: 600 };

  // ===== 1.5.3 FRIENDLY FIRE ON MUSTANGS — our .50s and the box gunners' strays are real rounds against the P-51's mesh, per part =====
  function ffMustang(e, fhit, by) {
    let part = "hull";
    if (fhit && fhit.lx != null && World3D && World3D.fighterBoundR) { const kk = 1.75 / Math.max(0.5, World3D.fighterBoundR("p51")); part = FC.classifyFighterHit(fhit.lx * kk, fhit.ly * kk, -fhit.lz * kk); }
    const pd = FC.fighterRound("p51", part, by === "you" ? TUNE.fRoundDmg : TUNE.cpuHitDmg, false);
    e.hp -= pd; e.flash = 1; e.smoke = Math.min(1, (e.smoke || 0) + 0.25); spawnHit(e, fhit);
    if (mission) { const k = by === "you" ? "p51HitYou" : "p51HitGun"; mission[k] = (mission[k] || 0) + 1; }
    if (by === "you") {
      score = Math.max(0, score - 40); combo = 0; comboTimer = 0;
      if (elapsed - (mission && mission.mustCallT || -9) > 3.5) { if (mission) mission.mustCallT = elapsed; pushCallout("CEASE FIRE — THAT'S A MUSTANG!", 1.6, true); }
    }
    if (e.hp <= 0) {
      killP51(e, by);
      if (by === "you") { score = Math.max(0, score - 500); pushCallout("YOU SHOT DOWN A MUSTANG!", 2.0, true); }
      else pushCallout("MUSTANG DOWN — FRIENDLY FIRE!", 1.6, true);
    }
    return true;
  }
  function hitMustangSeg(x0, y0, z0, x1, y1, z1) { // swept round vs every live Mustang (sphere broadphase, then the real mesh)
    for (const e of enemies) {
      if (!e.alive || e.type !== "p51" || e.hold) continue;
      const bR = World3D && World3D.fighterBoundR ? World3D.fighterBoundR("p51") * 1.3 + 1.5 : 6;
      const r0x = x0 - e.x, r0y = y0 - e.y, r0z = z0 - e.z, r1x = x1 - e.x, r1y = y1 - e.y, r1z = z1 - e.z;
      const sx = r1x - r0x, sy = r1y - r0y, sz = r1z - r0z, ss = sx * sx + sy * sy + sz * sz || 1e-6;
      const tt = clamp(-(r0x * sx + r0y * sy + r0z * sz) / ss, 0, 1), qx = r0x + sx * tt, qy = r0y + sy * tt, qz = r0z + sz * tt;
      if (qx * qx + qy * qy + qz * qz > bR * bR) continue;
      let fh = World3D && World3D.rayFighter ? World3D.rayFighter(e, x0, y0, z0, x1, y1, z1, 0) : undefined;
      if (fh === undefined) fh = qx * qx + qy * qy + qz * qz < 9 ? { x: e.x + qx, y: e.y + qy, z: e.z + qz } : null;
      if (fh) return { e, fh };
    }
    return null;
  }
  function dfCan(g) { return DF.on && g && g.alive && !g.hold && g.phase !== "debug" && g.phase !== "duel"; } // 1.5.5 (md BUG B): a German in attack / quarter / arrive CAN be dueled
  function startDuel(a, b, why) { // a = aggressor, b = defender; either may already be in a duel (2v1)
    if (!a || !b || !a.alive || !b.alive || a === b) return false;
    if (mission && mission.t - (mission.mixT == null ? -99 : mission.mixT) > 10 && ((a.type === "p51") !== (b.type === "p51")) && Math.hypot((a.x + b.x) / 2 - CAM.x, (a.y + b.y) / 2 - CAM.y, (a.z + b.z) / 2 - CAM.z) < 1500) { mission.mixT = mission.t; mission.mixCalls = (mission.mixCalls || 0) + 1; pushCallout("MIX IT UP!", 1.4, true); } // md: once per duel that starts within 1,500 u of the player
    if (mission) { mission.duelStarts = (mission.duelStarts || 0) + 1; (mission.duelWhy || (mission.duelWhy = {}))[why || "?"] = ((mission.duelWhy || {})[why || "?"] || 0) + 1; }
    const arm = (e, foe, role) => {
      if (e.phase === "duel") { if (!e.foe) e.foe = foe; return; }
      e.foe = foe; e.duelT = 0; e.duelMax = rand(DF.hold[0], DF.hold[1]); e.duelRole = role; e.prevPhase = e.phase; e.phase = "duel"; e.phaseT = 0; e.burst = null; e.burstsLeft = 0; e.invert = false;
      e.sgn = Math.random() < 0.5 ? -1 : 1; e.revT = rand(1.4, 2.6); e.fireCd = rand(0.3, 0.7); e.duelDelay = 0; e.dPh = Math.random() * 6.28; e.farT = 0;
      if (e.type === "p51") { e.target = foe; }
    };
    arm(a, b, "att"); arm(b, a, "def");
    return true;
  }
  function endDuel(e) {
    const f = e.foe; e.foe = null;
    if (f && f.foe === e) { let nxt = null; for (const q of enemies) if (q !== e && q.alive && q.foe === f) { nxt = q; break; } f.foe = nxt; }
    if (e.type === "p51") { endIntercept(e); return; }
    e.target = null;
    reformOrEgress(e);
  }
  function killP51(e, by) { // a Mustang shot down (by a German, or by friendly fire: by = "you" / "gun"): wreck + a chute
    e.alive = false; e.burst = null; if (e.target) e.target.p51n = Math.max(0, (e.target.p51n || 0) - 1);
    if (e.foe && e.foe.foe === e) e.foe.foe = null; e.foe = null;
    if (mission) { mission.p51Lost = (mission.p51Lost || 0) + 1; const k = by === "you" ? "p51LostYou" : by === "gun" ? "p51LostGun" : "p51LostGer"; mission[k] = (mission[k] || 0) + 1; }
    if (window.FGAudio) window.FGAudio.boom(e.x, e.y, e.z, false);
    e.wreckT = 4.2; e.vx *= 0.6; e.vz *= 0.6; e.vy = Math.min(e.vy, 0) - 6; e.wreckAge = 0; e.bailAt = Math.random() < 0.6 ? rand(0.7, 2.8) : -1; e.flash = 0.6;
    for (let i = 0; i < 12; i++) particles.push({ x: e.x, y: e.y, z: e.z, vx: rand(-25, 25), vy: rand(-10, 20), vz: rand(-25, 25), life: rand(0.4, 1.1), max: 1.1, kind: i < 5 ? "fire" : "smoke", r: rand(3, 8) });
  }
  function duelBurst(e, f, R) { // German cannon / MG burst at a Mustang (tracers: 190 red, 109 yellow)
    const dx = f.x - e.x, dy = f.y - e.y, dz = f.z - e.z, dl = Math.hypot(dx, dy, dz) || 1;
    for (let i = 0; i < 2; i++) tracers.push({ x: e.x + e.hx * 3, y: e.y + e.hy * 3, z: e.z + e.hz * 3, vx: dx / dl * BULLET_UPS + e.vx + rand(-6, 6), vy: dy / dl * BULLET_UPS + e.vy + rand(-6, 6), vz: dz / dl * BULLET_UPS + e.vz + rand(-6, 6), life: Math.min(1.3, dl / 400 + 0.3), maxLife: 1.3, trav: 0, team: "axis", hid: i === 1, delay: i * 0.05, k190: e.type === "190" });
    e.mf = 0.12; if (window.FGAudio && Math.random() < 0.5) window.FGAudio.enemyGun(e.x, e.y, e.z);
    if (mission) mission.duelGerBursts = (mission.duelGerBursts || 0) + 1;
    const rf = FC.rangeFactor(FC.GUNS.mg151, FC.toYd(R));
    const p = 0.55 * rf * DF.hitMul * clamp(1 - Math.abs(f.gLoad || 1) * 0.06, 0.6, 1);
    if (Math.random() > p) return;
    f.hp -= e.type === "190" ? 5.5 : 4.5; f.flash = 1; f.smoke = Math.min(1, (f.smoke || 0) + 0.3); spawnHit(f, null);
    if (mission) mission.duelGerHits = (mission.duelGerHits || 0) + 1;
    if (f.hp <= 0) killP51(f, e);
  }
  function duelStep(e, dt) {
    const f = e.foe, isP = e.type === "p51";
    e.duelT += dt; e.phaseT += dt;
    if (mission) { mission.duelSec = (mission.duelSec || 0) + dt * 0.5; } // each fight has two pilots → counted once
    const H = isP ? p51Home(e) : BOX_C;
    let end = !f || !f.alive || e.duelT > e.duelMax;
    let R = 1, ux = 0, uy = 0, uz = 1;
    if (!end) {
      const rx = f.x - e.x, ry = f.y - e.y, rz = f.z - e.z; R = Math.hypot(rx, ry, rz) || 1; ux = rx / R; uy = ry / R; uz = rz / R;
      e.farT = R > 1000 ? e.farT + dt : 0; if (e.farT > 3) end = true;
      if (isP && Math.hypot(e.x - H.x, e.y - H.y, e.z - H.z) > TUNE.p51Leash + 900) end = true;
      if (f.y < BOX_C.y - 520 || e.y < BOX_C.y - 560) end = true; // the loser dived away: let him go, no chasing to the deck
    }
    if (end) { endDuel(e); return; }
    const cosA = e.hx * ux + e.hy * uy + e.hz * uz, cosB = -(f.hx * ux + f.hy * uy + f.hz * uz), sc = cosA - cosB;
    if (e.duelRole === "att" && sc < -0.35) e.duelRole = "def"; else if (e.duelRole === "def" && sc > 0.35) e.duelRole = "att";
    if (e.duelDelay > 0) e.duelDelay -= dt;
    const tt = mission ? mission.t : elapsed;
    let d;
    if (e.duelRole === "att") {
      const tL = clamp(R / Math.max(140, e.speed || 150), 0, 1.2) * 0.8;
      let lx = f.x + f.vx * tL, ly = f.y + f.vy * tL, lz = f.z + f.vz * tL;
      if (R < 120 && cosA < 0.93) { lx -= f.hx * 70; ly += 30; lz -= f.hz * 70; } // overshooting: lag pursuit / high yo-yo
      d = airDirTo(e, lx, ly, lz);
      e.vT = clamp(f.V * 1.04 + (R - 160) * 0.2, 285 * MPH, isP ? 440 * MPH : 400 * MPH);
      e.fireCd -= dt;
      if (isP) { if (e.duelDelay <= 0 && p51Fire(e, f, R, cosA, dt, DF.hitMul * 1.4)) { if (mission && !e.duelBurstCt) { } } }
      else if (e.fireCd <= 0 && e.duelDelay <= 0 && cosA > 0.975 && R < 360 && R > 45) {
        e.fireCd = rand(DF.pBurst[0], DF.pBurst[1]);
        duelBurst(e, f, R);
      }
    } else { // defend: break across the LOS, reverse every 1.5–3 s (scissors), jink up and down
      e.revT -= dt; if (e.revT <= 0) { e.sgn = -e.sgn; e.revT = rand(1.5, 3.0); }
      let lx = uz * e.sgn, lz = -ux * e.sgn; const ll = Math.hypot(lx, lz) || 1; lx /= ll; lz /= ll;
      d = norm3(lx * 1.0 - ux * 0.3, 0.5 * Math.sin(tt * 1.7 + e.dPh) - uy * 0.2, lz * 1.0 - uz * 0.3);
      e.vT = clamp(e.V - 8, 300 * MPH, 360 * MPH);
    }
    { // keep the arena near the box: climb back from low, pull in from far out
      const bx = BOX_C.x - e.x, bz = BOX_C.z - e.z, bh = Math.hypot(bx, bz);
      if (bh > 900) { const w = clamp((bh - 900) / 700, 0, 0.8); d = norm3(d.x * (1 - w) + bx / bh * w, d.y, d.z * (1 - w) + bz / bh * w); }
      if (e.y < BOX_C.y - 260) d = norm3(d.x, d.y + 0.45, d.z); else if (e.y > BOX_C.y + 650) d = norm3(d.x, d.y - 0.4, d.z);
    }
    e.nMax = isP ? 4.8 : 5.0; e.rollRate = 2.4; e.rollAcc = 6.0;
    d = safeDir(e, d);
    flyStep(e, d.x, d.y, d.z, dt, 2.6);
  }
  // a Mustang's burst has just gone out at a German who isn't in the fight: he turns and defends (and the Mustang's element-mate piles in)
  function dfBounced(g, p) {
    if (!dfCan(g) || !mission || mission.t < 20) return;
    if (g.foe || g.dfCool > mission.t || Math.random() > DF.defendProb) return;
    g.dfCool = mission.t + 6;
    startDuel(p, g, "bounced");
    const R = p51Roles(p); if (R.mate && R.mate !== p && (R.mate.phase === "cap" || R.mate.phase === "intercept")) { R.mate.target = g; R.mate.duelDelay = rand(0.6, 1.4); startDuel(R.mate, g, "mate"); }
  }
  // a German who isn't busy picks on a Mustang that is within reach below / level and not already engaged
  function dfPounce(e, dt) {
    if (!mission || mission.t < 26 || e.foe || !dfCan(e) || (e.phase !== "setup" && e.phase !== "reform" && e.phase !== "extend" && e.phase !== "rollin")) return;
    e.dfChk = (e.dfChk || 0) - dt; if (e.dfChk > 0) return; e.dfChk = rand(1.2, 2.2);
    if (e.dfCool > mission.t || Math.random() > DF.pounceProb) return;
    let best = null, bd = DF.pounceRange;
    for (const q of enemies) { if (!q.alive || q.type !== "p51" || q.phase !== "cap") continue; const d = Math.hypot(q.x - e.x, q.y - e.y, q.z - e.z); if (d < bd && q.y < e.y + 260 && Math.hypot(q.x - CAM.x, q.y - CAM.y, q.z - CAM.z) < 1500) { bd = d; best = q; } }
    if (!best) return;
    e.dfCool = mission.t + 12;
    startDuel(e, best, "pounce");
    const R = p51Roles(best); if (R.mate && R.mate !== best && R.mate.phase === "cap") { R.mate.target = e; R.mate.duelDelay = rand(0.8, 1.6); startDuel(R.mate, e, "mate"); }
    if (best.phase === "duel") best.duelRole = "def";
  }
  function makeP51(i) {
    const e = makeMissionFighter("p51");
    e.fl = (i / 4) | 0; e.slot = i & 3; e.flPh = e.fl * 1.7;
    (p51Fl[e.fl] || (p51Fl[e.fl] = []))[e.slot] = e;
    const rd = P51_FL[e.fl].rdy; e.readyAt = rand(rd[0], rd[1]); // flights 0 (ahead) and the flanks are a little out of position for the first slash
    const S = p51Station(e, 0);
    const off = [[0, 0, 0], [55, 48, -4], [-130, 75, 12], [-75, 123, 8]][e.slot];
    const P = { x: S.x + off[0], y: S.y + off[2], z: S.z - off[1] };
    e.x = P.x; e.y = P.y; e.z = P.z;
    e.V = 250 * MPH; e.vMin = 190 * MPH; e.vSlow = 250 * MPH; // 1.5.7: Mustangs throttle back to weave over the 180 mph box (a P-51D flies slow, ~110 mph stall); 410 mph is their transit/hunting cruise
    initAttitude(e, { x: 0, y: 0, z: 250 * MPH * 0.9 }, 0);
    e.phase = "cap"; e.phaseT = 0; e.scanT = rand(0.5, 2); e.nMax = 1.15; e.rollRate = 0.6; e.rollAcc = 1.4;
    return e;
  }
  function reformOrEgress(e) {
    e.setup = null; e.invert = false; e.vT = FAI.vFull;
    // spec: reform for a second slash ONLY if no Mustang is within ~800 yd and closing; otherwise the only legal order is dive away.
    // 1.5.2: the dive-away is temporary (≈8 s) — every survivor comes back and keeps making passes until the end of the mission
    if (p51OnTail(e, 500)) { e.phase = "egress"; e.phaseT = 0; if (mission) mission.p51Egress = (mission.p51Egress || 0) + 1; return; }
    startReform(e);
  }
  function startReform(e) {
    const is190 = e.type === "190"; if (is190) e.nMax = null;
    if (is190 && !e.hunt && (e.pass190n || 0) >= 2) { e.phase = "winchester"; e.phaseT = 0; e.setup = null; if (mission) mission.n190bingo = (mission.n190bingo || 0) + 1; return; } // doctrine: "one more pass, then empty"
    if (e.ammo <= 0) e.ammo = 1; // 1.5.2: the last few rounds in the belts — they do not leave the fight
    e.phase = "reform"; e.phaseT = 0;
    e.rSide = e.x > BOX_C.x ? 1 : -1;
    if (is190) { e.stLat = rand(2800, 3500); e.stZ = -rand(1800, 3000); e.stUp = -rand(400, 700); } // 1.5.5: reform LOW on the rear quarter (4 / 8 o'clock), ~2,000 u out, then the second pass comes up from below again
    else { e.stLat = rand(2800, 3500); e.stZ = rand(3400, 4800); e.stUp = rand(400, 800); e.vCap = 485 * MPH; } // 1.5.4: regroup far out on the flanks (out of effective gun/visual range), never in plain sight near the box
    e.stPh = rand(0, 6.28); e.orbR = rand(110, 230); e.orbW = rand(0.12, 0.18) * (Math.random() < 0.5 ? -1 : 1); // the station is an orbit — never hovering
  }
  // 1.4.1: station ~1.5–2 km out on a front flank where they're seen setting up the next pass
  function stationOf(e) {
    const side = e.rSide || 1, tt = (mission ? mission.t : elapsed), w = tt * 0.35 + (e.stPh || 0), R = e.orbR || 0, ph = tt * (e.orbW || 0) + (e.stPh || 0) * 3, An = anchorOf(e);
    return { x: An.x + side * ((e.stLat || 1100) + Math.sin(w) * 70) + Math.cos(ph) * R, y: An.y + (e.stUp || 380) + Math.sin(w * 1.3) * 30, z: An.z + (e.stZ || 500) + Math.cos(w * 0.8) * 60 + Math.sin(ph) * R * 1.4 };
  }
  function flyStation(e, S, dt) {
    const dz = S.z - e.z, dist = Math.hypot(S.x - e.x, S.y - e.y, dz);
    e.vT = clamp(VF + 12 + dz * 0.12 + Math.max(0, dist - 250) * 0.08, VF + 8, FAI.vFull);
    if (e.type === "190") e.vT = FAI.v190 * 0.92; // 1.5.5: a 190 never crawls on its station - it stays at speed
    if (dist > 900 && e.phase === "reform") { e.vT = e.type === "190" ? FAI.v190 : 470 * MPH; e.nMax = e.type === "190" ? 5.2 : 4.6; } // 1.5.4: the reform leg is flown FAST (a real regroup, never a crawl beside the box)
    let d = airDirTo(e, S.x + (S.x - e.x) * 0.2, S.y, S.z + 220); // aim a little ahead so they settle alongside, not orbit
    d = slopeLimit(e, d, -0.3, 0.2);
    d = safeDir(e, d);
    flyStepE(e, d.x, d.y, d.z, dt, 0.8);
    return dist;
  }
  // 1.5.1: weave the aim point ⟂ the line of sight (a jink): a real 5 g limit still caps what the airframe can follow
  function jinkAim(e, A, range, amp) {
    const rx = A.x - e.x, ry = A.y - e.y, rz = A.z - e.z, rl = Math.hypot(rx, ry, rz) || 1;
    const ux = rx / rl, uy = ry / rl, uz = rz / rl;
    let lx = uz, lz = -ux; const ll = Math.hypot(lx, lz) || 1; lx /= ll; lz /= ll;
    const vx = uy * lz, vy = uz * lx - ux * lz, vz = -uy * lx;
    const t = (mission ? mission.t : elapsed) * (6.283 / e.jT) + e.jPh, a = amp * range, s1 = Math.sin(t), s2 = Math.sin(t * 0.55 + 1.3) * 0.6;
    return { x: A.x + lx * a * s1 + vx * a * s2, y: A.y + vy * a * s2, z: A.z + lz * a * s1 + vz * a * s2 };
  }
  // 1.5.1: a German with a Mustang on his tail rolls and weaves (scissors) instead of flying straight
  function flyStepE(e, dx, dy, dz, dt, gain) {
    if (e.evadeT > 0 && e.phase !== "attack") {
      const d = norm3(dx, dy, dz), t = (mission ? mission.t : elapsed);
      let lx = e.hz, lz = -e.hx; const ll = Math.hypot(lx, lz) || 1; lx /= ll; lz /= ll;
      const w = Math.sin(t * 2.9 + e.jPh), v = Math.cos(t * 2.1 + e.jPh);
      const q = norm3(d.x + lx * w * 1.0, d.y + v * 0.6, d.z + lz * w * 1.0);
      return flyStep(e, q.x, q.y, q.z, dt, Math.max(gain || 1, 1.8));
    }
    return flyStep(e, dx, dy, dz, dt, gain);
  }
  function updateFighterAI(e, dt) {
    if (e.mf > 0) e.mf -= dt;
    if (e.type === "p51") return updateP51(e, dt);
    if (e.phase === "duel") { if (e.evadeT > 0) e.evadeT -= dt; return duelStep(e, dt); }
    dfPounce(e, dt);
    if (e.evadeT > 0) e.evadeT -= dt;
    if ((e.evChk = (e.evChk || 0) - dt) <= 0) { e.evChk = 0.25; if (e.phase !== "attack" && p51OnTail(e, 380)) { if (!(e.evadeT > 0) && mission) mission.evades = (mission.evades || 0) + 1; e.evadeT = 2.6; } }
    e.phaseT = (e.phaseT || 0) + dt;
    let d;
    if (e.phase === "quarter" || e.phase === "stack") { // 1.5.5 (md BUG A): NO hold point. The 190 flies at v190 straight THROUGH the ship from the rear quarter and commits on range or a 4 s timer
      if (!e.tgt) e.tgt = pick190Target(e);
      const T = targetPoint(e.tgt);
      const side = e.slotX >= 0 ? 1 : -1;            // 7 or 5 o'clock
      const aim = { x: T.x + side * 40, y: T.y - 20, z: T.z - 30 }; // through the ship, not at a station
      e.vT = FAI.v190 * (e.sturm ? 0.97 : 1);
      d = airDirTo(e, aim.x, aim.y, aim.z);
      d = slopeLimit(e, d, -0.45, 0.25);
      d = safeDir(e, d);
      flyStepE(e, d.x, d.y, d.z, dt, 1.6);
      const range = Math.hypot(T.x - e.x, T.y - e.y, T.z - e.z);
      if (e.rockets > 0 && !e.hold) tryRockets(e);
      recAz190(e, T, range);
      if (range < 680 || e.phaseT > 9) commitPass(e, side > 0 ? "lowq" : "stern"); // 1.5.7: commit ~1 km (680 u) from the rear B-17s (was 900 u / 4 s)
      return;
    }
    if (e.phase === "inbound") { // Staffel 2: level at ~35,000 ft heading south; rolls over and dives
      const T = targetPoint(e.tgt);
      const hd = Math.hypot(T.x - e.x, T.z - e.z) || 1;
      const dep = Math.atan2(e.y - T.y, hd);
      e.vT = FAI.vLevel;
      if (e.phaseT > e.diveDelay && dep > e.diveDep) { e.invert = true; commitPass(e, "headon"); e.invert = true; e.diveT = mission ? mission.t : 0; return; }
      d = norm3((T.x - e.x) / hd * 0.12, clamp((e.cruiseY - e.y) * 0.003, -0.08, 0.08), -1);
      d = safeDir(e, d);
      flyStepE(e, d.x, d.y, d.z, dt, 1.2);
      return;
    }
    if (e.phase === "arrive") { // inbound from far ahead toward a setup point, then commit
      const S = frontSetup(e.mode0, e.side0, e.type);
      const vArr = e.type === "190" ? FAI.v190 : TAC.arriveV * MPH;
      if (e.leader && e.leader.alive && e.leader.phase === "arrive") { // Rottenflieger: hold station on the leader, ~70 m out, stepped back
        S.x = e.leader.x + e.side0 * 48; S.y = e.leader.y - 6; S.z = e.leader.z + 40;
        e.vT = Math.min(e.type === "190" ? FAI.v190Cap : FAI.vFull, vArr + clamp((e.z - S.z) * 0.02, -20, 20) * MPH);
      } else e.vT = vArr;
      d = airDirTo(e, S.x, S.y, S.z);
      d = slopeLimit(e, d, -0.35, 0.12);
      d = safeDir(e, d);
      flyStepE(e, d.x, d.y, d.z, dt, 1.1);
      const S0 = frontSetup(e.mode0, e.side0, e.type);
      const leadGone = e.leader && e.leader.alive && e.leader.phase === "attack" && e.leader.phaseT > 0.9; // wingman follows ~1 s behind
      const ready = e.final ? (e.z > S0.z - 200 && Math.abs(e.x - S0.x) < 520) || e.phaseT > 34 : (e.z - S0.z < 160 || e.z < S0.z || leadGone);
      if (e.final && !ready) { e.vT = FAI.vFull; }
      if (ready) e.waitT = (e.waitT || 0) + dt; // 1.5.4: a bandit that has reached his setup point does NOT loiter there waiting for a slot — after 2 s he goes in regardless
      if ((e.leader && e.leader.alive && e.leader.phase === "arrive") ? false : (ready && (aiActive < FAI.maxActive || e.waitT > 2))) { aiActive++; e.final = false; commitPass(e, e.mode0); }
      return;
    }
    if (e.phase === "attack") {
      if (e.type === "190" && e.rockets > 0 && !e.hold) tryRockets(e);
      const A = e.aimPt;
      const rx = A.x - e.x, ry = A.y - e.y, rz = A.z - e.z;
      const vb = Math.hypot(e.vx, e.vy, e.vz) || 1;
      const along = (rx * e.vx + ry * e.vy + rz * e.vz) / vb;
      { const rA = Math.hypot(rx, ry, rz), fwm = e.opening ? FAI.fireOpen * 0.66 : (e.fireWin || TAC.fire.headon)[0]; e.jinking = rA > fwm + 90; if (along > 70) { const amp = (e.type === "190" ? 0.03 : 0.05) * clamp((rA - (fwm + 90)) / 700, 0, 1); const J = amp > 0.001 ? jinkAim(e, A, rA, amp) : A; d = airDirTo(e, J.x, J.y, J.z); } }
      if (along > 70) { /* jinked above */ }
      else d = { x: e.hx, y: e.hy, z: e.hz }; // committed: flash straight past
      d = safeDir(e, d);
      e.vT = e.type === "190" ? FAI.v190 * (e.sturm ? 0.97 : 1) : FAI.vFull;
      flyStepE(e, d.x, d.y, d.z, dt, e.type === "190" ? 1.5 : 2.0);
      if (e.invert && e.phaseT > 1.0) e.invert = false; // 1.3.7: the Split-S roll-in is over: fly the run upright
      const T = targetPoint(e.tgt);
      const tx = T.x - e.x, ty = T.y - e.y, tz = T.z - e.z;
      const range = Math.hypot(tx, ty, tz) || 1;
      const cosA = (tx * e.vx + ty * e.vy + tz * e.vz) / (range * vb);
      recAz190(e, T, range);
      const fw = e.fireWin || TAC.fire.headon;
      const fireMax = e.opening ? FAI.fireOpen * 0.66 : fw[0];
      if (e.ps && range < e.ps.minR) e.ps.minR = range;
      if ((e.p51chk = (e.p51chk || 0) - dt) <= 0) { // 1.5.7: a Mustang closing on him (nose-on, inside 330 u) and he is still short of the muzzle window → the run is abandoned (109 and 190 alike)
        e.p51chk = 0.2;
        if (range > fw[1] + 30) { const q = p51OnHim(e, 330); if (q && driveOff(e, q)) { if (q.followT == null || q.drove == null) { q.drove = e; q.followT = 0; } return; } }
      }
      const shipT = shipTargetOf(e);
      if (e.burst) { if (range < fw[1] || !shipT) { e.burst = null; e.burstGap = 0.6; } }
      else {
        e.burstGap = (e.burstGap || 0) - dt;
        if (e.burstGap <= 0 && e.burstsLeft > 0 && e.ammo > 0 && shipT && range < fireMax && range > fw[1] && cosA > 0.97) {
          e.burstsLeft--;
          if (!e.firedPass) { e.firedPass = true; e.ammo--; }
          if (mission) { mission.bursts = (mission.bursts || 0) + 1; if (mission.firstShotT == null) mission.firstShotT = mission.t; const ms = mission.modeStats; if (ms && ms[e.mode]) ms[e.mode].b++; }
          startBurst(e, shipT);
        }
      }
      const closing = (tx * e.vx + ty * e.vy + tz * e.vz) / range;
      e.dbg = { range: Math.round(range), cosA: +cosA.toFixed(3), along: Math.round(along), closing: Math.round(closing), bl: e.burstsLeft, m: e.mode };
      const is190 = e.type === "190";
      if ((range < e.breakR && closing > 0) || along < -25 || e.phaseT > (is190 ? 40 : 34) || (e.phaseT > (is190 ? 30 : 6) && closing < (is190 ? 12 : 40) && range > 250)) {
        e.burst = null;
        e.phase = "break"; e.phaseT = 0; e.invert = e.breakType === "splitS";
        e.brkSide = Math.random() < 0.5 ? -1 : 1;
        if (e.opening) { e.opening = false; if (mission) mission.openingPassed = (mission.openingPassed || 0) + 1; }
      }
      return;
    }
    if (e.phase === "break") { // breakaways from the 3rd BD study — always at speed
      let Lx = e.hz, Lz = -e.hx; const ll = Math.hypot(Lx, Lz) || 1; Lx /= ll; Lz /= ll;
      const s = e.brkSide || 1;
      e.vT = FAI.vFull;
      if (e.breakType === "splitS") d = norm3(e.hx * 0.3, -1, e.hz * 0.3);
      else if (e.type === "190") { const sb = e.brkSide || 1; d = norm3(e.hx * 0.25 + sb * 0.6, -0.9, e.hz * 0.12); e.vT = FAI.v190Cap; e.nMax = 6.3; } // 1.5.3: hard roll-and-dive break out to the side, gone from the turret quickly
      else d = norm3(e.hx, -0.5, e.hz); // under
      d = safeDir(e, d);
      flyStepE(e, d.x, d.y, d.z, dt, 2.4);
      if (e.phaseT > (e.breakType === "splitS" ? 2.4 : 1.8)) { e.phase = "extend"; e.phaseT = 0; e.invert = false; }
      return;
    }
    if (e.phase === "extend" && e.type === "190") { // through or under, a few seconds, then down to the reform station
      e.vT = FAI.v190;
      const so = e.brkSide || (e.x > BOX_C.x ? 1 : -1);
      d = safeDir(e, norm3(e.hx * 0.3 + so * 0.55, -0.75, e.hz * 0.3)); e.nMax = 6.3; // keeps diving away to the side
      flyStepE(e, d.x, d.y, d.z, dt, 1.2);
      if (e.phaseT > 3.0 || Math.hypot(e.x - BOX_C.x, e.z - BOX_C.z) > 1300) reformOrEgress(e);
      return;
    }
    if (e.phase === "extend") { // run out fast, level-ish or diving, until well clear
      e.vT = FAI.vFull;
      // run out AWAY from the box, ending up flying straight away (nose = motion on screen too)
      const so = e.x > BOX_C.x ? 1 : -1, away = e.z < BOX_C.z + 200 ? -1 : 1;
      d = safeDir(e, norm3(e.hx * 0.6 + so * 0.3, clamp(e.hy, -0.3, 0.04) - 0.06, e.hz * 0.6 + away * 0.9));
      flyStepE(e, d.x, d.y, d.z, dt, 0.9);
      const bc = Math.hypot(e.x - BOX_C.x, e.y - BOX_C.y, e.z - BOX_C.z);
      if ((bc > 1150 && e.phaseT > 2.5) || e.phaseT > 9) reformOrEgress(e);
      return;
    }
    if (e.phase === "winchester") { // 1.5.5: dry (two passes) - leave the area at speed, then gone
      e.vT = FAI.v190; e.nMax = 5.2;
      const ax = e.x - BOX_C.x, az = e.z - BOX_C.z, al = Math.hypot(ax, az) || 1;
      d = safeDir(e, norm3(ax / al, -0.06, az / al)); flyStepE(e, d.x, d.y, d.z, dt, 0.9);
      if (Math.hypot(ax, az) > 6500 || e.phaseT > 60) { e.alive = false; e.flash = 0; e.wreckT = 0; e.gone = true; if (mission) mission.n190gone = (mission.n190gone || 0) + 1; }
      return;
    }
    if (e.phase === "egress") { // out of ammo / breaking off: dive away from the box
      e.vT = FAI.vFull;
      const ax = e.x - BOX_C.x, az = e.z - BOX_C.z, al = Math.hypot(ax, az) || 1;
      d = safeDir(e, norm3(ax / al, -0.12, az / al));
      flyStepE(e, d.x, d.y, d.z, dt, 0.8);
      if (e.phaseT > 8 && !p51OnTail(e, 600)) startReform(e);
      return;
    }
    // 1.4.1 reform: back to a station ~1.5–2 km out on a front flank; "setup": hold there in plain sight until the
    // wave scheduler releases them; "rollin": climb and roll away, then a curve of pursuit onto the ship
    if (e.phase === "rollin") {
      const out = e.rSide || 1;
      if (e.phaseT < 0) { flyStation(e, stationOf(e), dt); return; } // waiting for the one ahead to peel off
      if (e.type === "190") { relaunch190(e); return; } // 1.5.5: 190s never roll in from a station — they re-enter as a fresh rear-quarter launch
      if (e.phaseT < 1.5) { // pull up and roll away from the box
        e.vT = FAI.vFull; d = safeDir(e, norm3(out * 0.5, 0.42, 1)); flyStepE(e, d.x, d.y, d.z, dt, 1.4);
      } else {
        if (!e.tgtPre) e.tgtPre = (e.hunt && huntOk(e.hunt)) ? e.hunt : pickFormationTarget(e, "fq");
        const T = targetPoint(e.tgtPre);
        e.vT = FAI.vDive; d = airDirTo(e, T.x, T.y + 40, T.z); d = safeDir(e, d); flyStepE(e, d.x, d.y, d.z, dt, 0.75); // rate-limited turn in = a curve of pursuit
        const r = Math.hypot(T.x - e.x, T.y - e.y, T.z - e.z);
        if ((r < 950 || e.phaseT > 11) && aiActive < FAI.maxActive) { aiActive++; commitPass(e, e.z - T.z > 350 ? "fq" : "reattack"); }
      }
      return;
    }
    const St = stationOf(e);
    const dist = flyStation(e, St, dt);
    if (e.phase === "reform" && e.type === "190" && !e.hold && (dist < 520 || e.phaseT > 45)) { relaunch190(e); return; } // 1.5.5: a 190 never holds on a station - it re-enters as a fresh run-in straight from the reform leg
    if (e.phase === "reform" && dist < 420 && e.phaseT > 2) { e.phase = "setup"; e.phaseT = 0; if (e.finalQ && mission && e.type === "109") { e.finalQ = false; e.mode0 = "headon"; e.side0 = e.x > BOX_C.x ? 1 : -1; e.final = true; e.phase = "arrive"; e.reattack = true; e.leader = null; } }
    if (e.phase === "reform" && e.phaseT > 110) { e.phase = "setup"; e.phaseT = 0; } // never stuck chasing the station
  }

  // ===== 1.5.2 STRAGGLERS + HUNTERS =====
  function smooth01(x) { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); }
  function playerStragK() { return mission && mission.playerOutT != null && bomber && !bomber.dead ? smooth01((mission.t - mission.playerOutT) / 50) : (mission && mission.playerOutT != null && downSeq ? 1 : 0); }
  function huntOk(t) { return t && (t.kind === "player" ? !!(bomber && !bomber.dead && bomber.out) : (t.f && friendlyOk(t.f) && t.f.out)); }
  function huntPos(t) { return t.kind === "player" ? { x: 0, y: BOMBER_AIM_Y, z: 0 } : { x: t.f.x, y: t.f.y, z: t.f.z }; }
  function anchorOf(e) { return e.hunt && huntOk(e.hunt) ? huntPos(e.hunt) : BOX_C; }
  function stragglerList() {
    const L = [];
    if (!mission) return L;
    if (bomber && !bomber.dead && bomber.out && mission.playerOutT != null && mission.t - mission.playerOutT > 4) L.push({ kind: "player" });
    for (const f of friendlies) if (friendlyOk(f) && f.out && f.outAt != null && mission.t - f.outAt > 6 && Math.hypot(f.x - BOX_C.x, f.z - BOX_C.z) > 260) L.push({ kind: "friendly", f });
    return L;
  }
  function sameHunt(a, b) { return a && b && a.kind === b.kind && (a.kind === "player" || a.f === b.f); }
  function assignHunters(dt) {
    if (!mission) return;
    mission.huntChk = (mission.huntChk || 0) - dt;
    if (mission.huntChk > 0) return;
    mission.huntChk = 1.2;
    const L = stragglerList();
    for (const e of enemies) if (e.hunt && !L.some((t) => sameHunt(t, e.hunt))) { e.hunt = null; if (e.phase === "stack") { e.phase = "reform"; e.phaseT = 0; } }
    // the P-51s: only the astern element (a few, leash-bound) shadows the straggler
    stragNow = null;
    for (const t of L) { const P = huntPos(t); if (Math.hypot(P.x - BOX_C.x, P.y - BOX_C.y, P.z - BOX_C.z) > 350) { stragNow = P; break; } }
    for (let k = 0; k < L.length && k < 3; k++) {
      const t = L[k], hunters = enemies.filter((e) => e.alive && e.hunt && sameHunt(e.hunt, t));
      const n190 = hunters.filter((e) => e.type === "190").length, n109 = hunters.length - n190;
      const want190 = 2, want109 = t.kind === "player" ? 0 : 1;
      const free = (ty) => enemies.filter((e) => e.alive && e.team !== "allied" && !e.hold && e.type === ty && !e.hunt && (e.phase === "setup" || e.phase === "reform" || e.phase === "extend" || e.phase === "egress" || e.phase === "stack" || e.phase === "quarter" || e.phase === "rollin"));
      let need = want190 - n190;
      for (const e of free("190")) {
        if (need <= 0) break;
        e.hunt = t; e.tgtPre = null; e.ammo = Math.max(e.ammo, 2);
        // 1.5.5: no stack/hold behind the box - the hunter finishes whatever leg he is on and re-enters from the rear quarter (relaunch190)
        need--; if (mission) mission.huntAssign = (mission.huntAssign || 0) + 1;
      }
      need = want109 - n109;
      for (const e of free("109")) { if (need <= 0) break; e.hunt = t; need--; if (e.phase === "setup" || e.phase === "reform") { e.phase = "rollin"; e.phaseT = -rand(0, 2); e.tgtPre = t; } }
    }
    // hunters that finished a pass and sit on their station go in again at once
    for (const e of enemies) if (e.alive && e.hunt && e.phase === "setup" && e.phaseT > 2.5) {
      if (e.type === "190") { startReform(e); }
      else { e.phase = "rollin"; e.phaseT = -rand(0, 1.5); e.tgtPre = e.hunt; }
    }
    if (mission) mission.stragSeen = Math.max(mission.stragSeen || 0, L.length);
  }
  function idleAxisNow() { // alive Germans that are NOT engaging right now: parked on a station / diving away / far from the box
    let alive = 0, idle = 0, far = 0; const ph = {};
    for (const e of enemies) {
      if (!e.alive || e.team === "allied" || e.phase === "debug") continue;
      alive++;
      const eng = e.phase === "attack" || e.phase === "break" || e.phase === "rollin" || e.phase === "arrive" || e.phase === "inbound" || e.phase === "stack" || e.phase === "quarter" || e.phase === "extend";
      if (!eng) { idle++; ph[e.phase] = (ph[e.phase] || 0) + 1; }
      if (!e.hold && Math.hypot(e.x - BOX_C.x, e.y - BOX_C.y, e.z - BOX_C.z) > 1800) far++;
    }
    return { alive, idle, far, ph };
  }
  // ===== 1.5.2 WGr.21 rockets (first-wave 190s, 2 tubes, fired from 1,200–2,000 yd; most miss, a hit is a heavy blow) =====
  let rockets = [], rktSeq = 0;
  const RKT_V = 205;                       // u/s relative to the launcher (≈ 310 m/s)
  function tryRockets(e) {
    if (e.rockets <= 0 || !mission) return;
    if (!e.rktTgt) { e.rktTgt = pick190Target(e); }
    const tgt = e.rktTgt, T = targetPoint(tgt);
    const rx = T.x - e.x, ry = T.y - e.y, rz = T.z - e.z, R = Math.hypot(rx, ry, rz);
    if (R > 1200 || R < 700) { if (R < 700) { e.rockets = 0; e.rktTgt = null; } return; } // 1,150–1,970 yd
    const cosA = (rx * e.hx + ry * e.hy + rz * e.hz) / R;
    if (cosA < 0.8) return;
    e.tgtPre = e.rktTgt; // the same ship takes the cannon pass that follows
    const sx = e.uy * e.hz - e.uz * e.hy, sy = e.uz * e.hx - e.ux * e.hz, sz = e.ux * e.hy - e.uy * e.hx; // port side
    const vex = e.vx, vey = e.vy, vez = e.vz;
    // fire solution: the speed relative to the launcher is RKT_V, so find the flight time t with |R/t − v_e| = RKT_V (one drop-compensation iteration)
    let Rx = rx, Ry = ry, Rz = rz, tf = R / (RKT_V + 40);
    for (let it = 0; it < 2; it++) {
      const RR = Rx * Rx + Ry * Ry + Rz * Rz, Rv = Rx * vex + Ry * vey + Rz * vez, vv = vex * vex + vey * vey + vez * vez;
      const disc = Math.max(0, Rv * Rv - RR * (vv - RKT_V * RKT_V)), u = (Rv + Math.sqrt(disc)) / RR;
      tf = 1 / Math.max(1e-3, u);
      Rx = rx; Ry = ry + 0.5 * G_U * tf * tf; Rz = rz; // aim over the target by the drop
    }
    const RR = Rx * Rx + Ry * Ry + Rz * Rz, Rv = Rx * vex + Ry * vey + Rz * vez, vv = vex * vex + vey * vey + vez * vez;
    const u = (Rv + Math.sqrt(Math.max(0, Rv * Rv - RR * (vv - RKT_V * RKT_V)))) / RR;
    let dx = (Rx * u - vex) / RKT_V, dy = (Ry * u - vey) / RKT_V, dz = (Rz * u - vez) / RKT_V;
    const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
    const bias = [gaussR() * 0.016, gaussR() * 0.016]; // salvo aim error (rad)
    for (let k = 0; k < 2; k++) {
      let ex = dx, ey = dy, ez = dz;
      const a = bias[0] + gaussR() * 0.007, b = bias[1] + gaussR() * 0.007;
      let ux2 = -dz, uz2 = dx; const ul = Math.hypot(ux2, uz2) || 1; ux2 /= ul; uz2 /= ul;
      ex += ux2 * a; ez += uz2 * a; ey += b;
      const el = Math.hypot(ex, ey, ez) || 1; ex /= el; ey /= el; ez /= el;
      const side = k ? -1 : 1;
      rockets.push({ id: ++rktSeq, x: e.x + sx * 3.2 * side + e.hx * 1.5, y: e.y - 0.6, z: e.z + sz * 3.2 * side + e.hz * 1.5, vx: vex + ex * RKT_V, vy: vey + ey * RKT_V, vz: vez + ez * RKT_V, t: 0, life: tf + 0.25, src: e.type, tgt: tgt });
    }
    e.rockets = 0;
    const K = mission.rkt || (mission.rkt = { fired: 0, direct: 0, burst: 0, fragHits: 0, shooters: 0 });
    K.fired += 2; K.shooters++;
    if (window.FGAudio && window.FGAudio.rocket) window.FGAudio.rocket(e.x, e.y, e.z);
    if (!mission.rktCalled) { mission.rktCalled = true; pushCallout("ROCKETS — 190s " + clockLabel(e.x, e.z) + " LOW!", 1.8, true); }
  }
  function rocketPuff(x, y, z, size) {
    flakBursts.push({ id: ++flakSeq, x, y, z, t: 0, seed: Math.random() * 1000, hit: false, size: size || 0.9, pending: false });
    if (flakBursts.length > 120) flakBursts.shift();
    if (window.FGAudio && window.FGAudio.flak) window.FGAudio.flak(x, y, z);
  }
  function updateRockets(dt) {
    if (!rockets.length) return;
    const K = mission && (mission.rkt || (mission.rkt = { fired: 0, direct: 0, burst: 0, fragHits: 0, shooters: 0 }));
    for (const r of rockets) {
      const px = r.x, py = r.y, pz = r.z;
      r.vy -= G_U * dt;
      r.x += r.vx * dt; r.y += r.vy * dt; r.z += r.vz * dt; r.t += dt;
      const dx = r.x - px, dy = r.y - py, dz = r.z - pz, len = Math.hypot(dx, dy, dz) || 1;
      const h = rayShips(px, py, pz, dx / len, dy / len, dz / len, len);
      if (h) { // direct hit: heavy
        r.dead = true; if (K) K.direct++;
        rocketPuff(h.x, h.y, h.z, 1.05);
        if (shipLive(h.s)) shipHit(h.s, h.id, "wgr21", 1, "190");
        if (window.FGAudio && window.FGAudio.rocketImpact) window.FGAudio.rocketImpact(h.s === bomber, h.x, h.y, h.z);
        continue;
      }
      if (r.t >= r.life) { // time fuze: airburst, fragments reach anything within ~26 u
        r.dead = true; if (K) K.burst++;
        rocketPuff(r.x, r.y, r.z, 0.85);
        if (window.FGAudio && window.FGAudio.rocketImpact) window.FGAudio.rocketImpact(false, r.x, r.y, r.z);
        const cand = [];
        if (bomber && !bomber.dead) cand.push(bomber);
        for (const f of friendlies) if (friendlyOk(f)) cand.push(f);
        for (const sH of cand) {
          const c = sH === bomber ? CAM : sH, d = Math.hypot(c.x - r.x, c.y - r.y, c.z - r.z);
          if (d < 26 && Math.random() < 0.7 * (1 - d / 26) + 0.1) { if (K) K.fragHits++; shipHit(sH, FC.pickStrike("beam"), "wgr21", 1, "190", { scale: 0.22, fireMul: 0.4 }); }
        }
      }
    }
    rockets = rockets.filter((r) => !r.dead && r.t < 9);
  }

  // 1.4.1 wave scheduler: every 12–18 s release 2–4 of the fighters holding station (longest-waiting first),
  // keeping a couple visibly setting up; the last head-on wave comes in at TGT ~1:30
  function waveScheduler() {
    if (!mission) return;
    if (mission.nextWave == null) mission.nextWave = TAC.firstWave;
    if (!mission.finalWave && mission.timeLeft <= 116) { // they need ~25 s to swing out ahead → head-on at ~TGT 1:30
      mission.finalWave = true;
      let k = 0;
      if (mission.held) { for (const e of mission.held) { e.launchAt = mission.t; } }
      for (const e of enemies) {
        if (!e.alive || e.type !== "109" || e.ammo <= 0 || !(e.phase === "setup" || e.phase === "reform" || e.phase === "extend")) continue;
        if (e.phase !== "setup" && Math.hypot(e.x - BOX_C.x, e.y - BOX_C.y, e.z - BOX_C.z) < 3200) { e.finalQ = true; continue; } // 1.5.4: no U-turn right beside the box — he finishes his reform leg first, then comes in
        e.mode0 = k % 3 === 2 ? "fq" : "headon"; e.side0 = e.x > BOX_C.x ? 1 : -1; e.final = true;
        e.phase = "arrive"; e.phaseT = 0; e.reattack = true; e.leader = null; k++;
      }
      mission.finalN = k;
      pushCallout("HERE THEY COME AGAIN — 12 O'CLOCK LEVEL, THE WHOLE BUNCH!", 2.4, true); sfxIntercom();
      mission.nextWave = mission.t + 30;
      return;
    }
    { // 190s: the second pass from the low rear quarter, released as a company (>=3 regrouped, or any that waited 3 s) - 2 passes, then empty
      const w190 = enemies.filter((e) => e.alive && e.type === "190" && e.phase === "setup" && e.ammo > 0 && !e.hunt);
      if ((w190.length >= 3 || w190.some((e) => e.phaseT > 3)) && mission.t >= (mission.next190 || 0)) {
        w190.forEach((e, i) => { e.phase = "rollin"; e.phaseT = -(i >> 1) * 1.2; e.tgtPre = null; });
        mission.next190 = mission.t + 10; mission.waves190 = (mission.waves190 || 0) + 1;
      }
    }
    if (mission.t < mission.nextWave) { if ((mission.idleChk = (mission.idleChk || 0) + 1) % 30 === 0) releaseIdle(); return; }
    const wait = enemies.filter((e) => e.alive && e.type === "109" && e.phase === "setup" && e.ammo > 0).sort((a, b) => b.phaseT - a.phaseT);
    const pool = wait.length + enemies.filter((e) => e.alive && e.type === "109" && e.phase === "reform").length;
    if (wait.length < 1) { mission.nextWave = mission.t + 2.5; releaseIdle(); return; }
    let n = Math.round(rand(TAC.waveN[0], TAC.waveN[1]));
    if (pool >= 5) n = Math.min(n, wait.length - 2); // keep a couple on station, visible, for the next one
    let crowd = false;
    if (wait.length - n > TAC.stationMax) { n = Math.min(6, wait.length - TAC.stationMax + 1); crowd = true; } // don't let a crowd idle out there
    n = clamp(n, 1, wait.length);
    for (let i = 0; i < n; i++) { const e = wait[i]; e.phase = "rollin"; e.phaseT = -i * rand(0.8, 1.6); e.tgtPre = null; } // peel off one after another
    mission.waves = (mission.waves || 0) + 1;
    mission.nextWave = mission.t + (crowd ? rand(4, 6) : rand(TAC.waveGap[0], TAC.waveGap[1]));
    releaseIdle();
  }
  // 1.5.2: nobody idles out of sight — any German that has sat on his station for 12 s goes back in
  function releaseIdle() {
    for (const e of enemies) if (e.alive && e.team !== "allied" && !e.hold && e.phase === "setup" && e.phaseT > 12) { e.phase = "rollin"; e.phaseT = -rand(0, 1.2); e.tgtPre = null; }
  }
  function makeMissionFighter(type) {
    type = type || "109";
    const is190 = type === "190", isP = type === "p51";
    const hp = is190 ? TUNE.fighterHp190 : isP ? TUNE.fighterHpP51 : TUNE.fighterHp;
    const e = {
      type, vCap: is190 ? FAI.v190Cap : FAI.vDive, jPh: Math.random() * 6.28, jT: 2 + Math.random() * 1.2, team: isP ? "allied" : "axis", x: 0, y: 0, z: 0, hp, maxHp: hp,
      vx: 0, vy: 0, vz: 0, speed: 0, bank: 0, roll: 0, yawAtt: Math.PI, pitchAtt: 0,
      hx: 0, hy: 0, hz: -1, ux: 0, uy: 1, uz: 0, p: 0, V: 350 * MPH, phi: 0, gLoad: 1,
      phase: "inbound", phaseT: 0, fireCd: 1, alive: true, flash: 0, smoke: isP ? 0 : 0.3,
      passSide: 1, trail: [], burstsLeft: 0, burst: null, burstGap: 0,
      ammo: isP ? 999 : is190 ? TAC.ammo190 : TAC.ammo, breakOffT: rand(22, 48), vT: 0,
      presser: !is190 && !isP && Math.random() < TAC.presserFrac,
      sturm: is190 && Math.random() < 0.5, r6: false,
      id: Math.random().toString(36).slice(2, 9),
    };
    return e;
  }
  const SCHWARM = [[0, 0, 0], [28, -4, 22], [-38, 0, 12], [-66, -4, 34]];
  // 1.5.5 (md v1.5.5 BUG A): a 190 is placed ALREADY on the rear quarter - 5 o'clock (right = -X) or 7 o'clock (left = +X) - 900-1,140 u abeam and 1,100+ u aft (~1,420-1,500 u out),
  // 140 u (~700 ft) below, nose pointed through the box, at v190 from the first frame. Used for the first launch AND for every re-entry (a fresh launch, never a hold point).
  function placeQtr190(e, side, i, wave) { // side: +1 = +X (left, 7 o'clock), -1 = 5 o'clock; i = slot in the front; wave = row (0/1, ~2.8 s apart)
    const An = anchorOf(e), V = FAI.v190;
    // 1.5.7: a flight of FOUR on its quarter: finger-four abreast (lateral 720 + 0/75/150/230 u from the target), stepped back 0/30/10/45 u
    const j = i & 3, LAT = [0, 75, 150, 230], BK = [0, 30, 10, 45];
    e.x = An.x + side * (720 + LAT[j]) + rand(-15, 15);
    e.y = An.y - 140 - wave * 40 + rand(-10, 10) - (j & 1) * 6;
    e.z = An.z - 1100 - wave * 330 - BK[j] + rand(-20, 20);
    const dv = norm3(An.x - e.x, An.y - 20 - e.y, An.z - e.z);
    e.V = V; const bb = VF * dv.z, sB = -bb + Math.sqrt(Math.max(0, bb * bb - VF * VF + V * V));
    initAttitude(e, { x: sB * dv.x, y: sB * dv.y, z: sB * dv.z + VF }, 0);
    e.nMax = null; e.vT = V; e.evadeT = 0; e.slotX = side; e.phase = "quarter"; e.phaseT = 0; e.tgt = null; e.tgtPre = null; e.azRec = null;
  }
  function relaunch190(e) { // reform leg finished (3,000+ u aft and 3,000 ft low, far outside the turret's range): re-enter as a fresh launch on the flank he is on
    placeQtr190(e, e.x > BOX_C.x ? 1 : -1, (Math.random() * 4) | 0, 0); e.waitT = 0;
    if (mission) mission.relaunch190 = (mission.relaunch190 || 0) + 1;
  }
  function spawnMissionFighters(count) {
    let n = Math.min(count, MISSION_FIGHTERS - (mission ? mission.fightersSpawned : 0));
    let leader = null;
    const add = (e) => { enemies.push(e); if (mission) mission.fightersSpawned++; n--; };
    // 1.5.7 THE OPENING SLASH — ALL 20 Bf 109s come at once, 12 o'clock high, as 5 flights of four in finger-four (leader, wingman out to starboard and back, 3rd far to port, 4th farther still),
    // the flights spread across the front ~300 u apart. They are in the air ~4,900 u (7 km) out, visible as specks, and close at 425-450 mph (≈630 mph, 187 u/s, on the 180 mph box): first guns at ~27-30 s.
    // Each flight hits ONE ship (the leader picks, the others follow); there is no warning trio and no second Staffel any more (the old 8 + 6 + 6 pairs are these 20).
    const FOURS = [[0, 0, 0], [62, -4, 26], [-88, -2, 34], [-150, -6, 62]]; // x lateral (u), y rel (u), z back (u): a finger-four, ~100 m line-abreast spacing
    for (let fl = 0; fl < 5; fl++) {
      let lead = null;
      for (let pos = 0; pos < 4 && n > 0; pos++) {
        const e = makeMissionFighter("109");
        e.r6 = fl >= 3 && pos === 0 && (fl & 1) === 1; // an occasional R6 gondola ship
        const cx = BOX_C.x + (fl - 2) * 300 + rand(-20, 20), cy = BOX_C.y + 840 + (fl % 2) * 90 + rand(-15, 15), cz = BOX_C.z + 4900 + fl * 35 + rand(-30, 30);
        e.x = cx + FOURS[pos][0]; e.y = cy + FOURS[pos][1] + rand(-3, 3); e.z = cz + FOURS[pos][2];
        const dv = norm3(BOX_C.x + (fl - 2) * 120 - e.x, BOX_C.y + 60 - e.y, BOX_C.z - e.z);
        const V = 425 * MPH; e.V = V;
        const b = VF * dv.z, sB = -b + Math.sqrt(Math.max(0, b * b - VF * VF + V * V));
        initAttitude(e, { x: sB * dv.x, y: sB * dv.y, z: sB * dv.z + VF }, 0);
        e.opening = true; e.staffel = 1; e.flight109 = fl; e.pos109 = pos; e.seq = fl * 4 + pos;
        if (pos === 0) lead = e; else e.leader = lead;
        e.launchAt = 1.5 + fl * 0.9; e.hold = true;
        add(e); enemies.pop(); (mission.held || (mission.held = [])).push(e);
      }
    }
    // the Hammer (1.5.5, doctrine md v1.5.5): two companies of 8x Fw 190 (half Sturmbock) launched ALREADY on the rear quarters - 5 o'clock and 7 o'clock - nose through the box, v190 from
    // the first frame. Each company is 4 abreast in 2 rows ~2.8 s apart; company B follows while A is still exiting under. No stack / hold point anywhere. (game +X is the turret's LEFT)
    const SCN = window.__FG_SCN || {};
    for (let w = 0; w < 2 && !SCN.no190; w++) {
      for (let i = 0; i < 8 && n > 0; i++) {
        const e = makeMissionFighter("190");
        const side = i < 4 ? -1 : 1, row = w; // 1.5.7: i 0-3 = the 5 o'clock flight of four, 4-7 = the 7 o'clock flight; company w=1 follows ~330 u further aft
        e.rank = w; e.flight190 = w * 2 + (i < 4 ? 0 : 1); e.pos190 = i & 3;
        if (w === 0 && (i & 3) === 0) e.rockets = 2; // WGr.21 on the first company's lead pair (first wave only)
        placeQtr190(e, side, i, row);
        e.wing = i & 1; e.q190 = true; e.mode0 = "quarter"; e.side0 = side;
        e.launchAt = (w ? 48 : 36); e.hold = true; e.staffel = 5 + w; e.seq = 20 + w * 10 + i; // 1.5.7: first contact ~45 s (launch 36 s + ~9 s run-in at ~100 u/s), the second company ~12 s later
        add(e);
        enemies.pop(); (mission.held || (mission.held = [])).push(e);
      }
    }
    // the Sheriffs: 18 Mustangs on a high cap (not counted on the Axis HUD)
    p51Fl = [];
    if (!SCN.nop51) for (let i = 0; i < MISSION_NP51; i++) enemies.push(makeP51(i));
  }

  function missionFighterLoop(dt) {
    aiActive = 0;
    if (mission && mission.firstSeenT == null) for (const q of enemies) if (q.alive && q.team !== "allied" && !q.hold && q.phase !== "debug" && Math.hypot(q.x - CAM.x, q.y - CAM.y, q.z - CAM.z) < 6500) { mission.firstSeenT = mission.t; break; }
    for (const e of enemies) if (e.alive && e.phase === "attack" && e.type === "109") aiActive++;
    assignHunters(dt);
    waveScheduler();
    updateRockets(dt);
    settlePasses();
    for (const e of enemies) {
      if (!e.alive) { // falling wreck, trailing smoke (world3d)
        e.wreckT = (e.wreckT || 0) - dt;
        e.wreckAge = (e.wreckAge || 0) + dt;
        if (e.bailAt > 0 && e.wreckAge >= e.bailAt) { e.bailAt = -1; spawnChute(e.x, e.y - 0.5, e.z, e.vx * 0.5, e.vy * 0.5, e.vz * 0.8, "de"); }
        e.vy -= 14 * dt;
        e.vz += (-VF - e.vz) * 0.25 * dt;
        e.x += e.vx * dt; e.y += e.vy * dt; e.z += e.vz * dt;
        e.bank = (e.bank || 0) + dt * 3.5;
        attitudeFromVel(e);
        e.flash = Math.max(0, (e.flash || 0) - dt * 3);
        continue;
      }
      if (e.phase === "debug") continue; // posed test fighter
      updateFighterAI(e, dt);
      e.x += e.vx * dt; e.y += e.vy * dt; e.z += e.vz * dt;
      e.speed = Math.hypot(e.vx, e.vy, e.vz);
      if (e.type === "190" && mission) { // 1.5.2 telemetry: closing speed (box frame) while a 190 is in a pass — a sitting duck shows up as a low number
        const ph = e.phase, mph = e.speed / MPH, R = mission.r190 || (mission.r190 = { fireN: 0, fireSum: 0, fireMin: 1e9, passN: 0, passSum: 0, passMin: 1e9, loiter: 0, passT: 0 });
        if (ph === "attack" || ph === "stack" || ph === "quarter" || ph === "rollin" || ph === "extend" || ph === "break") {
          if (ph === "attack") { R.passN++; R.passSum += mph; if (mph < R.passMin) R.passMin = mph; }
          if (e.burst) { R.fireN++; R.fireSum += mph; if (mph < R.fireMin) R.fireMin = mph; }
          if (ph !== "break" && mph < 110 && Math.hypot(e.x - BOX_C.x, e.y - BOX_C.y, e.z - BOX_C.z) < 1500) R.loiter += dt;
        }
      }
      e.yawAtt = Math.atan2(e.hx, e.hz); e.pitchAtt = Math.asin(clamp(e.hy, -0.99, 0.99));
      if (e.burst) fighterFireTick(e, dt);
      e.flash = Math.max(0, e.flash - dt * 4);
      e.trail.push({ x: e.x, y: e.y, z: e.z });
      if (e.trail.length > 30) e.trail.shift();
    }
    enemies = enemies.filter((e) => e.alive || e.flash > 0 || (e.wreckT || 0) > 0);
  }

  function updateMission(dt) {
    if (!MISSION_MODE || !mission || state !== "PLAYING") return;
    if (mission.evaluated) return;
    mission.t += dt;
    mission.timeLeft = Math.max(0, MISSION_DURATION - mission.t);
    if (mission.held && mission.held.length) { // 1.3.8: later Rotten launch into the fight
      let on190 = 0; for (const q of enemies) if (q.type === "p51" && q.phase === "intercept" && q.target && q.target.type === "190") on190++;
      const rel = [];
      for (let i = mission.held.length - 1; i >= 0; i--) {
        const e = mission.held[i];
        if (mission.t >= e.launchAt || (e.slip && on190 >= 10 && mission.t > 24 && e.launchAt - mission.t < 28)) { rel.push(e); mission.held.splice(i, 1); }
      }
      rel.sort((a, b) => (a.seq || 0) - (b.seq || 0));
      for (const e of rel) { // the Schwarm slips in from 12 o'clock when the Mustangs have all gone for the 190s
        if (e.slip) { const S = frontSetup(e.mode0, e.side0); e.x = S.x + e.side0 * (300 + rand(0, 400)) + e.wing * 45; e.y = S.y + 700 + rand(0, 900); e.z = S.z + (TAC.arriveV + 280) * MPH * 22 + e.wing * 40; e.slipped = true; if (on190 >= 10) mission.slipOn190 = true; }
        e.hold = false; enemies.push(e);
        if (e.staffel === 1) {
          if (!mission.inboundCalled) { mission.inboundCalled = true; pushCallout("BANDITS INBOUND — 109s 12 O'CLOCK HIGH · 190s 5 AND 7 O'CLOCK", 2.6, true); sfxIntercom(); }
          commitPass(e, "headon"); e.diveT = mission.t;
        } else if (e.q190) {
          const cq = e.slotX > 0 ? "7" : "5"; mission.calledQ = mission.calledQ || {};
          if (!mission.calledQ[cq]) { mission.calledQ[cq] = true; mission.called190 = true; pushCallout("190s " + cq + " O'CLOCK LOW", 2.0, true); sfxIntercom(); }
          if (mission.firstLaunch190 == null) mission.firstLaunch190 = mission.t;
          e.phase = "quarter"; e.phaseT = 0;
        }
      }
    }
    if (!mission.escortCalled && mission.t > 6) { mission.escortCalled = true; pushCallout("LITTLE FRIENDS ON STATION — MUSTANGS OVERHEAD", 2.6); }

    // Staffel arrivals
    const wv = MISSION_WAVES[mission.waveIdx];
    if (wv && mission.t >= wv.at) {
      mission.pendingSpawn += wv.n;
      mission.waveIdx++;
    }
    if (mission.pendingSpawn > 0) {
      mission.spawnAcc += dt;
      {
        mission.spawnAcc = 0;
        const n = mission.pendingSpawn;
        spawnMissionFighters(n);
        mission.pendingSpawn -= n;
      }
    }

    if (!mission.doorsOpen && mission.timeLeft <= MISSION_DOORS_AT) {
      mission.doorsOpen = true; mission.doorsAt = mission.t;
      mission.phase = "doors";
      pushCallout("BOMB BAY DOORS OPEN", 1.8, true);
      sfxIntercom();
    }

    if (mission.doorsOpen && !mission.bombsAway && mission.timeLeft <= MISSION_RELEASE_AT) {
      mission.bombsAway = true;
      mission.phase = "release";
      mission.bombersDropped = countBombCapable();
      pushCallout("BOMBS AWAY — " + mission.bombersDropped + " SHIPS", 2.4, true);
      sfxIntercom();
      // 1.4.1: the lead ship's stick goes first, the rest toggle on him over ~1.5 s; each ship lifts as the load
      // goes; the rack clunks + thump, and our own ship lurches up (gunner.lift) — the bombs are 3D sticks in world3d
      if (window.FGAudio && window.FGAudio.bombsAway && !downSeq) window.FGAudio.bombsAway();
      const sticks = [];
      for (const f of friendlies) {
        if (!friendlyOk(f)) continue;
        const lead = f.sq === "lead" && f.el === 0;
        const delay = lead ? 0 : rand(0.35, 1.6);
        // 1.5.2: ships stacked behind the lead (trailing squadrons) pickle when the town passes under THEM, not at the lead's call — their sticks landed ~1.5 km short
        const behind = clamp((CAM.z - f.z) / VF, 0, 14);
        sticks.push({ x: f.x, y: f.y - 1.6, z: f.z + 0.6, n: lead ? 12 : f.sq === "lead" ? 8 : 6, delay: delay + behind, lead, f });
        f.liftAt = mission.t + delay; f.bayCloseAt = mission.t + delay + behind + (lead ? 12 : f.sq === "lead" ? 8 : 6) * 0.12 + 1.0;
      }
      if (bomber && !bomber.dead && !downSeq) { sticks.push({ own: true, x: CAM.x, y: CAM.y - 5.2, z: CAM.z - 3.5, n: 6, delay: 0.5 }); gunner.liftAt = mission.t + 0.5; }
      if (World3D && World3D.dropBombs) World3D.dropBombs(sticks.map((q) => ({ x: q.x, y: q.y, z: q.z, n: q.n, delay: q.delay, lead: !!q.lead, own: !!q.own })));
      mission.sticks = sticks.length;
      tgtInit(sticks);
    }
    if (mission.doorsOpen) { // 1.5.3: every Fortress's bay doors swing open (staggered) on the bomb run and close ~1 s after its last bomb is away
      for (const f of friendlies) {
        if (f.bayDelay == null) f.bayDelay = rand(0, 3.5);
        const want = (mission.t - (mission.doorsAt || 0) > f.bayDelay && !(f.bayCloseAt != null && mission.t > f.bayCloseAt)) ? 1 : 0;
        const cur = f.bayOpen || 0;
        f.bayOpen = want > cur ? Math.min(want, cur + dt * 0.7) : Math.max(want, cur - dt * 0.7);
      }
    }
    if (mission.bombsAway) {
      mission.post += dt;
      tgtStep(dt);
      for (const f of friendlies) if (f.liftAt != null && mission.t >= f.liftAt) { f.lift = Math.max(f.lift || 0, 4.2); f.liftAt = null; }
      if (gunner.liftAt != null) { const lt = mission.t - gunner.liftAt; gunner.lift = lt < 0 ? 0 : lt > 6 ? 0 : 3.4 * (1 - Math.exp(-lt / 0.3)) * Math.exp(-lt / 1.8); gunner.liftP = lt < 0 || lt > 6 ? 0 : 0.03 * Math.exp(-lt / 0.5) * (1 - Math.exp(-lt / 0.12)); if (lt > 6) gunner.liftAt = null; }
      if (!mission.turningBack && mission.post > 1.5) {
        mission.turningBack = true;
        mission.phase = "egress";
        pushCallout("FORMATION TURNING FOR HOME", 1.8, true);
      }
      if (mission.post >= MISSION_EVAL_DELAY && !mission.evaluated) {
        mission.evaluated = true;
        mission.phase = "done";
        // 1.3.8: if we're still spinning down / under the canopy, the debrief waits for the sequence
        if (downSeq && !downSeq.finished) { mission.pendingWon = mission.bombersDropped >= MISSION_WIN_DROPS; return; }
        endMission(mission.bombersDropped >= MISSION_WIN_DROPS);
        return;
      }
    }

    // 1.3.6: the rally turn for home — every ship rolls into a ~21° coordinated bank (roll-in over
    // ~5 s), the formation wheels at the physical rate for that bank at 180 mph (ω = g·tanφ / V)
    // through ~90°, and rolls out as the 60 s run ends. Ground, clouds, sun and 109s swing accordingly.
    mission.odo = (mission.odo || 0) + VF * dt;
    const geo = mission.geo || (mission.geo = { x: 0, z: VF * GEO_LEAD, rot: 0 });
    geo.z -= VF * dt; // the ground streams aft at the box's 180 mph ground speed
    const hd0 = mission.heading || 0;
    const remain = TURN_TOTAL - hd0;
    const rollIn = mission.turningBack ? clamp((mission.post - 1.5) / 5, 0, 1) : 0;
    const turnRoll = TURN_BANK * rollIn * rollIn * (3 - 2 * rollIn) * clamp(remain / 0.22, 0, 1);
    mission.turnRoll = turnRoll;
    if (mission.turningBack && remain > 0) {
      const w = 9.81 * Math.tan(turnRoll) / (B17_MPH * 0.44704); // coordinated turn rate (rad/s)
      const dH = Math.min(remain, Math.max(turnRoll > 0.01 ? 0.0006 : 0, w) * dt);
      mission.heading = hd0 + dH;
      rotateAirFrame(dH);
    }
    { const pk = playerStragK(); BOX_C.y = BOX_C0.y + pk * 240; BOX_C.z = BOX_C0.z + pk * 1500; }
    if (!downSeq) updatePlayerList(dt);
    updateFormation(dt);
    updateCpuGunners(dt);
    if (!downSeq) {
      viewRoll = lerp(viewRoll, (bomber ? bomber.list * 0.5 : 0) + turnRoll, 1 - Math.pow(0.3, dt));
      if (forcedRoll != null) viewRoll = forcedRoll; // test hook
      EYE.x = CAM.x; EYE.y = CAM.y; EYE.z = CAM.z;
    }
  }

  // the box turns through the air: in the box frame everything flying free (109s, wrecks,
  // tracers) swings the other way — same rotation world3d applies to clouds
  function rotateAirFrame(dH) {
    const c = Math.cos(-dH), sn = Math.sin(-dH);
    const rot = (o, kx, kz) => { const x = o[kx], z = o[kz]; o[kx] = x * c + z * sn; o[kz] = -x * sn + z * c; };
    for (const e of enemies) {
      rot(e, "x", "z"); rot(e, "hx", "hz"); if (e.ux != null) rot(e, "ux", "uz");
      if (e.alive) { e.vx = e.V * e.hx; e.vz = e.V * e.hz - VF; }
      else rot(e, "vx", "vz");
      if (e.trail) for (const t of e.trail) rot(t, "x", "z");
    }
    for (const t of tracers) { rot(t, "x", "z"); rot(t, "vx", "vz"); if (t.px != null) rot(t, "px", "pz"); }
    for (const b of bullets) { rot(b, "x", "z"); rot(b, "vx", "vz"); if (b.px != null) rot(b, "px", "pz"); } // 1.3.9: our rounds swing with the air too
    for (const c of chutes) { rot(c, "x", "z"); rot(c, "vx", "vz"); }
    for (const b of flakBursts) rot(b, "x", "z");
    for (const r of rockets) { rot(r, "x", "z"); rot(r, "vx", "vz"); }
    if (mission && mission.geo) { rot(mission.geo, "x", "z"); mission.geo.rot -= dH; } // the ground frame turns too
  }

  function outBoxCount() { // B-17s out of the box (destroyed, spiralling, 3 engines out, pilots out, fire, controls dead)
    let n = 0;
    for (const f of friendlies) if (!friendlyOk(f) || f.out) n++;
    n += Math.max(0, 18 - friendlies.length);
    if (!bomber || bomber.dead || bomber.out) n++;
    return n;
  }

  // ---- 1.5.3 TARGET RESULT: every bomb from the sticks is flown (same ballistics as world3d.dropBombs), landed on the town's real
  // geometry (houses, rail yard wagons/track, roundhouse stalls, key buildings) and the debrief verdict is read from what was actually hit.
  const TG_BG = 4.9, TG_R = 1.5; // gravity (world3d BOMB_G), lethal blast radius in town-local units (1 = ~15 m)
  function rectDist(r, u, v) {
    const dx = u - r[0], dz = v - r[1], c = Math.cos(r[4]), s = Math.sin(r[4]);
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    return Math.hypot(Math.max(Math.abs(lx) - r[2], 0), Math.max(Math.abs(lz) - r[3], 0));
  }
  function tgtInit(sticks) {
    const gm = World3D && World3D.townGeom, L = World3D && World3D.townLayout ? World3D.townLayout() : null;
    const t = { bombs: [], n: 0, landed: 0, onYard: 0, G: gm || null, L, hH: null, hW: null, hS: null, hT: null, kH: null };
    if (L) { t.hH = new Uint8Array(L.houses.length); t.hW = new Uint8Array(L.wagons.length); t.hS = new Uint8Array(L.stalls.length); t.hT = new Uint8Array(L.tracks.length); t.kH = new Uint8Array(L.keys.length); }
    for (const st of sticks) {
      for (let k = 0; k < st.n && t.bombs.length < 200; k++) t.bombs.push({ x0: st.x + (k % 2 ? 0.28 : -0.28), y0: st.y + (k % 3) * 0.12, z0: st.z + (st.own ? 0 : 0.3), t: -(st.delay + k * 0.12), own: !!st.own, done: false });
    }
    t.n = t.bombs.length; mission.tgt = t;
  }
  function tgtStep(dt) {
    const t = mission.tgt; if (!t || !t.G) return;
    for (const b of t.bombs) {
      if (b.done) continue;
      b.t += dt; if (b.t < 0) continue;
      if (b.y0 - 0.5 * TG_BG * b.t * b.t <= t.G.wy + 0.5 || b.t > 40) { b.done = true; tgtLand(t, b.x0, b.z0 - 0.55 * b.t * b.t - 0.02 * b.t * b.t * b.t, b.own); }
    }
  }
  function tgtLand(t, wx, wz, own) {
    const g = mission.geo, G = t.G, a = g.rot || 0, c = Math.cos(a), s = Math.sin(a), dx = wx - g.x, dz = wz - g.z;
    const u = ((dx * c - dz * s) / G.K - G.X) / G.S, v = ((dx * s + dz * c) / G.K - G.Z) / G.S;
    t.landed++; (t.pts || (t.pts = [])).push([+u.toFixed(1), +v.toFixed(1), own ? 1 : 0]);
    const L = t.L; if (!L) return;
    const ev = { u, v, houses: [], wagons: [], stalls: [], keys: [] };
    for (let i = 0; i < L.houses.length; i++) if (!t.hH[i] && rectDist(L.houses[i], u, v) < TG_R) { t.hH[i] = 1; ev.houses.push(i); }
    for (let i = 0; i < L.wagons.length; i++) if (!t.hW[i] && rectDist(L.wagons[i], u, v) < TG_R) { t.hW[i] = 1; ev.wagons.push(i); }
    for (let i = 0; i < L.stalls.length; i++) if (!t.hS[i] && rectDist(L.stalls[i], u, v) < TG_R) { t.hS[i] = 1; ev.stalls.push(i); }
    let onTrk = false;
    for (let i = 0; i < L.tracks.length; i++) if (rectDist(L.tracks[i], u, v) < TG_R) { onTrk = true; t.hT[i] = 1; }
    for (let i = 0; i < L.keys.length; i++) if (t.kH[i] < 2 && rectDist(L.keys[i], u, v) < TG_R) { t.kH[i]++; ev.keys.push([i, t.kH[i]]); }
    if (onTrk) t.onYard++;
    if (World3D && World3D.townStrike) World3D.townStrike(ev);
  }
  // the verdict: weighted share of the depot (wagons, track cuts, roundhouse stalls, key buildings) knocked out; houses are collateral
  function tgtResult() {
    const t = mission && mission.tgt, M = mission;
    if (!M || !M.bombsAway || !t) return { label: "NO BOMBS DROPPED", cls: "none", pct: 0, line: "No bombs reached the target &mdash; the formation never released." };
    // bombs still falling when the mission ends (shot down early): fly them on with the ground streaming aft
    if (t.G) { let guard = 0; while (t.bombs.some((b) => !b.done) && guard++ < 600) { M.geo.z -= VF * 0.1; tgtStep(0.1); } }
    const L = t.L;
    if (!L) { const f = Math.min(1, M.bombersDropped / MISSION_BOMBERS); return { label: f > 0.8 ? "HEAVILY DAMAGED" : f > 0.5 ? "LIGHTLY DAMAGED" : "UNDAMAGED", cls: "est", pct: Math.round(f * 100), line: M.bombersDropped + " ships dropped (estimate)" }; }
    let tot = 0, got = 0, hw = 0, ht = 0, hs = 0, hk = 0, hh = 0;
    for (let i = 0; i < L.wagons.length; i++) { tot += 0.25; if (t.hW[i]) { got += 0.25; hw++; } }
    for (let i = 0; i < L.tracks.length; i++) { tot += 0.3; if (t.hT[i]) { got += 0.3; ht++; } }
    for (let i = 0; i < L.stalls.length; i++) { tot += 1.5; if (t.hS[i]) { got += 1.5; hs++; } }
    for (let i = 0; i < L.keys.length; i++) { tot += 6; got += 3 * t.kH[i]; if (t.kH[i] >= 2) hk++; }
    for (let i = 0; i < L.houses.length; i++) if (t.hH[i]) hh++;
    const pct = Math.round(100 * got / tot);
    const label = pct >= TGT_T[0] ? "DESTROYED" : pct >= TGT_T[1] ? "HEAVILY DAMAGED" : pct >= TGT_T[2] ? "LIGHTLY DAMAGED" : "UNDAMAGED";
    return { label, cls: label === "DESTROYED" ? "d" : label === "HEAVILY DAMAGED" ? "h" : label === "LIGHTLY DAMAGED" ? "l" : "u", pct, bombs: t.n, landed: t.landed, wagons: hw, wagonsN: L.wagons.length, cuts: ht, cutsN: L.tracks.length, stalls: hs, stallsN: L.stalls.length, keysDown: hk, keysN: L.keys.length, houses: hh, housesN: L.houses.length,
      line: t.landed + " of " + t.n + " bombs landed &middot; depot <b>" + pct + "%</b> knocked out &mdash; " + hw + "/" + L.wagons.length + " wagons, " + ht + "/" + L.tracks.length + " track sections cut, " + hs + "/" + L.stalls.length + " roundhouse stalls, " + hk + "/" + L.keys.length + " key buildings &middot; " + hh + " houses lost" };
  }
  const TGT_T = [48, 26, 10]; // % of depot value: DESTROYED / HEAVILY / LIGHTLY

  function endMission(won) {
    state = "GAMEOVER";
    input.fire = false;
    callouts = [];
    calloutEl.textContent = "";
    calloutEl.classList.remove("urgent");
    const dropped = mission ? mission.bombersDropped : 0;
    const lost = mission ? mission.friendliesLost : 0;
    const eo = bomber ? engineOutCount(bomber.engines) : 0;
    const shot = !!(bomber && bomber.dead);
    goEyebrow.textContent = (won ? "TARGET HIT — MISSION SUCCESS" : "MISSION FAILED") + (shot ? " · YOU WERE SHOT DOWN" : mission && mission.playerOutT != null ? " · YOU STRAGGLED HOME" : "");
    goTitle.textContent = shot ? "SHOT DOWN — YOU BAILED OUT" : won ? "BOMBS ON TARGET" : "BOX BROKEN";
    const outN = outBoxCount(), luft = outN >= FIGHTERS_OUT_WIN;
    const kY = (mission && mission.kYou) || kills, kG = (mission && mission.kGun) || 0, kM = (mission && mission.kP51) || 0;
    const tr = tgtResult();
    if (mission) mission.tgtRes = tr;
    const trCol = { d: "#ff5a3a", h: "#ff9a3a", l: "#e8d24a", u: "#9fb0a8", none: "#9fb0a8", est: "#e8d24a" }[tr.cls];
    goStats.innerHTML =
      '<div style="margin:2px 0 8px;padding:6px 8px;border-left:4px solid ' + trCol + ';background:rgba(255,255,255,0.06)"><span style="opacity:.8;letter-spacing:.12em;font-size:.8em">TARGET RESULT</span><br><b style="font-size:1.45em;color:' + trCol + '">' + tr.label + '</b><br><span style="font-size:.85em;opacity:.9">' + tr.line + '</span></div>' +
      (won ? "&ge;" + MISSION_WIN_DROPS + " Fortresses bomb-capable at release &mdash; <b>WIN</b>" : "&lt;" + MISSION_WIN_DROPS + " Fortresses bomb-capable at release &mdash; <b>FAIL</b>") +
      "<br>Dropped <b>" + dropped + "</b> / " + MISSION_BOMBERS +
      " &middot; in formation at release <b>" + (MISSION_BOMBERS - outN) + "</b> (&ge;12 = bomber rule B) &middot; out of the box <b>" + outN + "</b>" + (luft ? " &mdash; <b>Luftwaffe victory</b> (" + FIGHTERS_OUT_WIN + "+ out)" : " (Luftwaffe needs " + FIGHTERS_OUT_WIN + ")") +
      "<br>B-17s lost <b>" + lost + "</b> &middot; left the box (counted as German kills) " + Math.max(0, outN - lost) +
      "<br>German fighters down <b>" + (kills + cpuKills) + "</b> / " + MISSION_FIGHTERS + " &mdash; you " + kY + ", gunners " + kG + ", Mustangs " + kM +
      (shot ? "<br><b>Your Fortress was shot down</b> at " + formatMissionClock(downSeq ? downSeq.missionT : 0) + " into the mission" + (downSeq && downSeq.cause === "own" ? " &mdash; by your own guns" : downSeq && downSeq.cause === "flak" ? " by flak (88 mm)" : " by Bf 109s") + (downSeq && downSeq.bombed ? " (after bombs away)" : " (before the drop &mdash; your bombs didn't count)") + ". You bailed out; the box flew on without you."
        : " &middot; Your ship " + Math.round(bomber ? bomber.health : 0) + "% &middot; " + (4 - eo) + "/4 engines") +
      (mission && mission.playerOutT != null ? "<br><b>STRAGGLER</b> &mdash; you fell out of formation at " + formatMissionClock(mission.playerOutT) + " (" + (LEAVE_TXT[mission.playerOutWhy] || mission.playerOutWhy || "damage") + ") &middot; " + (shot ? "<b>" + (downSeq && downSeq.cause === "flak" ? "SHOT DOWN by flak" : "SHOT DOWN &mdash; BAILED OUT") + "</b>" : "<b>SURVIVED AS A STRAGGLER</b>") + " &middot; " + (mission.strag190Passes || 0) + " Fw 190 and " + Math.max(0, (mission.stragPasses || 0) - (mission.strag190Passes || 0)) + " Bf 109 passes on you after that" : "") +
      " &middot; Score <b>" + score + "</b>" +
      (mission && (mission.friendlyHits || mission.friendlyHitsCpu) ? "<br>Friendly fire: your hits <b>" + mission.friendlyHits + "</b> &middot; gunners' strays " + mission.friendlyHitsCpu + (mission.friendlyFFLost ? " &middot; FF losses " + mission.friendlyFFLost : "") : "") +
      (mission && (mission.p51HitYou || mission.p51HitGun || mission.p51Lost) ? "<br>Mustangs: hit by you <b>" + (mission.p51HitYou || 0) + "</b> &middot; hit by gunners <b>" + (mission.p51HitGun || 0) + "</b> &middot; lost <b>" + (mission.p51Lost || 0) + "</b> (friendly fire " + ((mission.p51LostYou || 0) + (mission.p51LostGun || 0)) + ": you " + (mission.p51LostYou || 0) + ", gunners " + (mission.p51LostGun || 0) + "; Germans " + (mission.p51LostGer || 0) + ")" + (mission.p51HitYou ? " &mdash; <b>score penalty</b> for shooting Mustangs" : "") : "") +
      (mission && mission.ownHits ? "<br>Rounds into your own ship: <b>" + mission.ownHits + "</b>" : "");
    gameoverEl.classList.remove("hidden"); { const pn = gameoverEl.querySelector(".panel"); if (pn) pn.scrollTop = 0; }
    updateHud();
  }

  function formatMissionClock(sec) {
    const s = Math.max(0, Math.ceil(sec));
    const m = (s / 60) | 0;
    const r = s % 60;
    return m + ":" + (r < 10 ? "0" : "") + r;
  }


  let W = 1280, H = 720, DPR = 1;
  let state = "TITLE";
  let lastT = 0;
  let elapsed = 0;

  const input = {
    pointerId: null,
    dragging: false,
    lastX: 0, lastY: 0,
    stickActive: false,
    stickId: null,
    stickX: 0, stickY: 0,
    stickVX: 0, stickVY: 0,
    fire: false,
    fireId: null,
    keys: Object.create(null),
    swipeAimX: 0, swipeAimY: 0,
  };

  // 1.4.0: END MISSION (under the canopy)
  const endBtn = document.getElementById("endMissionBtn");
  if (endBtn) endBtn.addEventListener("click", (ev) => { ev.stopPropagation(); if (downSeq && !downSeq.finished) finishDownSeq(); });
  const gunner = {
    yaw: 0.15,
    pitch: 0.08,
    yawV: 0,
    pitchV: 0,
    shake: 0,
    recoil: 0,
  };

  const guns = {
    heat: 0,
    overheated: false,
    cooldown: 0,
    side: 0,
    rounds: 0,
    muzzle: 0,
    recoilLR: [0, 0], // per-barrel recoil (left, right)
    flashLR: [0, 0],  // per-barrel muzzle flash
  };
  let cpuKills = 0;

  let bomber = null;
  let enemies = [];
  let bullets = [];
  let particles = [];
  let tracers = [];
  let flak = [];
  let clouds = [];
  let callouts = [];
  let wave = 1;
  let score = 0;
  let kills = 0;
  let spawnQueue = 0;
  let spawnTimer = 0;
  let wavePause = 0;
  let combo = 0;
  let comboTimer = 0;
  let timeAlive = 0;
  let hitsLanded = 0;
  const leadDebug = { hitscanOk: 0, hitscanReject: 0, ballOk: 0, ballReject: 0, sepSum: 0, sepN: 0 };
  let rumble = 0;
  let onTarget = false;
  let hitMarks = [];
  let brass = [];
  let muzzleSmoke = [];
  // Cycle 136 MotA: lingering sky contrails + friendly box + wingman pairs
  let skyTrails = [];
  let friendlies = [];
  let pendingPair = null;
  let intercomCd = 0;
  const CREW_NAMES = ["CLEVEN", "BUCK", "EAGAN", "BUBBLES", "CURLY", "KENNY"];
  let grainCanvas = null;
  let grainCtx = null;
  let grainTick = 0;
  let audioCtx = null;
  let windGain = null;
  let engineGain = null;
  const assets = {
    sky: null, metal: null, rust: null, olive: null, dirt: null, ground: null,
    fighters: null, clouds: [null, null, null, null], ready: false,
  };

  function loadAssets() {
    const names = [
      ["sky", "assets/sky_hdri_4k.jpg"],
      ["metal", "assets/metal_plate_diff_1k.jpg"],
      ["rust", "assets/rusty_metal_diff_1k.jpg"],
      ["olive", "assets/olive_metal_512.jpg"],
      ["dirt", "assets/plexi_dirt.png"],
      ["ground", "assets/ground_512.jpg"],
      ["fighters", "assets/fighters_atlas.png"],
    ];
    for (let i = 0; i < 4; i++) names.push(["cloud" + i, "assets/cloud_" + i + ".png"]);
    let left = names.length;
    names.forEach(([k, srcPath]) => {
      const img = new Image();
      img.onload = () => {
        if (k.startsWith("cloud")) assets.clouds[+k.slice(5)] = img;
        else assets[k] = img;
        if (--left === 0) assets.ready = true;
      };
      img.onerror = () => { if (--left === 0) assets.ready = true; };
      img.src = srcPath;
    });
  }
  loadAssets();


  // ----- Three.js world (classic bundle: equirect sky + GLTF turret/fighters) -----
  const worldCanvas = document.getElementById("world");
  let World3D = null;

  function bindWorld3D(api) {
    if (!api) return;
    World3D = {
      get ready() { return !!api.ready; },
      get modelsReady() { return !!api.modelsReady; },
      get muzzles() { return api.muzzles; },
      resize() { api.resize(); },
      sync(enemiesArr, gunnerState, cloudsArr) {
        api.sync(enemiesArr, gunnerState, {
          muzzle: guns.muzzle,
          friendlies,
          roll: viewRoll,
          fov: FOV * 180 / Math.PI,
          recoilLR: guns.recoilLR,
          flashLR: guns.flashLR,
          heat: guns.heat,
          own: bomber ? { engines: bomber.engines, health: bomber.health, tail: bomber.tail, holes: bomber.holes } : null,
          heading: mission ? (mission.heading || 0) : 0,
          geo: mission && mission.geo ? mission.geo : { x: 0, z: 0, rot: 0 },
          odo: mission ? (mission.odo || 0) : 0,
          missionT: mission ? mission.t - GEO_LEAD : 0, // world3d's town/bomb-stream clock is keyed to the 2:00 layout
          post: mission ? (mission.post || 0) : 0,
          bombsAway: !!(mission && mission.bombsAway),
          dropped: mission ? mission.bombersDropped : 0,
          flakOn: false, // 1.3.8: flak is simulated here (damage) and drawn from flakBursts
          flakBursts,
          rockets,
          fall: downSeq ? { phase: downSeq.phase === "done" ? "chute" : downSeq.phase, eye: { x: EYE.x, y: EYE.y, z: EYE.z }, ship: downSeq.ship, sway: downSeq.sway || 0, chuteT: downSeq.chute ? downSeq.chute.t : 0 } : null,
          chutes,
        });
      },
      render() { api.render(); },
      setTracers: api.setTracers ? (b, n) => api.setTracers(b, n) : null,
      dropBombs: api.dropBombs ? (l) => api.dropBombs(l) : null,
      townGeom: api.townGeom || null, townLayout: api.townLayout ? () => api.townLayout() : null, townStrike: api.townStrike ? (e) => api.townStrike(e) : null, townReset: api.townReset ? () => api.townReset() : null, // 1.5.3: real bomb landings on the town
      rayShip: api.rayShip ? (w, a, b, c, d, e, f, p) => api.rayShip(w, a, b, c, d, e, f, p) : null,
      addHole: api.addHole ? (w, h, sz) => api.addHole(w, h, sz) : null,
      addTear: api.addTear ? (w, h, sz) => api.addTear(w, h, sz) : null,
      clearDamage: api.clearDamage ? () => api.clearDamage() : null,
      rayFighter: api.rayFighter ? (e, a, b, c, d, f, g, t) => api.rayFighter(e, a, b, c, d, f, g, t) : null,
      addFighterHole: api.addFighterHole ? (e, h, sz) => api.addFighterHole(e, h, sz) : null,
      fighterBoundR: api.fighterBoundR ? (k) => api.fighterBoundR(k) : null,
      fighterDecalInfo: api.fighterDecalInfo ? (id) => api.fighterDecalInfo(id) : null,
      applySkyTexture() {
        if (assets.sky) api.applySkyTexture(assets.sky);
      },
      applyCloudTextures() {},
    };
    if (assets.sky) World3D.applySkyTexture();
    api.loading && api.loading.then(() => {
      if (assets.sky) World3D.applySkyTexture();
    });
  }

  if (window.__FG_WORLD) bindWorld3D(window.__FG_WORLD);
  else window.addEventListener("fg-world-ready", () => bindWorld3D(window.__FG_WORLD));

  const _assetPoll = setInterval(() => {
    if (assets.ready && World3D) {
      World3D.applySkyTexture();
      clearInterval(_assetPoll);
    }
  }, 200);



  function ensureAudio() {
    if (window.FGAudio) window.FGAudio.unlock(); // 1.3.7: procedural sound design (audio.js)
    if (audioCtx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = new AC();
    // low engine/wind bed
    const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.4;
    const srcN = audioCtx.createBufferSource();
    srcN.buffer = buf; srcN.loop = true;
    const bp = audioCtx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 90; bp.Q.value = 0.7;
    windGain = audioCtx.createGain(); windGain.gain.value = 0.0;
    srcN.connect(bp); bp.connect(windGain); if (!window.FGAudio) windGain.connect(audioCtx.destination);
    srcN.start();
    engineGain = windGain;
  }

  function setBedAudio(level) {
    if (!windGain) return;
    windGain.gain.setTargetAtTime(0.04 + level * 0.08, audioCtx.currentTime, 0.2);
  }

  function sfxFifty(side) {
    if (window.FGAudio) { window.FGAudio.ownShot(side); return; }
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime;
    // bass thump
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "sine"; o.frequency.setValueAtTime(78, t0);
    o.frequency.exponentialRampToValueAtTime(28, t0 + 0.11);
    g.gain.setValueAtTime(0.95, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.14);
    o.connect(g); g.connect(audioCtx.destination); o.start(t0); o.stop(t0 + 0.15);
    // body thump 2
    const o2 = audioCtx.createOscillator();
    const g2 = audioCtx.createGain();
    o2.type = "triangle"; o2.frequency.setValueAtTime(110, t0);
    o2.frequency.exponentialRampToValueAtTime(40, t0 + 0.07);
    g2.gain.setValueAtTime(0.38, t0);
    g2.gain.exponentialRampToValueAtTime(0.001, t0 + 0.08);
    o2.connect(g2); g2.connect(audioCtx.destination); o2.start(t0); o2.stop(t0 + 0.09);
    // metallic crack noise
    const len = Math.floor(audioCtx.sampleRate * 0.06);
    const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const n = audioCtx.createBufferSource(); n.buffer = buf;
    const hp = audioCtx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 1400;
    const ng = audioCtx.createGain(); ng.gain.setValueAtTime(0.48, t0); ng.gain.exponentialRampToValueAtTime(0.001, t0 + 0.055);
    n.connect(hp); hp.connect(ng); ng.connect(audioCtx.destination); n.start(t0);
  }

  function sfxHit() {
    if (window.FGAudio) { window.FGAudio.hitEnemy(); return; }
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "triangle"; o.frequency.value = 310;
    g.gain.setValueAtTime(0.22, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.07);
    o.connect(g); g.connect(audioCtx.destination); o.start(t0); o.stop(t0 + 0.09);
  }

  function sfxFlak() {
    if (window.FGAudio) return; // world3d flak bursts trigger crumps
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime;
    const len = Math.floor(audioCtx.sampleRate * 0.25);
    const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.5);
    const n = audioCtx.createBufferSource(); n.buffer = buf;
    const lp = audioCtx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 400;
    const g = audioCtx.createGain(); g.gain.value = 0.18;
    n.connect(lp); lp.connect(g); g.connect(audioCtx.destination); n.start(t0);
  }

  function sfxDamage() {
    if (window.FGAudio) return; // routed to FGAudio at the call sites
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "sawtooth"; o.frequency.setValueAtTime(60, t0); o.frequency.linearRampToValueAtTime(40, t0 + 0.2);
    g.gain.setValueAtTime(0.2, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.22);
    o.connect(g); g.connect(audioCtx.destination); o.start(t0); o.stop(t0 + 0.23);
  }

  /** Urgent intercom: triple-beep + radio click + voice-ish (Cycle 137 MotA). */
  function sfxIntercom() { // 1.5.4: the radio squelch/burble now lives in FGAudio (noise-based, on the shared graph) — no more square-wave beeps
    if (downSeq) return;
    if (window.FGAudio && window.FGAudio.intercom) window.FGAudio.intercom();
  }


  function rand(a, b) { return a + Math.random() * (b - a); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function angNorm(a) {
    while (a > Math.PI) a -= TAU;
    while (a < -Math.PI) a += TAU;
    return a;
  }

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, (H < 420 || particles.length > 80) ? 1.22 : 1.5);
    W = Math.max(320, window.innerWidth);
    H = Math.max(240, window.innerHeight);
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    FOV = computeFov(W, H);
    if (World3D) World3D.resize();
  }
  window.addEventListener("resize", resize);
  resize();

  function resetRun() {
    gunner.yaw = 0.12;
    gunner.pitch = 0.10;
    gunner.yawV = 0;
    gunner.pitchV = 0;
    gunner.shake = 0;
    gunner.recoil = 0;
    guns.heat = 0;
    guns.overheated = false;
    guns.cooldown = 0;
    guns.side = 0;
    guns.sideRounds = [0, 0];
    guns.rounds = 0;
    guns.muzzle = 0;
    guns.recoilLR = [0, 0];
    guns.flashLR = [0, 0];
    cpuKills = 0;
    downSeq = null; chutes = []; flakBursts = []; rockets = []; stragNow = null; BOX_C.x = BOX_C0.x; BOX_C.y = BOX_C0.y; BOX_C.z = BOX_C0.z;
    if (World3D && World3D.clearDamage) World3D.clearDamage(); // 1.3.8: holes / decals from the last mission EYE.x = CAM.x; EYE.y = CAM.y; EYE.z = CAM.z; viewRoll = 0;
    if (window.FGAudio && window.FGAudio.reset) window.FGAudio.reset();
    injuryReset();
    setDownHud(false);
    bomber = {
      health: 100,
      flash: 0,
      list: 0,
      engines: [
        { x: -36, y: 3.4, z: 3.2, fire: 0, out: false },
        { x: -18, y: 3.6, z: 3.6, fire: 0, out: false },
        { x: 18, y: 3.6, z: 3.6, fire: 0, out: false },
        { x: 36, y: 3.4, z: 3.2, fire: 0, out: false },
      ],
      sd: FC.newShip(), crewHp: 100, wounded: false, out: false, // 1.5.0: per-part damage state
      tail: { fire: 0 },   // 1.3.5: self-inflicted tail damage (smoke/fire at the fin)
      holes: [],           // 1.3.5: own-ship bullet holes (own frame)
      ownHits: 0,
    };
    initMissionState();
    enemies = [];
    bullets = [];
    particles = [];
    fx154.kicks.length = 0; fx154.cabin.length = 0; fx154.vig = 0; fx154.blur = 0; fx154.accum = 0; gunner.kx = 0; gunner.ky = 0; if (worldCanvas) { worldCanvas.style.filter = ""; fx154.blurPx = -1; }
    tracers = [];
    flak = [];
    callouts = [];
    skyTrails = [];
    pendingPair = null;
    intercomCd = 0;
    muzzleSmoke = [];
    wave = 1;
    score = 0;
    kills = 0;
    combo = 0;
    comboTimer = 0;
    spawnQueue = 0;
    spawnTimer = 0;
    wavePause = MISSION_MODE ? 0.8 : 1.4;
    timeAlive = 0;
    hitsLanded = 0;
    rumble = 0;
    seedClouds();
    seedFlak();
    seedFriendlies();
    updateHud();
  }

  function seedClouds() {
    clouds = [];
    for (let i = 0; i < 26; i++) {
      clouds.push({
        x: rand(-900, 900),
        y: rand(40, 220),
        z: rand(-700, 900),
        s: rand(70, 200),
        a: rand(0.28, 0.7),
        layer: Math.random() < 0.35 ? 1 : 0,
        sprite: (Math.random() * 4) | 0,
      });
    }
  }
  function seedFlak() {
    flak = [];
    for (let i = 0; i < 16; i++) {
      flak.push({
        x: rand(-450, 450), y: rand(20, 180), z: rand(80, 750),
        r: rand(8, 22), life: rand(0, 1), age: rand(0, 4),
      });
    }
  }

  /** 19-ship combat box (player at origin = ship 0; 18 friendlies drawn). */
  function seedFriendlies() {
    friendlies = [];
    const slots = combatBoxSlots();
    const names = ["CLEVEN", "BUCK", "BUBBLES", "CURLY", "KENNY",
      "EAGAN", "ROSIE", "HELLS ANGELS", "MEMPHIS BELLE", "YANKEE DOODLE", "FORTUNA", "SHOO SHOO BABY",
      "SHADY LADY", "NINE-O-NINE", "SKY WOLF", "PAPPY", "WABASH CANNONBALL", "TEXAS RAIDERS"]; // 1.4.0: real 8th AF ship names (no more "OI VEY")
    for (let i = 0; i < slots.length; i++) {
      const sl = slots[i];
      const hx = sl.x, hy = BOMBER_AIM_Y + sl.y, hz = sl.z;
      friendlies.push({
        slot: i, sq: sl.sq, el: sl.el,
        name: names[i % names.length],
        x: hx, y: hy, z: hz,
        homeX: hx, homeY: hy, homeZ: hz,
        yaw: 0, bank: 0, listTarget: 0,
        health: 100, alive: true, spiraling: false, spiralT: 0, flash: 0,
        vx: 0, vy: 0, vz: 0,
        engines: makeEngineSet(), sd: FC.newShip(), out: false,
      });
    }
  }


  function pickCrew() {
    return CREW_NAMES[(Math.random() * CREW_NAMES.length) | 0];
  }

  /** Mix clock + named stakes (MotA personalized intercom) — Cycle 137 variety. */
  function intercomBanditCall(x, z, style) {
    const clk = clockLabel(x, z);
    const low = style === "lowclimb";
    const high = style === "highside";
    const crew = pickCrew();
    const r = Math.random();
    let text;
    if (r < 0.16) text = "THEY'RE GOING FOR " + crew + "!";
    else if (r < 0.28) text = "BREAK BREAK — ON " + crew + "!";
    else if (r < 0.40) text = "MORE FIGHTERS " + clk + (low ? " LOW!" : high ? " HIGH!" : " LEVEL!");
    else if (r < 0.50) text = "WATCH THE BOX — ON " + crew + "!";
    else if (r < 0.58) text = crew + " IS UNDER ATTACK!";
    else if (low) text = "BANDITS " + clk + " LOW — CLIMBING!";
    else if (r < 0.68) text = "FIGHTERS AT " + clk + "!";
    else if (r < 0.78) text = "BANDITS IN THE BOX — " + clk + "!";
    else if (r < 0.88) text = "LOOK OUT " + crew + " — " + clk + "!";
    else text = "FIGHTERS " + clk + (high ? " HIGH!" : Math.random() < 0.5 ? " LEVEL!" : "!");
    pushCallout(text, 2.15);
    sfxIntercom();
    intercomCd = rand(1.1, 2.0);
  }

  function depositTrail(e) {
    if (MISSION_MODE) return; // 1.3.1: no persistent 2D sky ribbons (were the white bars)
    if (!e || !e.trail || e.trail.length < 4) return;
    const pts = e.trail.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    skyTrails.push({
      pts,
      life: rand(9.0, 14.5),
      maxLife: 14.5,
      width: rand(4.0, 7.2),
    });
    if (skyTrails.length > 42) skyTrails.splice(0, skyTrails.length - 42);
  }

  function clockLabel(x, z) {
    // 1.3.2: world +X is the turret's LEFT (Three.js camera right = -X) → mirror for clock calls
    const ang = Math.atan2(-x, z);
    let h = Math.round(((ang / TAU) * 12 + 12)) % 12;
    if (h === 0) h = 12;
    return h + " O'CLOCK";
  }

  function mphRel(groundMph, closingBoost) {
    // Bomber-relative speed magnitude for a fighter opposing/overtaking the Fortress.
    // closingBoost≈1 for head-on component of bomber TAS added into relative speed.
    return groundMph * MPH_TO_UPS + B17_UPS * (closingBoost || 0);
  }

  function setVelToward(e, tx, ty, tz, speed) {
    const dx = tx - e.x, dy = ty - e.y, dz = tz - e.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    e.vx = (dx / len) * speed;
    e.vy = (dy / len) * speed;
    e.vz = (dz / len) * speed;
    e.speed = speed;
  }

  function attitudeFromVel(e) {
    const sp = Math.hypot(e.vx, e.vy, e.vz) || 1;
    e.yawAtt = Math.atan2(e.vx, e.vz);
    e.pitchAtt = Math.asin(clamp(e.vy / sp, -0.99, 0.99));
  }

  function pickAttackStyle() {
    const r = Math.random();
    // Cycle 137 MotA: more vertical low-climbs (~30%)
    if (r < 0.26) return "frontal";
    if (r < 0.46) return "beam";
    if (r < 0.70) return "highside";
    return "lowclimb";
  }

  /** opts: { type, passSide, style, pairId, pairRole, muteCall, offset } */
  function spawnEnemy(forced, opts) {
    opts = opts || {};
    const types = MISSION_MODE ? ["109"] : (wave < 3 ? ["109", "109", "190"] : ["109", "190", "190", "110"]);
    const type = opts.type || forced || types[(Math.random() * types.length) | 0];
    const style = opts.style || pickAttackStyle();
    const low = style === "lowclimb";
    // Cycle 135: speck perch + hot boom-and-zoom. Cycle 136: pairs + lowclimb from below.
    const side = opts.passSide != null ? opts.passSide : (Math.random() < 0.5 ? -1 : 1);
    let sx, sy, sz;
    if (low) {
      // 11-low / 6-low: steep climb from below cloud deck into the box
      const sixLow = Math.random() < 0.45;
      sx = sixLow ? side * rand(8, 28) : side * rand(35, 78);
      sy = BOMBER_AIM_Y - rand(42, 72);
      sz = rand(100, 145) + enemies.length * rand(6, 14);
    } else {
      sx = side * rand(48, 95);
      sy = BOMBER_AIM_Y + rand(32, 62);
      sz = rand(105, 145) + enemies.length * rand(10, 18);
    }
    if (opts.offset) {
      sx += opts.offset.x || 0;
      sy += opts.offset.y || 0;
      sz += opts.offset.z || 0;
    }
    if (!forced && !opts.pairRole && wave === 1 && enemies.length === 0 && !low) {
      sx = side * rand(55, 88); sy = BOMBER_AIM_Y + rand(36, 55); sz = rand(112, 138);
    }
    // Stagger away from live / dying corpses so a kill doesn't pop a twin in your face
    for (let tries = 0; tries < 10; tries++) {
      let clash = false;
      for (const o of enemies) {
        if (Math.hypot(o.x - sx, o.y - sy, o.z - sz) < (opts.pairRole ? 22 : 48)) { clash = true; break; }
      }
      if (!clash) break;
      // Keep passSide lane for wingman pairs (MotA same-lane boom-zoom)
      if (low) {
        sx = side * (Math.abs(sx) + 8 + tries * 6);
        sy = BOMBER_AIM_Y - rand(38, 70);
        sz = rand(95, 150) + enemies.length * rand(8, 16) + tries * 8;
      } else {
        sx = side * (Math.abs(sx) + 10 + tries * 8);
        sy = BOMBER_AIM_Y + rand(26, 60);
        sz = (sz || 120) + 12 + tries * 10;
      }
    }
    const hp = MISSION_MODE ? TUNE.fighterHp : (type === "110" ? 5 : type === "190" ? 4 : 3);
    const groundMph = type === "109"
      ? (MISSION_MODE ? BF109_FLAT_MAX_MPH : 360)
      : type === "190" ? 340 : 310;
    const relSpd = mphRel(groundMph + 110, low ? 11.2 : 10.4);
    const e = {
      type, x: sx, y: sy, z: sz, hp, maxHp: hp,
      speed: relSpd,
      vx: 0, vy: 0, vz: 0,
      bank: side * (low ? 0.55 : 0.85), roll: 0,
      yawAtt: Math.PI, pitchAtt: low ? 0.72 : -0.62,
      phase: "dive",
      fireCd: rand(0.35, 0.85),
      weave: rand(0, TAU),
      weaveAmp: type === "109" ? 24 : 18,
      alive: true,
      flash: 0,
      smoke: 0.42,
      passSide: side,
      nextStyle: style,
      phaseT: 0,
      energy: groundMph + 55,
      trail: [],
      pendingDmg: null,
      pairId: opts.pairId || null,
      pairRole: opts.pairRole || null,
      id: Math.random().toString(36).slice(2, 8),
    };
    if (low) {
      setVelToward(e, -e.passSide * 28, BOMBER_AIM_Y + 10, 8, relSpd);
    } else {
      setVelToward(e, -e.passSide * 70, BOMBER_AIM_Y - 4, 6, relSpd);
    }
    attitudeFromVel(e);
    enemies.push(e);
    if (!opts.muteCall && intercomCd <= 0) {
      intercomBanditCall(e.x, e.z, style);
    }
    return e;
  }

  /** Boom-zoom wingman pair — same lane, stagger 0.3–0.8s (MotA). */
  function enqueuePair() {
    const types = MISSION_MODE ? ["109"] : (wave < 3 ? ["109", "109", "190"] : ["109", "190", "190", "110"]);
    const type = types[(Math.random() * types.length) | 0];
    const side = Math.random() < 0.5 ? -1 : 1;
    const style = pickAttackStyle();
    const pairId = Math.random().toString(36).slice(2, 7);
    spawnEnemy(type, { passSide: side, style, pairId, pairRole: "lead", type });
    pendingPair = {
      t: rand(0.22, 0.52),
      passSide: side,
      style,
      type,
      pairId,
      offset: {
        x: side * rand(8, 18),
        y: lowOffsetY(style),
        z: rand(6, 14),
      },
    };
  }

  function lowOffsetY(style) {
    return style === "lowclimb" ? rand(-6, 4) : rand(-4, 10);
  }

  function startWave() {
    if (MISSION_MODE) {
      // Mission uses updateMission drip-spawn — kick first elements
      spawnQueue = 0;
      spawnTimer = 99;
      pendingPair = null;
      wavePause = 999;
      if (mission && mission.fightersSpawned === 0) {
        pushCallout("BANDITS INBOUND — 109s 12 O'CLOCK HIGH · 190s 5 AND 7 O'CLOCK", 2.0);
      }
      return;
    }
    const n = 2 + wave + (wave > 3 ? wave - 2 : 0);
    spawnQueue = n + (n % 2);
    spawnTimer = 0.15;
    pendingPair = null;
    pushCallout("WAVE " + wave, 0.9);
  }

  // 1.4.0: callouts QUEUE — a new line waits its turn instead of overwriting the one on screen. Important lines
  // jump ahead of queued chatter (never the one showing); stale chatter is dropped; each line gets ≥0.9 s.
  const CALL_URGENT = /FIGHTERS|INCOMING|CRITICAL|O'CLOCK|CLEVEN|GOING FOR|BANDITS|WATCH THE BOX|LEVEL|CLIMBING|MORE FIGHTERS|BREAK BREAK|UNDER ATTACK|LOOK OUT|IN THE BOX/;
  function showCallout(c) {
    calloutEl.textContent = c ? c.text : "";
    calloutEl.classList.toggle("urgent", !!(c && CALL_URGENT.test(c.text)));
  }
  const DOWN_CALLS = /SHE'S GOING DOWN|BAIL OUT|YOU'RE OUT|CANOPY OPEN|BREAKING UP/;
  function pushCallout(text, life, important) {
    if (downSeq && !DOWN_CALLS.test(text)) return; // 1.4.1: once we're going down, only our own story is called
    if (callouts.some((c) => c.text === text)) return;
    life = Math.max(0.9, Math.min(life || 1, important ? 2.0 : 1.3));
    const c = { text, life, important: !!important, age: 0 };
    if (!callouts.length) { callouts.push(c); showCallout(c); return; }
    if (important) {
      let k = 1; while (k < callouts.length && callouts[k].important) k++;
      callouts.splice(k, 0, c);
      // the line on screen yields sooner when an important one is waiting
      if (!callouts[0].important) callouts[0].life = Math.min(callouts[0].life, 0.6);
    } else {
      if (callouts.length >= 3) return; // chatter doesn't pile up
      callouts.push(c);
    }
    while (callouts.length > 5) { const j = callouts.map((q) => q.important).lastIndexOf(false); callouts.splice(j > 0 ? j : callouts.length - 1, 1); }
  }

  const hudTick = { b: -9, f: -9 };
  function updateHud() {
    scoreEl.textContent = String(score);
    killsEl.textContent = String(kills);
    if (waveEl && waveEl.parentElement) waveEl.parentElement.style.opacity = "1";
    if (killsEl && killsEl.parentElement) killsEl.parentElement.style.opacity = "1";
    const clockEl = document.getElementById("missionclock");
    const boxEl = document.getElementById("boxcount");
    const engEl = document.getElementById("engstatus");
    if (MISSION_MODE && mission) {
      const rtb = mission.bombsAway;
      if (waveEl) waveEl.textContent = rtb ? formatMissionClock(Math.max(0, MISSION_EVAL_DELAY - mission.post)) : formatMissionClock(mission.timeLeft);
      const tl = document.getElementById("tgtlabel");
      if (tl) { const w = rtb ? "RTB" : "TGT"; if (tl.textContent !== w) { tl.textContent = w; tl.classList.toggle("rtb", rtb); } }
      // 1.3.5 scorecard: still flying / total, ticks down (orange flash) as planes go down
      const nb = countBombCapable(), nf = MISSION_FIGHTERS - mission.fightersKilled;
      if (boxEl) {
        const t = nb + "/19";
        if (boxEl.textContent !== t) { boxEl.textContent = t; boxEl.classList.add("tick"); hudTick.b = elapsed; }
        else if (elapsed - hudTick.b > 1.2) boxEl.classList.remove("tick");
      }
      const bdEl = document.getElementById("bandits");
      if (bdEl) {
        const t = nf + "/" + MISSION_FIGHTERS;
        if (bdEl.textContent !== t) { bdEl.textContent = t; bdEl.classList.add("tick"); hudTick.f = elapsed; }
        else if (elapsed - hudTick.f > 1.2) bdEl.classList.remove("tick");
      }
      if (clockEl) clockEl.textContent = formatMissionClock(mission.timeLeft);
      if (engEl && bomber) {
        const outs = engineOutCount(bomber.engines);
        engEl.textContent = (4 - outs) + "/4";
        engEl.style.color = outs === 0 ? "#b8e090" : outs === 1 ? "#f0c060" : "#ff7050";
      }
      const bayEl = document.getElementById("baystatus");
      if (bayEl) {
        const txt = mission.bombsAway ? "BOMBS AWAY" : mission.doorsOpen ? "BAY OPEN" : "";
        if (bayEl.textContent !== txt) bayEl.textContent = txt;
      }
    } else {
      if (waveEl) waveEl.textContent = String(wave);
    }
    if (bomber) {
      const h = clamp(bomber.health, 1, 100);
      healthFill.style.width = h + "%";
      healthFill.style.background = h > 55
        ? "linear-gradient(90deg,#7bc45a,#e8f080)"
        : h > 25
          ? "linear-gradient(90deg,#e09020,#f0d050)"
          : "linear-gradient(90deg,#c02828,#ff6030)";
    }
    const ht = guns.heat * 100;
    heatFill.style.width = ht.toFixed(1) + "%";
    heatFill.style.background = guns.overheated
      ? "linear-gradient(90deg,#8a1c14,#e0402c)"
      : ht > 75
        ? "linear-gradient(90deg,#d07020,#e04a28)"
        : ht > 45
          ? "linear-gradient(90deg,#c8a030,#e08a2a)"
          : "linear-gradient(90deg,#7fa850,#c8c060)";
    const hl = document.getElementById("heatlabel");
    if (hl) {
      const want = guns.overheated ? "GUNS · JAMMED" : "GUNS";
      if (hl.textContent !== want) hl.textContent = want;
      hl.classList.toggle("jam", guns.overheated);
    }
    if (heatFill.parentElement) {
      heatFill.parentElement.style.boxShadow = guns.overheated
        ? "0 0 10px rgba(220,40,30,0.55)"
        : ht > 70 ? "0 0 6px rgba(230,120,40,0.35)" : "none";
    }
  }

  // ----- 3D -----
  function lookBasis() {
    const cy = Math.cos(gunner.yaw), sy = Math.sin(gunner.yaw);
    const cp = Math.cos(gunner.pitch), sp = Math.sin(gunner.pitch);
    let fx = sy * cp, fy = sp, fz = cy * cp;
    // Three.js camera.lookAt(+Z) has local +X = world -X. Match that so
    // 2D project / chevrons / hitscan line up with the WebGL view.
    let rx = -cy, ry = 0, rz = sy;
    let ux = -sy * sp, uy = cp, uz = -cy * sp;
    if (viewRoll) {
      // 1.3.3: the AIRFRAME rolls (list/turn) about its own longitudinal axis (world +Z),
      // carrying the turret with it — same rotation as world3d (camera + own B-17).
      const A = -viewRoll, c = Math.cos(A), sn = Math.sin(A);
      let t;
      t = fx * c - fy * sn; fy = fx * sn + fy * c; fx = t;
      t = rx * c - ry * sn; ry = rx * sn + ry * c; rx = t;
      t = ux * c - uy * sn; uy = ux * sn + uy * c; ux = t;
    }
    if (downSeq && downSeq.phase === "fall") { // 1.3.8: nose-down + spiral yaw of the falling ship (same as world3d)
      const P = downSeq.ship.pd, Y = downSeq.ship.yaw, cp2 = Math.cos(P), sp2 = Math.sin(P), cy2 = Math.cos(Y), sy2 = Math.sin(Y);
      let t;
      t = fy * cp2 - fz * sp2; fz = fy * sp2 + fz * cp2; fy = t;
      t = ry * cp2 - rz * sp2; rz = ry * sp2 + rz * cp2; ry = t;
      t = uy * cp2 - uz * sp2; uz = uy * sp2 + uz * cp2; uy = t;
      t = fx * cy2 + fz * sy2; fz = -fx * sy2 + fz * cy2; fx = t;
      t = rx * cy2 + rz * sy2; rz = -rx * sy2 + rz * cy2; rx = t;
      t = ux * cy2 + uz * sy2; uz = -ux * sy2 + uz * cy2; ux = t;
    }
    return { fx, fy, fz, rx, ry, rz, ux, uy, uz };
  }

  function project(x, y, z) {
    const b = lookBasis();
    const dx = x - EYE.x, dy = y - EYE.y, dz = z - EYE.z;
    const camZ = dx * b.fx + dy * b.fy + dz * b.fz;
    const camX = dx * b.rx + dy * b.ry + dz * b.rz;
    const camY = dx * b.ux + dy * b.uy + dz * b.uz;
    if (camZ < 1.2) return null;
    const f = (H * 0.5) / Math.tan(FOV * 0.5);
    const sx = W * 0.5 + (camX / camZ) * f;
    const sy = H * 0.5 - (camY / camZ) * f;
    return { sx, sy, z: camZ, s: f / camZ };
  }

  // Hitscan / lead-skill checks ignore muzzle shake so recoil can't fake a lead.
  function projectStable(x, y, z) {
    const b = lookBasis();
    const dx = x - EYE.x, dy = y - EYE.y, dz = z - EYE.z;
    const camZ = dx * b.fx + dy * b.fy + dz * b.fz;
    const camX = dx * b.rx + dy * b.ry + dz * b.rz;
    const camY = dx * b.ux + dy * b.uy + dz * b.uz;
    if (camZ < 1.2) return null;
    const f = (H * 0.5) / Math.tan(FOV * 0.5);
    return {
      sx: W * 0.5 + (camX / camZ) * f,
      sy: H * 0.5 - (camY / camZ) * f,
      z: camZ,
      s: f / camZ,
    };
  }

  function lookDir() {
    const b = lookBasis();
    return { x: b.fx, y: b.fy, z: b.fz };
  }

  // ----- combat -----

  function leadPoint(e, t) {
    return { x: e.x + (e.vx || 0) * t, y: e.y + (e.vy || 0) * t, z: e.z + (e.vz || 0) * t };
  }

  // Cycle 136: TRACER_UPS 220 — long visible travel; hitscan assist weakened.
  function leadFlightTime(dist) {
    return clamp(dist / TRACER_UPS, 0.18, 1.05);
  }

  /**
   * Aim lead for hitscan / gold pip / playtests. Pure 3D intercept collapses to
   * ~1px on phone FOV for radial beam dives, so we keep radial bullet time and
   * enforce a minimum LOS-tangential offset whenever the fighter is crossing.
   */
  function leadAimPoint(e) {
    // 1.3.2: true intercept for BULLET_UPS rounds fired from the turret
    const rx = e.x - CAM.x, ry = e.y - CAM.y, rz = e.z - CAM.z;
    const vx = e.vx || 0, vy = e.vy || 0, vz = e.vz || 0;
    const a = vx * vx + vy * vy + vz * vz - BULLET_UPS * BULLET_UPS;
    const b = 2 * (rx * vx + ry * vy + rz * vz);
    const c = rx * rx + ry * ry + rz * rz;
    let t = Math.sqrt(c) / BULLET_UPS;
    const disc = b * b - 4 * a * c;
    if (disc >= 0 && Math.abs(a) > 1e-6) {
      const sq = Math.sqrt(disc);
      const t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a);
      const cands = [t1, t2].filter((x) => x > 0);
      if (cands.length) t = Math.min(...cands);
    }
    for (let i = 0; i < 3; i++) t = ownTof(Math.hypot(rx + vx * t, ry + vy * t, rz + vz * t)); // 1.3.9: drag-slowed rounds
    return holdOff(e.x + vx * t, e.y + vy * t, e.z + vz * t);
  }
  // 1.3.9: the guns are harmonised at 320 u; nearer or farther the stream sits off the sight line by the
  // drop/drift difference. Return where the reticle must be for the stream to pass through (px,py,pz).
  const _ho = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  function holdOff(px, py, pz) {
    const r = Math.hypot(px - CAM.x, py - CAM.y, pz - CAM.z);
    if (r < 25 || r > 1500) return { x: px, y: py, z: pz };
    let sx = px, sy = py, sz = pz;
    for (let it = 0; it < 2; it++) {
      const dx = sx - CAM.x, dy = sy - CAM.y, dz = sz - CAM.z, L = Math.hypot(dx, dy, dz) || 1;
      const fx = dx / L, fy = dy / L, fz = dz / L, cc = aimCorr(fx, fy, fz);
      const ax = fx * CONV_R + cc[0], ay = fy * CONV_R + cc[1], az = fz * CONV_R + cc[2], al = Math.hypot(ax, ay, az) || 1;
      const o = _ho; o.x = 0; o.y = 0; o.z = 0; o.vx = ax / al * BULLET_UPS; o.vy = ay / al * BULLET_UPS; o.vz = az / al * BULLET_UPS;
      let d = 0, pd = 0, n = 0;
      while (d < r && n++ < 240) { balStep(o, 1 / 60); pd = d; d = o.x * fx + o.y * fy + o.z * fz; }
      const k = d > pd ? (r - pd) / (d - pd) : 1;
      const hx = o.px + (o.x - o.px) * k - fx * r, hy = o.py + (o.y - o.py) * k - fy * r, hz = o.pz + (o.z - o.pz) * k - fz * r;
      sx = px - hx; sy = py - hy; sz = pz - hz;
    }
    return { x: sx, y: sy, z: sz };
  }

  /** True if crosshair prefers the lead pip over the airframe (deflection skill). */
  function aimPrefersLead(e) {
    const cx = W * 0.5, cy = H * 0.5;
    const lp = leadAimPoint(e);
    const pLead = projectStable(lp.x, lp.y, lp.z);
    const pPlane = projectStable(e.x, e.y, e.z);
    if (!pLead) return false;
    if (!pPlane) return true;
    const dLead = Math.hypot(pLead.sx - cx, pLead.sy - cy);
    const dPlane = Math.hypot(pPlane.sx - cx, pPlane.sy - cy);
    const leadSep = Math.hypot(pLead.sx - pPlane.sx, pLead.sy - pPlane.sy);
    leadDebug.sepSum += leadSep; leadDebug.sepN++;
    // Cycle 127: near-full sep (plane-aim + slash lag must not equal lead).
    // Cycle 131: stricter near-full sep (floor 34 / slack 6) — C130 still saw rare plane=1
    // when 0.12s slash lag put dPlane just past leadSep-10 while still off the pip.
    if (leadSep > 2.5) {
      if (dPlane < Math.max(34, leadSep - 6)) { leadDebug.hitscanReject++; return false; }
      if (dLead < 12 && dLead < dPlane - 2.0) return true;
      if (dPlane <= dLead + 0.5) { leadDebug.hitscanReject++; return false; }
      return false;
    }
    return dLead <= dPlane && dPlane >= Math.max(34, leadSep - 6);
  }

  /** True if ANY alive airframe sits under the reticle — blocks plane-aim
   *  (and cross-bandit lead snags while glued to another fuselage). Cycle 131. */
  function airframeUnderReticle(maxPx) {
    const cx = W * 0.5, cy = H * 0.5;
    const lim = maxPx == null ? 26 : maxPx;
    for (const e of enemies) {
      if (!e.alive) continue;
      const p = projectStable(e.x, e.y, e.z);
      if (!p) continue;
      if (Math.hypot(p.sx - cx, p.sy - cy) < lim) return true;
    }
    return false;
  }

  function screenHitscan() {
    // Skill curve: shoot the LEAD pip. Aiming at the airframe while the pip
    // is clearly ahead does NOT count — that's the whole turret lesson.
    // Cycle 131: if any fuselage is under the reticle, deny lead credit (stops
    // lookAt(A) from snagging bandit B's lead pip near A's airframe).
    if (airframeUnderReticle(26)) return null;
    const cx = W * 0.5, cy = H * 0.5;
    let best = null, bestD = 1e9;
    for (const e of enemies) {
      if (!e.alive || e.team === "allied") continue;
      const dist = Math.hypot(e.x - CAM.x, e.y - CAM.y, e.z - CAM.z);
      const crossing = Math.hypot(e.vx || 0, e.vz || 0);
      const lp = leadAimPoint(e);
      const pLead = projectStable(lp.x, lp.y, lp.z);
      if (!pLead) continue;
      if (!aimPrefersLead(e)) continue;
      const dLead = Math.hypot(pLead.sx - cx, pLead.sy - cy);
      // Cycle 136: tighter lead gate — hose-the-plane no longer auto-hits
      const thresh = 8 + Math.min(12, 110 / (pLead.z * 0.05 + 1)) - Math.min(2, crossing * 0.08);
      if (dLead < thresh && dLead < bestD) { best = e; bestD = dLead; }
    }
    return best;
  }

  function muzzleWorld(side) {
    const m = World3D && World3D.muzzles && World3D.muzzles[side];
    // 1.3.8: only trust the renderer's muzzle if it's at our turret (it's stale for a frame after a bail-out → restart)
    if (m && (m.x || m.y || m.z) && Math.abs(m.x - CAM.x) + Math.abs(m.y - CAM.y) + Math.abs(m.z - CAM.z) < 4) return m;
    const b = lookBasis();
    const x = side ? 0.3 : -0.3, y = -0.5, z = 1.6;
    return {
      x: CAM.x + b.rx * x + b.ux * y + b.fx * z,
      y: CAM.y + b.ry * x + b.uy * y + b.fy * z,
      z: CAM.z + b.rz * x + b.uz * y + b.fz * z,
      sx: W * (side ? 0.56 : 0.44), sy: H * 0.8,
    };
  }

  // Own-ship shape (was the 1.3.3 fire-interrupter; 1.3.5 uses it for self-hits). Own-ship frame = CAM origin, +Z nose, +X port (same as world3d ownShip).
  const OWN_EX = [8.3, 4.3, -4.3, -8.3];
  const ownLE = (ax) => 1.6 - (ax - 1) * (2.0 / 12);
  const ownTE = (ax) => -3.4 + (ax - 1) * (1.1 / 12);
  const ownWY = (ax) => -2.35 + ax * 0.0787;
  function insideOwnShip(x, y, z) {
    const ax = Math.abs(x);
    if (ax >= 1 && ax <= 13.5 && z <= ownLE(ax) + 0.15 && z >= ownTE(ax) - 0.15 && Math.abs(y - ownWY(ax)) < 0.55) return true;
    for (let i = 0; i < 4; i++) {
      const ex = OWN_EX[i], e = Math.abs(ex);
      const zc = ownLE(e) + (e < 6 ? 2.7 : 2.6) + 0.34, cy = ownWY(e) - 0.02;
      if (Math.abs(z - zc) < 0.5 && Math.hypot(x - ex, y - cy) < 1.6) return true;
      if (z < zc && z > ownTE(e) && Math.hypot(x - ex, y - cy) < 0.75) return true;
    }
    if (z <= 5.4 && z >= -13.9) {
      const r = 1.1 - Math.max(0, z - 2.6) * 0.36 - Math.max(0, -3 - z) * 0.07;
      if (Math.hypot(x, (y + 1.85) / 1.08) < r) return true;
    }
    if (z >= 0.9 && z <= 3.7 && ax < 0.9 && y < -0.68 - (z > 2.55 ? (z - 2.55) * 0.55 : 0)) return true;
    if (ax < 0.35 && z <= -8.4 && z >= -13.9 && y < (z > -12.4 ? -0.4 + (-8.6 - z) * 0.95 : 3.1)) return true;
    if (ax < 5.7 && z <= -10.5 && z >= -13.5 && Math.abs(y + 1.52) < 0.35) return true;
    return false;
  }
  // 1.3.5: NO interrupter. The same own-ship shape is now a hit classifier: our .50s strike our
  // own wings, props/engines, fuselage and tail. Own frame = world − CAM (+Z nose, +X port).
  function ownPartAt(x, y, z) {
    if (!insideOwnShip(x, y, z)) return null;
    if (z <= -8.4) return "tail";
    for (let i = 0; i < 4; i++) {
      const ex = OWN_EX[i], e = Math.abs(ex);
      const zc = ownLE(e) + (e < 6 ? 2.7 : 2.6) + 0.34, cy = ownWY(e) - 0.02;
      if (Math.abs(x - ex) < 1.6 && z > ownTE(e) - 0.2 && z < zc + 0.6 && Math.abs(y - cy) < 1.6) return i; // prop disc / nacelle
    }
    return Math.abs(x) >= 1 ? "wing" : "body";
  }
  // 1.3.8: our airframe's CURRENT world transform (same as world3d ownShip): origin + Ry(yaw)·Rx(pitch)·Rz(−roll).
  // In level flight / the 21° post-bomb bank the origin is the turret (CAM) and only the roll applies;
  // in the death spin the ship's own position, nose-down pitch, yaw and spiral roll.
  function ownPose() {
    if (downSeq && downSeq.ship) { const S = downSeq.ship; return { o: S, P: S.pd || 0, Y: S.yaw || 0, Rl: -(S.roll || 0) }; }
    return { o: CAM, P: 0, Y: 0, Rl: -(viewRoll || 0) };
  }
  function ownRayPose(pose) { return { x: pose.o.x, y: pose.o.y, z: pose.o.z, rx: pose.P, ry: pose.Y, rz: pose.Rl }; }
  function friendlyRayPose(f) { return { x: f.x, y: f.y, z: f.z, rx: -(f.spiraling ? -0.35 - Math.min(0.5, (f.spiralT || 0) * 0.08) : 0), ry: f.yaw || 0, rz: -(f.bank || 0) }; }
  function toOwnLocal(pose, x, y, z) { // world offset → own frame (inverse rotation, applied Ry⁻¹ → Rx⁻¹ → Rz⁻¹)
    let c = Math.cos(pose.Y), s = Math.sin(pose.Y);
    let x1 = x * c - z * s, z1 = x * s + z * c, y1 = y;
    c = Math.cos(pose.P); s = Math.sin(pose.P);
    const y2 = y1 * c + z1 * s, z2 = -y1 * s + z1 * c;
    c = Math.cos(pose.Rl); s = Math.sin(pose.Rl);
    return { x: x1 * c + y2 * s, y: -x1 * s + y2 * c, z: z2 };
  }
  function ownPartNear(x, y, z) { // classify a point ON the rendered skin (the analytic volume can be a hair thinner)
    const p = ownPartAt(x, y, z);
    if (p != null) return p;
    if (z <= -8.4) return "tail";
    for (let i = 0; i < 4; i++) { const ex = OWN_EX[i], e = Math.abs(ex), zc = ownLE(e) + (e < 6 ? 2.7 : 2.6) + 0.34; if (Math.abs(x - ex) < 1.7 && z > ownTE(e) - 0.3 && z < zc + 0.7 && Math.abs(y - ownWY(e)) < 1.7) return i; }
    return Math.abs(x) >= 1 ? "wing" : "body";
  }
  function hitOwnShipSeg(x0, y0, z0, x1, y1, z1, trav) {
    const pose = ownPose(), O = pose.o;
    // cheap reject: segment must pass within ~16u of the airframe origin
    const mx = (x0 + x1) / 2 - O.x, my = (y0 + y1) / 2 - O.y, mz = (z0 + z1) / 2 - O.z;
    const L = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    if (Math.hypot(mx, my, mz) > 16 + L / 2) return null;
    const t0 = L > 0 ? clamp(1 - (trav - 1.2) / L, 0, 1) : 0; // the part still leaving the barrels can't hit
    if (t0 >= 1) return null;
    const ax = x0 + (x1 - x0) * t0, ay = y0 + (y1 - y0) * t0, az = z0 + (z1 - z0) * t0;
    if (World3D && World3D.rayShip) { // exact: the rendered, rolled mesh
      const h = World3D.rayShip("own", ax, ay, az, x1, y1, z1, ownRayPose(pose));
      if (!h) return null;
      const l = toOwnLocal(pose, h.x - O.x, h.y - O.y, h.z - O.z);
      let part = ownPartNear(l.x, l.y, l.z);
      if (h.prop && typeof part !== "number") { let bi = 0, bd = 1e9; for (let i = 0; i < 4; i++) { const d = Math.abs(l.x - OWN_EX[i]); if (d < bd) { bd = d; bi = i; } } part = bi; }
      return { part, x: h.x - CAM.x, y: h.y - CAM.y, z: h.z - CAM.z, lx: l.x, ly: l.y, lz: l.z, ray: h };
    }
    const n = Math.max(2, Math.ceil(L / 0.25));
    for (let k = 0; k <= n; k++) {
      const t = t0 + (1 - t0) * k / n;
      const wx = x0 + (x1 - x0) * t, wy = y0 + (y1 - y0) * t, wz = z0 + (z1 - z0) * t;
      const l = toOwnLocal(pose, wx - O.x, wy - O.y, wz - O.z);
      const part = ownPartAt(l.x, l.y, l.z);
      if (part != null) return { part, x: wx - CAM.x, y: wy - CAM.y, z: wz - CAM.z, lx: l.x, ly: l.y, lz: l.z, ray: null };
    }
    return null;
  }
  function ownShipHides(dx, dy, dz) { // is the line of sight (unit dir from the turret) blocked by our own airframe?
    const l = toOwnLocal(ownPose(), dx, dy, dz); dx = l.x; dy = l.y; dz = l.z; // 1.3.8: in the rolled airframe
    for (let r = 2.5; r < 36; r += 0.6) if (insideOwnShip(dx * r, dy * r, dz * r)) return true;
    return false;
  }
  function aimHitsOwnShip() { // test/debug helper only (no interrupter): would either gun's stream strike our airframe?
    const y0 = gunner.yaw, p0 = gunner.pitch;
    for (const [dy, dp] of [[0, 0], [0.025, 0], [-0.025, 0], [0, 0.025], [0, -0.025]]) {
      gunner.yaw = y0 + dy; gunner.pitch = p0 + dp;
      const b = lookBasis();
      for (const side of [0, 1]) {
        const m = muzzleWorld(side);
        for (let t = 1.2; t <= 26; t += 0.3) {
          const l = toOwnLocal(ownPose(), m.x - CAM.x + b.fx * t, m.y - CAM.y + b.fy * t, m.z - CAM.z + b.fz * t);
          if (insideOwnShip(l.x, l.y, l.z)) { gunner.yaw = y0; gunner.pitch = p0; return true; }
        }
      }
    }
    gunner.yaw = y0; gunner.pitch = p0;
    return false;
  }
  let lastOwnHitCall = -99;
  function ownShipHit(h) {
    if (!bomber || bomber.dead) return;
    if (window.FGAudio) window.FGAudio.hitOwn("self");
    const p = h.part;
    let id = FC.boxAt(h.lx / OWN_SCALE + OWN_OFF[0], h.ly / OWN_SCALE + OWN_OFF[1], h.lz / OWN_SCALE + OWN_OFF[2]);
    if (typeof p === "number") id = FC.ENG_ID[p];
    id = normBox(id);
    let msg = null;
    if (typeof p === "number") msg = "YOU'RE HITTING OUR #" + (p + 1) + " ENGINE!";
    else if (p === "tail") msg = "YOU'RE SHOOTING OUR OWN TAIL!";
    else msg = p === "wing" ? "YOU'RE HITTING OUR WING!" : "YOU'RE HITTING OUR OWN SHIP!";
    bomber.ownHits = (bomber.ownHits || 0) + 1;
    if (mission) mission.ownHits = (mission.ownHits || 0) + 1;
    shipHit(bomber, id, "m2", 1, "own");
    // 1.3.8: the hole sits exactly where the round met the rendered skin (raycast point + normal), in the ship's frame
    const hole = { x: h.lx, y: h.ly, z: h.lz };
    if (bomber.holes.length < 80) bomber.holes.push(hole);
    else bomber.holes[(bomber.ownHits) % 80] = hole;
    if (h.ray && World3D && World3D.addHole) World3D.addHole("own", h.ray, typeof p === "number" ? 0.12 : 0.13);
    bomber.holeN = (bomber.holeN || 0) + 1;
    if (h.ray && World3D && World3D.addTear && bomber.holeN % 8 === 0) { fx154.n.tears++; World3D.addTear("own", h.ray, 0.45 + Math.min(0.7, bomber.holeN * 0.012)); }
    hitCluster(CAM.x + h.x, CAM.y + h.y, CAM.z + h.z, 0, 0, 0, false, 0.3);
    if (mission) { const hs = mission.ownHitLog || (mission.ownHitLog = []); if (hs.length < 400) hs.push({ part: p, box: id, x: h.x + CAM.x, y: h.y + CAM.y, z: h.z + CAM.z, lx: h.lx, ly: h.ly, lz: h.lz, roll: viewRoll }); }
    for (let i = 0; i < 5; i++) {
      particles.push({
        x: CAM.x + h.x, y: CAM.y + h.y, z: CAM.z + h.z,
        vx: rand(-6, 6), vy: rand(-2, 8), vz: rand(-10, 2),
        life: rand(0.1, 0.3), max: 0.3, kind: i < 4 ? "spark" : "fire", r: rand(0.6, 1.4),
      });
    }
    for (let i = 0, nC = (typeof p === "string" && /wing|tail|engine/.test(p) ? 3 : 2); i < nC; i++) { // torn-skin chips streaming back in the slipstream
      particles.push({ x: CAM.x + h.x, y: CAM.y + h.y, z: CAM.z + h.z, vx: rand(-5, 5), vy: rand(1, 9), vz: rand(-26, -8), life: rand(0.35, 0.7), max: 0.7, kind: "chip", r: rand(0.8, 1.7) });
    }
    if (elapsed - lastOwnHitCall > 3) { lastOwnHitCall = elapsed; pushCallout(msg, 1.2, true); }
  }

  function tryFire(dt) {
    guns.cutout = false; // 1.3.5: interrupter removed
    if (!input.fire || guns.overheated) return;
    guns.cooldown -= dt;
    if (guns.cooldown > 0) return;
    // 1.3.2: twin M2s alternate, ~20 rds/s total; every 3rd round a tracer
    guns.cooldown = 0.05;
    guns.side ^= 1;
    guns.rounds++;
    guns.heat = Math.min(1, guns.heat + 0.0185); // 1.3.4: ~2.2× longer sustained fire (6.4 s → ~14 s)
    if (guns.heat >= 1) guns.overheated = true;
    const side = guns.side;
    guns.recoilLR[side] = 1;
    guns.flashLR[side] = 1;
    gunner.recoil = Math.min(1, gunner.recoil + 0.3);
    gunner.shake = Math.min(1.0, gunner.shake + 0.3);
    rumble = 1;
    const m = muzzleWorld(side);
    const b = lookBasis();
    const spread = 0.005 + guns.heat * 0.01;
    const ox = (Math.random() + Math.random() - 1) * spread;
    const oy = (Math.random() + Math.random() - 1) * spread;
    // converge on the sight line at ~320u (harmonised guns)
    const R = 320;
    const cx = CAM.x + (b.fx + b.rx * ox + b.ux * oy) * R;
    const cy = CAM.y + (b.fy + b.ry * ox + b.uy * oy) * R;
    const cz = CAM.z + (b.fz + b.rz * ox + b.uz * oy) * R;
    // 1.3.9: + the precomputed gravity/drag correction for this look direction
    const cc = aimCorr(b.fx, b.fy, b.fz);
    const ax = cx + cc[0], ay = cy + cc[1], az = cz + cc[2];
    const L = Math.hypot(ax - m.x, ay - m.y, az - m.z) || 1;
    bullets.push({
      x: m.x, y: m.y, z: m.z, px: m.x, py: m.y, pz: m.z,
      vx: (ax - m.x) / L * BULLET_UPS, vy: (ay - m.y) / L * BULLET_UPS, vz: (az - m.z) / L * BULLET_UPS,
      life: BULLET_LIFE, tracer: ((guns.trc = (guns.trc || 0) + 1) & 7) < 2, side, trav: 0, // 1.4.0: 1 in 4 rounds per gun glows (guns alternate, so 2 consecutive shots of every 8 = one per gun); ball rounds still hit // // 1.3.9: every round glows (a continuous stream from each gun, like the box's hoses) // 1.3.7: every 2nd round per gun is a tracer → a stream from each muzzle
    });
    guns.muzzle = 1;
    spawnMuzzleGrit(side);
    sfxFifty(side);
    // Brass: ejected from the receiver (below/behind the barrel), tumbling out and down
    const sgn = side ? 1 : -1;
    const baseX = m.sx + sgn * W * 0.07, baseY = H + 12;
    const ex = m.sx + (baseX - m.sx) * 0.72, ey = m.sy + (baseY - m.sy) * 0.72;
    brass.push({
      x: ex + rand(-3, 3), y: ey + rand(-3, 3),
      vx: sgn * rand(90, 190), vy: rand(-230, -120),
      rot: rand(0, TAU), spin: rand(-14, 14), tumble: rand(0, TAU), tspin: rand(14, 30) * (Math.random() < 0.5 ? -1 : 1),
      len: rand(8.5, 11), life: rand(0.55, 0.8),
    });
  }


  function spawnMuzzleGrit(gun) { // 1.5.3: removed — at ~180 mph the slipstream strips gun smoke away instantly, so no lingering puffs (flash, tracers, brass and recoil stay)
    return;
    // faint gun-smoke wisps at the actual barrel tip
    const m = muzzleWorld(gun || 0);
    for (let i = 0; i < 2; i++) {
      muzzleSmoke.push({
        x: m.sx + rand(-3, 3), y: m.sy + rand(-3, 3),
        vx: rand(-20, 20), vy: rand(-40, -12),
        life: rand(0.2, 0.4), r: rand(4, 7),
      });
    }
  }

  function fighterHitR(e) {
    const dist = Math.hypot(e.x - CAM.x, e.y - CAM.y, e.z - CAM.z);
    let sc = 1;
    if (dist > 180) sc *= 1 + Math.min(0.5, (dist - 180) / 300); // matches world3d far boost
    return FIGHTER_R * Math.min(sc, 2.1 / 1.3);
  }
  function hitTestBullet(b, dt) {
    // 1.3.2: real ballistics — swept segment vs moving fighter sphere (box-relative)
    for (const e of enemies) {
      if (!e.alive || e.hold) continue; // 1.5.3: our rounds do NOT skip the Mustangs any more (friendly fire, penalty)
      const r0x = (b.px != null ? b.px : b.x - b.vx * dt) - (e.x - e.vx * dt), r0y = (b.py != null ? b.py : b.y - b.vy * dt) - (e.y - e.vy * dt), r0z = (b.pz != null ? b.pz : b.z - b.vz * dt) - (e.z - e.vz * dt); // 1.3.9: the round's real previous position on its curved path
      const r1x = b.x - e.x, r1y = b.y - e.y, r1z = b.z - e.z;
      // 1.3.8: exact test vs the rendered 109 at its current heading / pitch / bank (sphere only as broadphase / fallback)
      const bR = World3D && World3D.fighterBoundR ? World3D.fighterBoundR(e.type) * (e.type === "190" ? 1.4 : e.type === "110" ? 1.6 : 1.3) : 0;
      const exact = bR > 0 && World3D.rayFighter;
      const R = exact ? bR + 1.5 : fighterHitR(e);
      if (Math.abs(r1x) > 60 && Math.abs(r0x) > 60) continue;
      const sx = r1x - r0x, sy = r1y - r0y, sz = r1z - r0z;
      const ss = sx * sx + sy * sy + sz * sz || 1e-6;
      const tt = clamp(-(r0x * sx + r0y * sy + r0z * sz) / ss, 0, 1);
      const qx = r0x + sx * tt, qy = r0y + sy * tt, qz = r0z + sz * tt;
      let fhit = null;
      if (qx * qx + qy * qy + qz * qz < R * R && exact) {
        const dCam = Math.hypot(e.x - CAM.x, e.y - CAM.y, e.z - CAM.z);
        const tol = clamp((dCam - 40) * TUNE.fHitTolAng, 0, 1.6); // ≈0.3° of the gunner's view (~2 px on a phone) past 40u, exact skin inside 40u: gunnery stays playable, sparks stay on the skin
        fhit = World3D.rayFighter(e, e.x + r0x, e.y + r0y, e.z + r0z, e.x + r1x, e.y + r1y, e.z + r1z, tol);
        if (fhit === undefined) fhit = qx * qx + qy * qy + qz * qz < FIGHTER_R * FIGHTER_R ? { x: e.x + qx, y: e.y + qy, z: e.z + qz } : null;
        if (!fhit) { if (mission) mission.fMeshMiss = (mission.fMeshMiss || 0) + 1; continue; }
        if (World3D.addFighterHole && fhit.lx != null) World3D.addFighterHole(e, fhit, 0.11);
      } else if (qx * qx + qy * qy + qz * qz < R * R) fhit = { x: e.x + qx, y: e.y + qy, z: e.z + qz };
      if (fhit && e.team === "allied") return ffMustang(e, fhit, "you");
      if (fhit) {
        if (mission) { const fl = mission.fHitLog || (mission.fHitLog = []); if (fl.length < 400) fl.push({ id: e.id, x: fhit.x, y: fhit.y, z: fhit.z, lx: fhit.lx, ly: fhit.ly, lz: fhit.lz, bank: e.bank }); }
        let part = "hull";
        if (fhit.lx != null && World3D.fighterBoundR) { const kk = 1.75 / Math.max(0.5, World3D.fighterBoundR(e.type)); part = FC.classifyFighterHit(fhit.lx * kk, fhit.ly * kk, -fhit.lz * kk); }
        const pd = exact ? FC.fighterRound(e.type, part, TUNE.fRoundDmg, e.sturm) : 1;
        if (mission) { const L = mission.hitLog || (mission.hitLog = {}), m = L["you:m2>" + e.type] || (L["you:m2>" + e.type] = {}); m[part] = (m[part] || 0) + 1; }
        if (e.ps && e.phase === "attack") { e.ps.hit = true; if (!e.firedPass) e.ps.hitFirst = true; }
        e.hp -= pd;
        e.pHits = (e.pHits || 0) + pd; // damage, same unit as e.cHits
        e.flash = 1;
        e.smoke = Math.min(1, e.smoke + 0.25);
        hitsLanded++;
        score += 15;
        comboTimer = 2.2;
        spawnHit(e, fhit);
        sfxHit();
        if (e.hp <= 0) killEnemy(e, (e.cHits || 0) > e.pHits); // 1.3.8: credit goes to whoever did most damage to him
        else if (e.phase === "attack" && e.burst && (Math.random() < 0.55 ? (e.burst = null, true) : (e.burst.jit = Math.max(e.burst.jit, 1.8), false)) && Math.random() < (e.tgt && e.tgt.kind === "player" ? 0.55 : 0.3)) { // hit and rattled: spoils his run (1.3.8: his burst too, half the time), breaks off early — more so when he's coming at us
          e.burstsLeft = 0; e.phase = "break"; e.phaseT = 0; e.brkSide = Math.random() < 0.5 ? -1 : 1;
          e.breakType = e.type === "190" ? "under" : Math.random() < 0.5 ? "splitS" : "under"; e.invert = e.breakType === "splitS"; if (e.opening) e.opening = false;
        }
        return true;
      }
    }
    // 1.3.5: no interrupter — our own ship is hit first (it's closest)
    const b0x = b.px != null ? b.px : b.x - b.vx * dt, b0y = b.py != null ? b.py : b.y - b.vy * dt, b0z = b.pz != null ? b.pz : b.z - b.vz * dt;
    const oh = hitOwnShipSeg(b0x, b0y, b0z, b.x, b.y, b.z, b.trav || 0);
    if (oh) { ownShipHit(oh); return true; }
    // 1.3.4: friendly fire — our .50s can hit the other Fortresses
    const fh = hitFriendlySeg(b0x, b0y, b0z, b.x, b.y, b.z, null, true);
    if (fh) { friendlyFireHit(fh, TUNE.ffPlayerDmg, true); return true; }
    return false;
  }

  // ===== 1.5.4 HIT / DAMAGE / CABIN EFFECTS (from the reference clips): clustered multi-flash bursts + 20 mm bloom, shaped camera kicks + blur,
  //       interior-cabin specks / sparks / vignette, gun-sight vibration, torn skin =====
  // ===== 1.5.6 injured gunner: on a DIRECT flak hit on our ship (once per run, same trigger as the audio ear-ring) the picture goes black-and-white, high-contrast, tunnel-vignetted and slightly blurred
  // after a white flash, then colour returns over ~10 s. One fixed overlay (backdrop-filter + radial gradient) sits under the HUD and over both canvases; pointer-events:none → input and HUD are untouched.
  const INJ_SEC = 10, injury = { used: false, t0: -1, el: null, vg: null, fl: null, raf: 0, peakGray: 0, last: "", n: 0, sat: 1 };
  function injuryEnsure() {
    if (injury.el) return;
    const el = document.createElement("div"); el.id = "injFx"; el.style.cssText = "position:fixed;inset:0;z-index:1;pointer-events:none;display:none;will-change:backdrop-filter,opacity";
    const vg = document.createElement("div"); vg.style.cssText = "position:absolute;inset:0;background:radial-gradient(ellipse at 50% 48%,rgba(0,0,0,0) 22%,rgba(0,0,0,.55) 58%,rgba(0,0,0,.94) 100%)";
    const fl = document.createElement("div"); fl.style.cssText = "position:absolute;inset:0;background:#fff;opacity:0";
    el.appendChild(vg); el.appendChild(fl);
    const hud = document.getElementById("hud"); if (hud && hud.parentNode) hud.parentNode.insertBefore(el, hud); else document.body.appendChild(el);
    injury.el = el; injury.vg = vg; injury.fl = fl;
  }
  function injuryProfile(age) { // → {gray 0..1, flash 0..1}
    const u = Math.min(1, age / INJ_SEC), hold = 0.16;
    const x = u <= hold ? 0 : (u - hold) / (1 - hold), ease = x * x * (3 - 2 * x);
    return { gray: u >= 1 ? 0 : 1 - ease, flash: age < 0.3 ? 0.92 * (1 - age / 0.3) * (1 - age / 0.3) : 0 };
  }
  function injuryApply(age) {
    const p = injuryProfile(age), g = p.gray, el = injury.el; if (!el) return;
    if (age >= INJ_SEC) { el.style.display = "none"; el.style.webkitBackdropFilter = el.style.backdropFilter = ""; injury.sat = 1; injury.t0 = -1; return false; }
    const f = "grayscale(" + g.toFixed(3) + ") contrast(" + (1 + 0.55 * g).toFixed(3) + ") brightness(" + (1 - 0.12 * g).toFixed(3) + ") blur(" + (1.8 * g * g).toFixed(2) + "px)";
    if (f !== injury.last) { injury.last = f; el.style.webkitBackdropFilter = el.style.backdropFilter = f; }
    el.style.display = "block"; el.style.opacity = "1"; injury.vg.style.opacity = (0.15 + 0.85 * g).toFixed(3); injury.fl.style.opacity = p.flash.toFixed(3); injury.sat = 1 - g; injury.peakGray = Math.max(injury.peakGray, g);
    return true;
  }
  function injuryTick() { injury.raf = 0; if (injury.t0 < 0) return; if (injuryApply((performance.now() - injury.t0) / 1000) !== false) injury.raf = requestAnimationFrame(injuryTick); }
  function injuredGunner() { if (injury.used) return false; injury.used = true; injury.n++; injuryEnsure(); injury.t0 = performance.now(); injury.last = ""; if (!injury.raf) injury.raf = requestAnimationFrame(injuryTick); return true; }
  function injuryReset() { injury.used = false; injury.t0 = -1; injury.last = ""; injury.sat = 1; if (injury.raf) { cancelAnimationFrame(injury.raf); injury.raf = 0; } if (injury.el) { injury.el.style.display = "none"; injury.el.style.webkitBackdropFilter = injury.el.style.backdropFilter = ""; } }
  window.__fgInjury = { state: injury, start: () => injuredGunner(), reset: injuryReset, profile: injuryProfile };
  const fx154 = { kicks: [], cabin: [], vig: 0, blur: 0, blurPx: -1, vib: 0, accum: 0, lastCannonKick: -9, n: { cluster: 0, flashes: 0, bloom: 0, kicks: 0, flakKicks: 0, cannonKicks: 0, specks: 0, sparks: 0, cabinHits: 0, tears: 0 }, peakKick: 0, peakBlur: 0, peakVig: 0 };
  function hitCluster(x, y, z, vx, vy, vz, heavy, sc) { // several offset flashes with staggered starts (irregular, never one uniform dot); heavy (20 mm / 30 mm) adds a white bloom
    const n = (heavy ? 4 : 3) + (Math.random() < 0.4 ? 1 : 0); sc = sc || 1; fx154.n.cluster++;
    for (let k = 0; k < n; k++) {
      particles.push({ x: x + rand(-0.4, 0.4) * sc, y: y + rand(-0.3, 0.3) * sc, z: z + rand(-0.4, 0.4) * sc, vx: vx * 0.5 + rand(-3, 3), vy: vy * 0.5 + rand(-1, 3), vz: vz * 0.5 + rand(-3, 3), wait: k ? k * rand(0.012, 0.035) : 0, life: rand(0.07, 0.13) * (heavy ? 1.3 : 1), max: 0.13 * (heavy ? 1.3 : 1), kind: "flash", r: rand(1.6, 3.1) * (heavy ? 1.35 : 1), ang: rand(0, Math.PI) });
      fx154.n.flashes++;
    }
    if (heavy) { particles.push({ x, y, z, vx: vx * 0.4, vy: vy * 0.4, vz: vz * 0.4, wait: 0, life: 0.2, max: 0.2, kind: "bloom", r: rand(4.2, 6.2), ang: 0 }); fx154.n.bloom++; }
  }
  function addKick(kind, amp) { // shaped camera kick: flak = one hard low jolt then a slow wobble; cannon = a quick high shudder; mg = a faint tick
    const K = kind === "flak" ? { f: 7.5, dec: 0.5, jolt: 0.7 } : kind === "cannon" ? { f: 22, dec: 0.2, jolt: 0.25 } : { f: 30, dec: 0.1, jolt: 0 };
    if (kind === "cannon") { if (elapsed - fx154.lastCannonKick < 0.06) amp *= 0.45; fx154.lastCannonKick = elapsed; }
    fx154.kicks.push({ t: 0, amp, f: K.f * rand(0.9, 1.1), dec: K.dec, jolt: K.jolt, ph: rand(0, TAU), ax: rand(0.5, 1) * (Math.random() < 0.5 ? -1 : 1), ay: kind === "flak" ? 1 : rand(0.6, 1) * (Math.random() < 0.5 ? -1 : 1) });
    if (fx154.kicks.length > 8) fx154.kicks.shift();
    fx154.n.kicks++; if (kind === "flak") fx154.n.flakKicks++; if (kind === "cannon") fx154.n.cannonKicks++;
    fx154.blur = Math.max(fx154.blur, kind === "flak" ? Math.min(1, amp * 2.2) : kind === "cannon" ? Math.min(0.7, amp * 3.2) : 0);
  }
  function cabinHit(power, why) { // dark specks (insulation / glass / metal) drifting across the view, sparks off the turret frame, a vignette pulse
    power = clamp(power, 0.1, 1); fx154.n.cabinHits++;
    const nS = Math.round(7 + 24 * power), nK = Math.round(2 + 8 * power), u = Math.max(0.7, W / 900);
    for (let i = 0; i < nS; i++) fx154.cabin.push({ k: 0, x: rand(0, W), y: rand(H * 0.08, H * 0.92), vx: rand(-70, 70) * u, vy: rand(-110, 60) * u, r: rand(0.9, 3.0) * u, life: rand(0.5, 1.5), max: 1.5, pale: Math.random() < 0.28, ph: rand(0, TAU) });
    for (let i = 0; i < nK; i++) { // sparks fly off the framing (screen edges / bottom coaming)
      const edge = (Math.random() * 3) | 0; let x, y;
      if (edge === 0) { x = rand(0, W * 0.1); y = rand(H * 0.1, H * 0.9); } else if (edge === 1) { x = rand(W * 0.9, W); y = rand(H * 0.1, H * 0.9); } else { x = rand(0, W); y = rand(H * 0.84, H * 0.98); }
      fx154.cabin.push({ k: 1, x, y, vx: rand(-260, 260) * u, vy: rand(-340, 60) * u, r: rand(1.4, 2.6) * u, life: rand(0.12, 0.3), max: 0.3, ph: 0 });
    }
    fx154.n.specks += nS; fx154.n.sparks += nK;
    fx154.vig = Math.min(0.85, fx154.vig + 0.55 * power);
    if (fx154.cabin.length > 90) fx154.cabin.splice(0, fx154.cabin.length - 90);
  }
  function stepFx154(dt) {
    let kx = 0, ky = 0;
    for (const k of fx154.kicks) {
      k.t += dt;
      const env = Math.exp(-k.t / k.dec), jolt = k.jolt * Math.max(0, 1 - k.t / 0.07);
      const d = k.amp * env * (Math.sin(TAU * k.f * k.t + k.ph) * (1 - k.jolt * 0.4) + jolt * 1.6);
      kx += d * k.ax * 0.7; ky += d * k.ay;
    }
    fx154.kicks = fx154.kicks.filter((k) => k.t < k.dec * 6);
    gunner.kx = kx; gunner.ky = ky; fx154.peakKick = Math.max(fx154.peakKick, Math.hypot(kx, ky));
    fx154.blur = Math.max(0, fx154.blur - dt * 5); fx154.peakBlur = Math.max(fx154.peakBlur, fx154.blur);
    fx154.vig = Math.max(0, fx154.vig - dt * 1.9); fx154.peakVig = Math.max(fx154.peakVig, fx154.vig);
    fx154.vib = input.fire && !guns.overheated ? Math.min(1, fx154.vib + dt * 14) : Math.max(0, fx154.vib - dt * 8);
    fx154.accum = Math.max(0, fx154.accum - dt * 1.4);
    for (const c of fx154.cabin) { c.life -= dt; c.x += c.vx * dt + (c.k ? 0 : Math.sin(elapsed * 6 + c.ph) * 14 * dt); c.y += c.vy * dt; if (!c.k) c.vy += 70 * dt; else c.vy += 500 * dt; }
    fx154.cabin = fx154.cabin.filter((c) => c.life > 0);
    const px = Math.round(Math.min(3.4, fx154.blur * 3.4) * 2) / 2; // CSS blur on the 3-D canvas, quantised so the style only changes a few times
    if (worldCanvas && px !== fx154.blurPx) { fx154.blurPx = px; worldCanvas.style.filter = px > 0 ? "blur(" + px + "px)" : ""; }
  }
  function drawCabinFx() {
    const F = fx154;
    if (F.vig > 0.02) { // dark vignette pulse
      const g = ctx.createRadialGradient(W * 0.5, H * 0.5, Math.min(W, H) * 0.28, W * 0.5, H * 0.5, Math.hypot(W, H) * 0.56);
      g.addColorStop(0, "rgba(8,6,4,0)"); g.addColorStop(1, "rgba(8,6,4," + Math.min(0.8, F.vig).toFixed(3) + ")");
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    if (!F.cabin.length) return;
    ctx.save();
    for (const c of F.cabin) {
      const a = clamp(c.life / c.max, 0, 1);
      if (c.k === 0) { ctx.globalAlpha = Math.min(1, a * 1.8) * 0.85; ctx.fillStyle = c.pale ? "#b4b0a0" : "#16150f"; ctx.fillRect(c.x - c.r, c.y - c.r * 0.7, c.r * 2, c.r * 1.4); }
    }
    ctx.globalCompositeOperation = "lighter";
    for (const c of F.cabin) {
      if (c.k !== 1) continue;
      const a = clamp(c.life / c.max, 0, 1), L = c.r * 4 * (0.5 + a), ang = Math.atan2(c.vy, c.vx);
      ctx.globalAlpha = a; ctx.strokeStyle = "rgb(255,214,120)"; ctx.lineWidth = Math.max(1.2, c.r * 0.7);
      ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(c.x - Math.cos(ang) * L, c.y - Math.sin(ang) * L); ctx.stroke();
      ctx.fillStyle = "rgb(255,248,220)"; ctx.beginPath(); ctx.arc(c.x, c.y, c.r * 0.6, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  function spawnHit(e, at) {
    // sparkle of strikes on the airframe (small, bright) — 1.3.8: AT the struck point on the mesh
    for (let i = 0; i < 8; i++) {
      particles.push({
        x: at ? at.x + rand(-0.02, 0.02) : e.x + rand(-1, 1), y: at ? at.y + rand(-0.02, 0.02) : e.y + rand(-0.5, 0.5), z: at ? at.z + rand(-0.02, 0.02) : e.z + rand(-1, 1),
        vx: e.vx * 0.6 + rand(-18, 18), vy: e.vy * 0.6 + rand(-8, 14), vz: e.vz * 0.6 + rand(-18, 18),
        life: rand(0.12, 0.35), max: 0.35,
        kind: i < 6 ? "spark" : "fire",
        r: rand(1.5, 3),
      });
    }
    for (let i = 0; i < 2; i++) particles.push({ x: at ? at.x : e.x, y: at ? at.y : e.y, z: at ? at.z : e.z, vx: e.vx * 0.7 + rand(-10, 10), vy: e.vy * 0.7 + rand(-4, 12), vz: e.vz * 0.7 + rand(-10, 10), life: rand(0.35, 0.7), max: 0.7, kind: "chip", r: rand(0.9, 1.8) });
    hitCluster(at ? at.x : e.x, at ? at.y : e.y, at ? at.z : e.z, e.vx, e.vy, e.vz, false, 1);
    const sp = at ? project(at.x, at.y, at.z) : project(e.x, e.y, e.z);
    if (sp) hitMarks.push({ x: sp.sx, y: sp.sy, life: 0.2, text: "" });
  }

  function killEnemy(e, byCpu) {
    e.alive = false; e.burst = null;
    if (mission) { const kb = mission.killsBy || (mission.killsBy = {}); const kk = e.type + ":" + (byCpu === "p51" ? "p51" : byCpu ? "gun" : "you") + ":" + (e.phase || "?"); kb[kk] = (kb[kk] || 0) + 1; }
    if (e.target) { e.target.p51n = Math.max(0, (e.target.p51n || 0) - 1); }
    if (e.ps && mission) { e.ps.dead = true; mission.deadPass = (mission.deadPass || 0) + 1; }
    if (mission && e.type === "190" && e.p51seen) mission.k190seen = (mission.k190seen || 0) + 1;
    if (mission && e.type === "190") mission.k190 = (mission.k190 || 0) + 1;
    if (mission && byCpu === "p51") { mission.p51Kills = (mission.p51Kills || 0) + 1; if (e.type === "190") mission.p51Kills190 = (mission.p51Kills190 || 0) + 1; byCpu = true; mission.kP51 = (mission.kP51 || 0) + 1; }
    else if (mission) { if (byCpu) mission.kGun = (mission.kGun || 0) + 1; else mission.kYou = (mission.kYou || 0) + 1; }
    if (window.FGAudio) window.FGAudio.boom(e.x, e.y, e.z, false);
    e.wreckT = 4.2;
    e.vx *= 0.6; e.vz *= 0.6; e.vy = Math.min(e.vy, 0) - 6;
    e.wreckAge = 0; e.bailAt = Math.random() < 0.65 ? rand(0.7, 2.8) : -1; // 1.3.8: most pilots get out
    if (byCpu) cpuKills++; else kills++;
    if (mission) mission.fightersKilled++;
    if (byCpu) {
      e.flash = 0.6;
      for (let i = 0; i < 14; i++) {
        particles.push({
          x: e.x, y: e.y, z: e.z,
          vx: rand(-25, 25), vy: rand(-10, 20), vz: rand(-25, 25),
          life: rand(0.4, 1.1), max: 1.1, kind: i < 6 ? "fire" : "smoke", r: rand(3, 8),
        });
      }
      return;
    }
    combo++;
    const bonus = 100 + combo * 25 + Math.floor(Math.max(0, 350 - Math.hypot(e.x, e.z)) * 0.35);
    score += bonus;
    pushCallout(combo > 2 ? "STREAK x" + combo : "BANDIT DOWN", 1.0);
    for (let i = 0; i < 42; i++) {
      particles.push({
        x: e.x, y: e.y, z: e.z,
        vx: rand(-70, 70), vy: rand(-20, 55), vz: rand(-70, 70),
        life: rand(0.35, 1.35), max: 1.35,
        kind: i < 14 ? "fire" : (i < 28 ? "spark" : "smoke"),
        r: rand(4, 14),
      });
    }
    gunner.shake = 1.8;
    rumble = 1;
    guns.muzzle = Math.max(guns.muzzle, 0.55);
    const sp = project(e.x, e.y, e.z);
    hitMarks.push({ x: sp ? sp.sx : W * 0.5, y: sp ? sp.sy : H * 0.22, life: 0.7, text: "KILL", big: true });
  }

  let godMode = false; // test hook only
  function healthEngineCheck() {} // 1.5.0: obsolete — engines are their own components now

  // ===== 1.3.8 HEAVY FLAK (88 mm): predicted-fire salvos from batteries of 4, walking in on the box =====
  // Bursts live in the air mass (box frame: they stream aft at -VF). Damage by distance to each B-17:
  // < 5u (7 m) direct hit → blown apart; < 22u fragments (damage, engines, fires); close bursts shake
  // our view and rattle shrapnel on our skin.
  let flakBursts = [], flakSeq = 0;
  const FLAK = { lethal: 5, frag: 24, dmg: 24, engChance: 0.25, playerMul: 0.3, blowChance: 0.5, playerLethal: 0.1 };
  function flakRate(m) { // bursts per second along the route (time left tl)
    if (window.__FG_SCN && window.__FG_SCN.noflak) return 0;
    const tl = m.timeLeft, post = m.post || 0;
    if (m.bombsAway) return post < 14 ? 2.6 * (1 - post / 14) : 0;
    if (tl <= MISSION_DOORS_AT) return 2.4 + 2.8 * (1 - tl / MISSION_DOORS_AT); // over the town: thickest at release
    if (tl < 205 && tl > 188) return 0.9;   // a flak belt on the route in
    if (tl < 150 && tl > 134) return 1.5;   // a heavier belt near the IP
    return 0;
  }
  function updateFlakSim(dt) {
    const m = mission; if (!m) return;
    const F = m.flakStats || (m.flakStats = { bursts: 0, near: 0, hitsF: 0, lostF: 0, blown: 0, hitsP: 0, closeP: 0 });
    for (const b of flakBursts) { b.t += dt; b.z -= VF * dt; b.y += 0.5 * dt; if (b.pending && b.t >= 0) flakDetonate(b); }
    flakBursts = flakBursts.filter((b) => b.t < 14);
    if (state !== "PLAYING" || m.evaluated) return;
    // 1.4.1: over the target the sky fills — extra "show" salvos that burst around (never inside) the box: each burst
    // is kept >= 40 u from every ship (frag radius 24), so it's heavier to look at and to hear but balance-neutral
    if ((m.timeLeft <= MISSION_DOORS_AT && !m.bombsAway) || (m.bombsAway && (m.post || 0) < 10)) {
      const r2 = m.bombsAway ? 2.4 * (1 - (m.post || 0) / 10) : 1.2 + 2.4 * (1 - m.timeLeft / MISSION_DOORS_AT);
      m.flakAcc2 = (m.flakAcc2 || 0) + dt * r2 * (0.4 + 1.2 * Math.random());
      while (m.flakAcc2 >= 1) {
        m.flakAcc2 -= 1;
        for (let tries = 0; tries < 6; tries++) {
          const a = rand(0, TAU), rr = rand(120, 460);
          const x = BOX_C.x + Math.cos(a) * rr, y = BOX_C.y + rand(-70, 90), z = BOX_C.z + 80 + Math.sin(a) * rr * 1.2 + rand(0, 200);
          const dl = rand(0, 0.9), zd = z - VF * dl; // where it will actually burst (it streams aft until the fuze goes)
          let clear = Math.hypot(CAM.x - x, CAM.y - y, CAM.z - zd) > 45;
          for (const f of friendlies) { if (!clear) break; if (friendlyOk(f) && Math.hypot(f.x - x, f.y - y, f.z - zd) < 42) clear = false; }
          if (clear) { spawnFlakBurst(x, y, z, dl, F); F.show = (F.show || 0) + 1; break; }
        }
      }
    }
    const rate = flakRate(m);
    if (rate <= 0) return;
    m.flakAcc = (m.flakAcc || 0) + dt * rate / 4 * (0.35 + 1.3 * Math.random()); // salvos of ~4, ragged timing (1.4.0: no metronome)
    const B = m.flakB || (m.flakB = { ex: 0, ey: 0, ez: 0, err: 0 });
    while (m.flakAcc >= 1) {
      m.flakAcc -= 1;
      // the battery's aim error shrinks salvo by salvo ("walking in"); a fresh battery starts wide again
      if (B.err <= 0 || Math.random() < 0.12) { B.err = rand(260, 420); const a = rand(0, TAU); B.ex = Math.cos(a); B.ez = Math.sin(a); B.ey = rand(-1, 1); }
      else B.err = Math.max(18, B.err * rand(0.55, 0.8));
      const cx = BOX_C.x + B.ex * B.err + rand(-40, 40), cy = BOX_C.y + B.ey * B.err * 0.25 + rand(-18, 18), cz = BOX_C.z + 60 + B.ez * B.err + rand(-120, 300); // predicted fire: many salvos burst ahead (misses the box flies past), some right in it
      // 1.4.0: ragged salvos — 2–6 guns, uneven fuzes and spread, so bursts never line up as an even "string of beads"
      const nb = 2 + ((Math.random() * 5) | 0);
      for (let k = 0; k < nb; k++) spawnFlakBurst(cx + rand(-70, 70), cy + rand(-28, 28), cz + rand(-90, 90), rand(0, 1.4) * rand(0.3, 1), F);
    }
  }
  function spawnFlakBurst(x, y, z, delay, F) {
    const b = { id: ++flakSeq, x, y, z, t: -delay, seed: Math.random() * 1000, hit: false, size: 0.6 + Math.random() * 0.85 }; // 1.4.0: burst size varies
    flakBursts.push(b);
    if (flakBursts.length > 120) flakBursts.shift();
    b.pending = true;
    F.bursts++;
  }
  function flakDetonate(b) { // at t crossing 0
    b.pending = false;
    const F = mission.flakStats;
    if (window.FGAudio) window.FGAudio.flak(b.x, b.y, b.z);
    for (const f of friendlies) {
      if (!friendlyOk(f)) continue;
      const d = Math.hypot(f.x - b.x, f.y - b.y, f.z - b.z);
      if (d > FLAK.frag) continue;
      F.near++;
      if (d < FLAK.lethal && Math.random() < FLAK.blowChance) { // direct hit — blown apart
        F.blown++; F.lostF++;
        f.blownApart = true;
        downFriendly(f, "flak");
        f.health = -1; // nothing left to spiral down
        f.bailPlan = Math.random() < 0.25 ? [rand(0.8, 2)] : []; // rarely one man is thrown clear
        pushCallout((f.name || "FORTRESS") + " — DIRECT HIT! BLOWN APART!", 2.2, true);
        continue;
      }
      F.hitsF++;
      const k = 1 - d / FLAK.frag;
      flakDamage(f, k, 1);
      if (!friendlyOk(f)) F.lostF++;
    }
    if (bomber && !bomber.dead && !godMode) {
      const d = Math.hypot(CAM.x - b.x, CAM.y - b.y, CAM.z - b.z);
      if (d < 90) { gunner.shake = Math.max(gunner.shake, 1.5 * (1 - d / 90)); rumble = Math.max(rumble, 1 - d / 90); addKick('flak', 0.08 + 0.42 * Math.pow(1 - d / 90, 0.8)); if (d < 55) cabinHit(0.9 * (1 - d / 55) + 0.1, 'flak'); } // 1.5.4: a flak shaped kick (jolt + wobble) and, when close, cabin debris
      if (d < FLAK.frag + 4) {
        F.hitsP++;
        if (window.FGAudio) window.FGAudio.hitOwn("flak");
        bomber.flash = Math.max(bomber.flash || 0, 0.8);
        if (d < FLAK.lethal && Math.random() < FLAK.playerLethal) { if (window.FGAudio && window.FGAudio.earRing) window.FGAudio.earRing(1); injuredGunner(); playerShotDown("flak"); return; }
        const k = 1 - d / (FLAK.frag + 4);
        pushCallout("FLAK — WE'RE HIT!", 1.2, true);
        flakDamage(bomber, k, FLAK.playerMul);
        injuredGunner(); if (window.FGAudio && window.FGAudio.earRing) window.FGAudio.earRing(1); // 1.5.6: the ear-ring is tied to flak damage actually applied to OUR ship (once per run, ~10 s)
      } else if (d < 70) F.closeP++;
    }
  }

  // ===== 1.3.8: SHOT DOWN — death spiral from the turret → bail out → parachute view → debrief =====
  function setDownHud(chute) {
    for (const id of ["topbar", "missionbar", "healthwrap", "heatwrap"]) { const el = document.getElementById(id); if (el) el.style.visibility = chute ? "hidden" : ""; }
  }
  // 1.5.5: the 1.5.4 beta 1 % hull floor is REMOVED — the player's Fortress can be shot down / bail out again (1.5.3 behaviour).
  function playerShotDown(cause) {
    if (!bomber || bomber.dead || !mission) return;
    bomber.dead = true;
    bomber.health = 0;
    input.fire = false;
    mission.friendliesLost++;
    const side = Math.random() < 0.5 ? -1 : 1;
    const order = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
    downSeq = {
      T: 0, phase: "fall", cause, side: bomber.deathKind === "wing" ? bomber.deathSide : side, kind: bomber.deathKind || "tail", wside: bomber.deathSide || 0, missionT: mission.t, bombed: !!mission.bombsAway,
      ship: { x: CAM.x, y: CAM.y, z: CAM.z, vx: 0, vy: 0, vz: 0, roll: viewRoll || 0, rollV: 0, pd: 0, yaw: 0 },
      chute: null, sway: 0, engOut: order.map((i, k) => ({ i, t: 0.9 + k * 1.5 + Math.random() * 0.6 })),
      crew: [], callBail: false, finished: false,
    };
    for (const e of bomber.engines) if (!e.out) e.fire = Math.max(e.fire, 0.45);
    pushCallout(cause === "own" ? "WE'VE SHOT OURSELVES TO PIECES — SHE'S GOING DOWN!" : cause === "flak" ? "FLAK — DIRECT HIT — SHE'S GOING DOWN!" : "WE'RE HIT BAD — SHE'S GOING DOWN!", 2.4, true);
    if (window.FGAudio && window.FGAudio.fallStart) window.FGAudio.fallStart(cause);
    rumble = 1; gunner.shake = 1.6;
  }
  function updateDownSeq(dt) {
    const D = downSeq; if (!D || D.phase === "done") return;
    D.T += dt;
    const S = D.ship, tf = D.T;
    // the ship: rolls into a spiral, noses down, falls away below and aft of the box (box frame)
    S.rollV = D.side * Math.min(0.8, 0.1 + 0.26 * tf);
    S.roll += S.rollV * dt;
    S.pd = Math.min(0.55, 0.075 * tf);
    S.yaw += D.side * Math.min(0.3, 0.05 * tf) * dt;
    if (D.phase === "fall") {
      S.vy = -Math.min(70, 1.5 + 6.5 * tf);
      S.vz = -Math.min(40, 4.2 * tf);
      S.vx = D.side * Math.min(16, 2.6 * tf);
    } else {
      // 1.4.1: under the canopy we watch her go — a burning spiral dive that stays in view for ~30–40 s:
      // she sinks ~45 m/s, still has a little forward airspeed, and corkscrews round a wide circle.
      const ct = D.chute ? D.chute.t : 0;
      S.vy += (-(21 + Math.min(7, ct * 0.2)) - S.vy) * Math.min(1, 0.6 * dt);
      S.vz += (((D.chute ? D.chute.vz : -(VF - 10)) + 5) - S.vz) * Math.min(1, 0.5 * dt);
      const w = 0.32, a = ct * w * D.side;
      S.vx += (Math.cos(a) * 20 * D.side - S.vx) * Math.min(1, 0.8 * dt);
      S.vz += Math.sin(a) * 14 * dt;
      // pitch steepens; once the tail is gone she noses over hard and the spin winds up
      S.pdC = (S.pdC == null ? S.pd : S.pdC); S.pdC += (((S.tailOff ? 1.15 : S.wingOff ? 0.95 : 0.7)) - S.pdC) * Math.min(1, (S.tailOff ? 0.35 : S.wingOff ? 0.25 : 0.08) * dt); S.pd = S.pdC;
      if (S.wingOff) { S.roll += D.side * 1.5 * dt; S.vy += -Math.min(8, (ct + 3) * 0.7) * dt * 0.6; }
      if (S.tailOff) { S.roll += D.side * Math.min(1.1, 0.25 * (ct - S.tailOffT)) * dt; S.vy += -Math.min(8, (ct - S.tailOffT) * 0.8) * dt * 0.6; }
      if (D.kind === "tail" && !S.tailOff && ct > 3.8) { S.tailOff = true; S.tailOffT = ct; pushCallout("SHE'S BREAKING UP — THE TAIL'S GONE", 1.8, true); if (window.FGAudio && window.FGAudio.structure) window.FGAudio.structure("tailOff"); } // the tail tears off; world3d throws it clear with debris
      S.burn = Math.min(1, 0.6 + ct * 0.03);
    }
    if (D.kind === "wing") { // 1.5.2: the wing folds off at the root; she rolls hard toward the missing side
      if (!S.wingOff && tf >= 1.5) { S.wingOff = D.wside || 1; S.wingOffT = tf; S.burn = 0.7; pushCallout("SHE'S LOST A WING!", 1.8, true); if (window.FGAudio && window.FGAudio.structure) window.FGAudio.structure("wingOff"); gunner.shake = Math.max(gunner.shake, 1.4); rumble = 1; if (window.FGAudio && window.FGAudio.boom) window.FGAudio.boom(EYE.x, EYE.y, EYE.z, true); }
      if (S.wingOff) { const k = Math.min(1, (tf - S.wingOffT) / 1.5); S.roll += D.side * (0.9 + 1.6 * k) * dt; S.vy -= 5 * dt; S.vx += D.side * 2.5 * dt; }
    } else if (D.kind === "fire") { // engine-fire spiral: airframe stays whole, burning hard, in a tightening spiral
      S.burn = Math.max(S.burn || 0, Math.min(1, 0.25 + tf * 0.12));
      S.roll += D.side * 0.45 * dt;
      if (!D.fireCall && tf > 1.2) { D.fireCall = true; pushCallout("ENGINES ON FIRE — SHE'S IN A SPIN!", 1.8, true); }
    }
    S.x += S.vx * dt; S.y += S.vy * dt; S.z += S.vz * dt;
    // engines die one by one (burning, then out) → the audio winds each one down
    for (const q of D.engOut) {
      const e = bomber.engines[q.i];
      if (D.T >= q.t && !e.out) { e.out = true; e.fire = Math.random() < 0.6 ? 0.8 : 0.4; }
      else if (!e.out) e.fire = Math.max(e.fire, 0.5);
    }
    if (D.phase === "fall") {
      viewRoll = S.roll;
      EYE.x = S.x; EYE.y = S.y; EYE.z = S.z;
      gunner.shake = Math.max(gunner.shake, 0.35 + 0.2 * Math.sin(D.T * 7));
      if (!D.callBail && D.T > 4.2) { D.callBail = true; pushCallout("BAIL OUT! BAIL OUT! — THE BELL'S RINGING", 2.6, true); if (window.FGAudio && window.FGAudio.bell) window.FGAudio.bell(); }
      if (D.T >= FALL_T) bailOut();
      return;
    }
    // chute phase: we hang under the canopy; the air mass carries us aft of the box at -VF
    const C = D.chute;
    C.t += dt;
    const open = C.t > 1.3;
    if (!open) { C.vy = Math.max(-38, C.vy - 6.5 * dt); C.vz += (-VF - C.vz) * 0.35 * dt; C.vx *= Math.pow(0.6, dt); }
    else {
      if (!C.opened) { C.opened = true; gunner.shake = 1.4; rumble = 1; if (window.FGAudio && window.FGAudio.chuteOpen) window.FGAudio.chuteOpen(); pushCallout("CANOPY OPEN", 1.6); }
      C.vy += (-4 - C.vy) * Math.min(1, 2.4 * dt); C.vz += (-VF - C.vz) * Math.min(1, 1.1 * dt); C.vx *= Math.pow(0.4, dt);
    }
    C.x += C.vx * dt; C.y += C.vy * dt; C.z += C.vz * dt;
    D.sway = open ? Math.sin(C.t * 1.25) * 0.055 * Math.min(1, (C.t - 1.3) * 0.8) + Math.sin(C.t * 0.43) * 0.02 : Math.sin(C.t * 9) * 0.3;
    viewRoll = D.sway;
    EYE.x = C.x + (open ? Math.sin(C.t * 1.25) * 0.25 : 0); EYE.y = C.y; EYE.z = C.z;
    for (const q of D.crew) if (!q.done && C.t >= q.t) { q.done = true; spawnChute(S.x + rand(-3, 3), S.y + rand(-1, 1), S.z + rand(-4, 2), S.vx * 0.6, S.vy * 0.6, S.vz * 0.6, "us", rand(1.0, 2.2)); }
    // 1.4.0: END MISSION appears once we're hanging under an open canopy; nothing forces the end until the long cap
    if (endBtn) { const show = open && C.t > 2.6 && !D.finished; if (show !== !endBtn.classList.contains("hidden")) endBtn.classList.toggle("hidden", !show); }
    if (D.T >= FALL_T + CHUTE_T) finishDownSeq();
  }
  function bailOut() {
    const D = downSeq, S = D.ship;
    D.phase = "chute";
    D.chute = { x: S.x + D.side * 2, y: S.y - 1, z: S.z - 2, vx: S.vx, vy: S.vy * 0.8, vz: S.vz, t: 0, opened: false };
    // four to six more of the crew get out after us (the rest don't)
    const n = 4 + ((Math.random() * 3) | 0);
    for (let k = 0; k < n; k++) D.crew.push({ t: 0.4 + k * rand(0.5, 1.1), done: false });
    // look back up at the box
    // 1.4.1: look down at our own ship going down (the crew's chutes pop out around her); the box is above
    const bx = S.x + S.vx * 3 - D.chute.x, by = S.y + S.vy * 3 - D.chute.y, bz = S.z + (S.vz + VF) * 3 - D.chute.z;
    gunner.yaw = wrapYaw(Math.atan2(bx, bz)); gunner.pitch = clampPitch(Math.max(-1.0, Math.atan2(by, Math.hypot(bx, bz)) * 0.75));
    input.fire = false;
    callouts = []; // the intercom is gone
    setDownHud(true);
    if (window.FGAudio && window.FGAudio.bail) window.FGAudio.bail();
    pushCallout("YOU'RE OUT — PULL THE RIPCORD", 1.6, true);
  }
  function finishDownSeq() {
    const D = downSeq; if (!D || D.finished) return;
    D.finished = true; D.phase = "done";
    if (endBtn) endBtn.classList.add("hidden");
    const A = window.FGAudio;
    if (mission.evaluated && mission.pendingWon != null) { if (A && A.results) A.results(); endMission(mission.pendingWon); return; }
    // the battle goes on without us: finish the mission silently to get the real outcome
    if (A && A.mute) A.mute(true);
    const was = update._inAdvance; update._inAdvance = true;
    let guard = 0;
    while (state === "PLAYING" && guard++ < 12000) update(1 / 30);
    update._inAdvance = was;
    if (A && A.mute) A.mute(false);
    if (A && A.results) A.results();
    if (state === "PLAYING") endMission(mission.bombersDropped >= MISSION_WIN_DROPS);
  }
  // parachutes (box frame): free-fall a moment, canopy opens, then drift down at ~6 m/s with the air
  function spawnChute(x, y, z, vx, vy, vz, kind, openAt) {
    if (chutes.length > 70) chutes.shift();
    chutes.push({ id: ++chuteSeq, x, y, z, vx, vy, vz, kind, t: 0, openAt: openAt || rand(1.0, 2.5), open: 0, ph: Math.random() * 6 });
    if (mission) mission.chutes = (mission.chutes || 0) + 1;
  }
  function updateChutes(dt) {
    for (const c of chutes) {
      c.t += dt;
      if (c.t < c.openAt) { c.vy = Math.max(-38, c.vy - 6.5 * dt); c.vz += (-VF - c.vz) * 0.35 * dt; c.vx *= Math.pow(0.6, dt); }
      else {
        c.open = Math.min(1, c.open + dt / 1.1);
        c.vy += (-4 - c.vy) * Math.min(1, 2.2 * dt); c.vz += (-VF - c.vz) * Math.min(1, 1.0 * dt); c.vx *= Math.pow(0.4, dt);
      }
      c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;
    }
    chutes = chutes.filter((c) => c.t < 150 && c.y > -1350 && c.z > -6000);
  }

  function endGame() {
    state = "GAMEOVER";
    input.fire = false;
    if (guns.fireWas) { guns.fireWas = false; if (window.FGAudio && window.FGAudio.gunRelease) window.FGAudio.gunRelease(); }
    const survived = Math.floor(timeAlive);
    goEyebrow.textContent = bomber.health <= 0 ? "FORTRESS DOWN" : "MISSION OVER";
    goTitle.textContent = bomber.health <= 0 ? "BAIL OUT" : "RTB";
    goStats.innerHTML =
      "Score <b>" + score + "</b> · Kills <b>" + kills + "</b> · Wave <b>" + wave +
      "</b><br>Time " + survived + "s · Hits " + hitsLanded;
    gameoverEl.classList.remove("hidden"); { const pn = gameoverEl.querySelector(".panel"); if (pn) pn.scrollTop = 0; }
    updateHud();
  }

  // ----- update -----
  function update(dt) {
    window.__FG_SIMT = (window.__FG_SIMT || 0) + dt; // 1.3.9: sim clock for the tracer persistence smear
    elapsed += dt;
    if (window.FGAudio && !update._inAdvance) { const b = lookBasis(); window.FGAudio.frame({ playing: state === "PLAYING", firing: !!(input.fire && !guns.overheated), listener: { fx: b.fx, fy: b.fy, fz: b.fz, rx: b.rx, ry: b.ry, rz: b.rz, cx: EYE.x, cy: EYE.y, cz: EYE.z }, engines: bomber ? bomber.engines : null, fighters: enemies.filter((q) => q.alive), down: downSeq ? downSeq.phase : null, chuteT: downSeq && downSeq.chute ? downSeq.chute.t : 0, boxDist: Math.hypot(EYE.x - BOX_C.x, EYE.y, EYE.z - 20), holes: bomber ? Math.max(bomber.holes.length, bomber.holeN || 0) : 0 }); }
    if (state === "TITLE") {
      gunner.yaw = 0.25 + Math.sin(elapsed * 0.18) * 0.35;
      gunner.pitch = 0.10 + Math.sin(elapsed * 0.11) * 0.05;
      updateWorld(dt, true);
      return;
    }
    if (state === "GAMEOVER") {
      updateWorld(dt, true);
      return;
    }

    timeAlive += dt;
    applyAim(dt);
    onTarget = MISSION_MODE ? false : !!screenHitscan();
    if (downSeq) input.fire = false;
    tryFire(dt);
    { const firingNow = !!(input.fire && !guns.overheated); if (guns.fireWas && !firingNow && window.FGAudio && window.FGAudio.gunRelease) window.FGAudio.gunRelease(); guns.fireWas = firingNow; } // 1.5.6: trigger released / jammed / cut → the gun's end sound (audio plays it once, and only if rounds were fired)
    for (let i = 0; i < 2; i++) {
      guns.recoilLR[i] = Math.max(0, guns.recoilLR[i] - dt * 9);
      guns.flashLR[i] = Math.max(0, guns.flashLR[i] - dt * 13);
    }

    guns.heat = Math.max(0, guns.heat - dt * (guns.overheated ? 0.36 : 0.22));
    if (guns.overheated && guns.heat <= 0.22) guns.overheated = false;
    gunner.recoil = Math.max(0, gunner.recoil - dt * 4.2);
    // Cycle 136: hold strobe between shots in a burst
    guns.muzzle = Math.max(0, guns.muzzle - dt * 5.5);
    if (bomber) bomber.flash = Math.max(0, (bomber.flash || 0) - dt * 2.8);
    // Cycle 135: sustained burst keeps rattle up; release decays fast
    const shakeDecay = (input.fire && !guns.overheated) ? 0.35 : 0.01;
    gunner.shake *= Math.pow(shakeDecay, dt);
    if (bomber && bomber.health < 20) gunner.shake = Math.max(gunner.shake, 0.15 + Math.sin(elapsed * 25) * 0.08);
    rumble = Math.max(0, rumble - dt * 3);
    comboTimer -= dt;
    if (comboTimer <= 0) combo = 0;
    for (const m of hitMarks) m.life -= dt;
    hitMarks = hitMarks.filter((m) => m.life > 0);
    for (const c of brass) {
      c.vy += 900 * dt; c.x += c.vx * dt; c.y += c.vy * dt; c.rot += c.spin * dt; c.life -= dt;
    }
    brass = brass.filter((c) => c.life > 0 && c.y < H + 40);
    for (const c of muzzleSmoke) {
      c.x += c.vx * dt; c.y += c.vy * dt; c.vx *= 0.96; c.vy -= 20 * dt; c.life -= dt; c.r += 18 * dt;
    }
    muzzleSmoke = muzzleSmoke.filter((c) => c.life > 0);
    if (muzzleSmoke.length > 36) muzzleSmoke.splice(0, muzzleSmoke.length - 36);
    if (particles.length > 150) particles.splice(0, particles.length - 150);
    if (brass.length > 42) brass.splice(0, brass.length - 42);
    for (const c of brass) c.tumble = (c.tumble || 0) + (c.tspin || 0) * dt;
    setBedAudio(state === "PLAYING" ? (bomber && bomber.health < 30 ? 1 : 0.55) + (input.fire ? 0.35 : 0) : 0.25);

    if (bomber && bomber.health < 30 && Math.floor(timeAlive * 2) % 4 === 0) {
      if (!callouts.some((c) => c.text.indexOf("CRITICAL") >= 0))
        if (!bomber.dead) pushCallout("FORTRESS CRITICAL", 0.8);
    }
    if (wavePause > 0) {
      wavePause -= dt;
      if (wavePause <= 0) startWave();
    }
    if (intercomCd > 0) intercomCd -= dt;
    // Wingman stagger complete
    if (pendingPair) {
      pendingPair.t -= dt;
      if (pendingPair.t <= 0) {
        const p = pendingPair;
        pendingPair = null;
        spawnEnemy(p.type, {
          type: p.type, passSide: p.passSide, style: p.style,
          pairId: p.pairId, pairRole: "wing", muteCall: true, offset: p.offset,
        });
      }
    }
    if (spawnQueue > 0) {
      spawnTimer -= dt;
      if (spawnTimer <= 0 && !pendingPair) {
        // MotA: usually boom-zoom as a pair on same lane
        if (spawnQueue >= 2 && Math.random() < 0.85) {
          enqueuePair();
          spawnQueue -= 2;
        } else {
          spawnEnemy();
          spawnQueue--;
        }
        spawnTimer = rand(0.85, 1.55);
      }
    } else if (!MISSION_MODE && wavePause <= 0 && enemies.every((e) => !e.alive) && !pendingPair) {
      wave++;
      wavePause = 0.95;
      score += 150 * (wave - 1);
      pushCallout("WAVE CLEAR", 1.1);
    }

    if (MISSION_MODE) updateMission(dt);
    if (downSeq && state === "PLAYING") updateDownSeq(dt);
    updateWorld(dt, false);
    updateHud();
    if (callouts.length) {
      callouts[0].life -= dt;
      for (let k = 1; k < callouts.length; k++) callouts[k].age += dt;
      if (callouts[0].life <= 0) {
        callouts.shift();
        // chatter that waited > 3 s is stale — drop it
        for (let k = callouts.length - 1; k >= 0; k--) if (!callouts[k].important && callouts[k].age > 3) callouts.splice(k, 1);
        showCallout(callouts[0]);
      }
    } else if (calloutEl.textContent) {
      calloutEl.textContent = "";
      calloutEl.classList.remove("urgent");
    }
  }

  // 1.3.3: DIRECT look. Drag deltas are applied to yaw/pitch in the pointer handler the
  // moment they arrive (1:1, no smoothing, no velocity, no coast). Yaw wraps forever.
  function wrapYaw(a) {
    a = (a + Math.PI) % TAU;
    if (a < 0) a += TAU;
    return a - Math.PI;
  }
  function clampPitch(p) { return clamp(p, PITCH_MIN, PITCH_MAX); }
  function lookRadPerPx() {
    // finger across the full screen width ≈ 2.2× the horizontal field of view
    const hfov = 2 * Math.atan(Math.tan(FOV * 0.5) * (W / Math.max(1, H)));
    return (2.2 * hfov) / Math.max(320, W);
  }
  function applyLookDelta(dxPx, dyPx) {
    const k = lookRadPerPx();
    // lookXSign = -1: drag right → look right (3D camera-right = world -X)
    gunner.yaw = wrapYaw(gunner.yaw - dxPx * k);
    gunner.pitch = clampPitch(gunner.pitch - dyPx * k);
  }
  function applyAim(dt) {
    // keyboard (desktop) only: constant rate while held, stops dead on release
    let ax = 0, ay = 0;
    if (input.keys["arrowleft"] || input.keys["a"]) ax += 1;
    if (input.keys["arrowright"] || input.keys["d"]) ax -= 1;
    if (input.keys["arrowup"] || input.keys["w"]) ay += 1;
    if (input.keys["arrowdown"] || input.keys["s"]) ay -= 1;
    gunner.yawV = 0; gunner.pitchV = 0;
    if (ax || ay) {
      gunner.yaw = wrapYaw(gunner.yaw + ax * 1.4 * dt);
      gunner.pitch = clampPitch(gunner.pitch + ay * 1.0 * dt);
    }
  }

  function updateWorld(dt, idle) {
    // clouds drift (bomber flying forward)
    for (const c of clouds) {
      c.z -= CLOUD_SCROLL * dt;
      if (c.z < -400) {
        c.z = rand(500, 900);
        c.x = rand(-900, 900);
        c.y = rand(40, 220);
      }
    }
    for (const f of flak) {
      f.age += dt;
      if (f.age > 3.8) {
        f.x = rand(-450, 450); f.y = rand(20, 180); f.z = rand(100, 750);
        f.age = 0; f.r = rand(10, 26);
      }
    }

    if (idle) return;

    // 1.3.4: the old box-relative perch/orbit fighter loop is gone — every 109 is flown by the
    // air-frame flight model in missionFighterLoop (no fixed offsets, no hovering).
    missionFighterLoop(dt);
    updateChutes(dt);
    updateFlakSim(dt);
    // Fade persistent MotA sky contrails
    for (const tr of skyTrails) tr.life -= dt;
    skyTrails = skyTrails.filter((tr) => tr.life > 0);
    // Formation update handled in updateMission / updateFormation
    if (!MISSION_MODE) enemies = enemies.filter((e) => e.alive || e.flash > 0);

    for (const b of bullets) {
      balStep(b, dt); // 1.3.9: gravity + drag; the hit test sweeps this same curved path (px→x)
      b.trav = (b.trav || 0) + Math.hypot(b.x - b.px, b.y - b.py, b.z - b.pz);
      b.life -= dt;
      if (b.life > 0 && hitTestBullet(b, dt)) b.life = 0;
    }
    bullets = bullets.filter((b) => b.life > 0);

    for (const p of particles) {
      if (p.wait > 0) { p.wait -= dt; continue; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.vy -= (p.kind === "flash" || p.kind === "bloom") ? 0 : 6 * dt;
      p.life -= dt;
    }
    stepFx154(dt);
    particles = particles.filter((p) => p.life > 0);

    for (const t of tracers) {
      if (t.delay > 0) { // staggered burst: rides the gun until its turn
        t.delay -= dt;
        if (t.src) { t.x = t.src.x; t.y = t.src.y; t.z = t.src.z; }
        continue;
      }
      if (t.vx != null) {
        balStep(t, dt); // 1.3.9: same gravity + drag as ours
        t.trav = (t.trav || 0) + Math.hypot(t.x - t.px, t.y - t.py, t.z - t.pz);
        if (t.team === "allied" && t.shooter && t.trav > 6) { // stray CPU rounds can strike friends
          const fh = hitFriendlySeg(t.px, t.py, t.pz, t.x, t.y, t.z, t.shooter, true); // 1.3.8: box gunners' strays vs the real, banked mesh too
          if (fh) { friendlyFireHit(fh, TUNE.ffCpuDmg, false); t.life = 0; continue; }
          const mh = hitMustangSeg(t.px, t.py, t.pz, t.x, t.y, t.z); // 1.5.3: ...and the Mustangs
          if (mh) { ffMustang(mh.e, mh.fh, "gun"); t.life = 0; continue; }
        }
      }
      t.life -= dt;
    }
    tracers = tracers.filter((t) => t.life > 0);
    if (tracers.length > 900) tracers.splice(0, tracers.length - 900);
    for (const t of tracers) if (t.life <= 0) t.src = null;

    if (bomber && !(World3D && World3D.modelsReady) && !MISSION_MODE) {
      const critMul = bomber.health < 30 ? 2.2 : 1;
      for (const eng of bomber.engines) {
        if (bomber.health < 25) eng.fire = Math.max(eng.fire, 0.45 + (25 - bomber.health) * 0.02);
        if (eng.fire > 0 && Math.random() < dt * 8 * critMul) {
          particles.push({
            x: eng.x + rand(-1, 1), y: eng.y + 1.2, z: eng.z,
            vx: rand(-3, 3), vy: rand(4, 12), vz: rand(-8, -2),
            life: rand(0.4, 0.9), max: 0.9, kind: "fire", r: rand(2, 5),
          });
        }
        if (bomber.health < 25 && Math.random() < dt * 3) {
          particles.push({
            x: eng.x + rand(-2, 2), y: eng.y, z: eng.z,
            vx: rand(-6, 6), vy: rand(-2, 4), vz: rand(-12, -4),
            life: rand(0.5, 1.0), max: 1.0, kind: "smoke", r: rand(3, 7),
          });
        }
      }
    }
  }

  // ----- render -----
  // 1.3.8: overlay for the death spiral / parachute ride (risers, canopy shadow, skip hint)
  function drawDownOverlay(inChute) {
    const D = downSeq; if (!D || D.finished || state !== "PLAYING") return; // results screen: no overlay / skip hint
    ctx.save();
    if (!inChute) { // spinning down: red-dark edge pulse + smoke haze creeping over the glass
      const a = 0.18 + 0.12 * Math.sin(D.T * 5);
      const vg = ctx.createRadialGradient(W * 0.5, H * 0.5, H * 0.35, W * 0.5, H * 0.5, H * 1.0);
      vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(40,8,4," + a.toFixed(3) + ")");
      ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
    } else {
      const C = D.chute, open = C && C.t > 1.3;
      // two risers from the shoulders up to the canopy, fading upward; swing with the sway
      const sw = (D.sway || 0) * H * 1.5, top = open ? -H * 0.1 : H * 0.2;
      const u = Math.min(W, H) / 412;
      for (const sgn of [-1, 1]) {
        const g = ctx.createLinearGradient(0, H, 0, 0);
        g.addColorStop(0, "rgba(60,54,40,0.85)"); g.addColorStop(0.7, "rgba(80,74,60,0.45)"); g.addColorStop(1, "rgba(90,86,74,0)");
        ctx.strokeStyle = g; ctx.lineWidth = 7 * u; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(W * 0.5 + sgn * W * 0.47, H + 4); ctx.lineTo(W * 0.5 + sgn * W * 0.36 + sw, top); ctx.stroke();
        ctx.lineWidth = 1.2 * u; ctx.strokeStyle = "rgba(210,205,190,0.25)";
        ctx.beginPath(); ctx.moveTo(W * 0.5 + sgn * W * 0.47 - sgn * 3 * u, H + 4); ctx.lineTo(W * 0.5 + sgn * W * 0.36 + sw - sgn * 2 * u, top); ctx.stroke();
      }
      // soft canopy shade at the top edge
      const cg = ctx.createLinearGradient(0, 0, 0, H * 0.18);
      cg.addColorStop(0, "rgba(230,226,212," + (open ? 0.16 : 0.05) + ")"); cg.addColorStop(1, "rgba(230,226,212,0)");
      ctx.fillStyle = cg; ctx.fillRect(0, 0, W, H * 0.18);
    }
    void SKIP_AT;
    if (inChute) {
      { // 1.4.1: dark backing plate so the text reads over bright cloud / canopy
        const f1 = Math.round(Math.max(11, H * 0.034)), lh = Math.round(Math.max(13, H * 0.042)), two = D.chute && D.chute.t > 2.6;
        ctx.font = "600 " + f1 + "px system-ui, sans-serif";
        const w1 = ctx.measureText("THE BOX IS 00.0 KM AWAY · 00,000 FT").width * 0.9 + 26;
        const x0 = 6, y0 = 26 - f1 - 6, hh = f1 + 12 + (two ? lh : 0);
        ctx.fillStyle = "rgba(12,12,10,0.55)"; ctx.strokeStyle = "rgba(210,200,170,0.18)"; ctx.lineWidth = 1;
        ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x0, y0, w1, hh, 5); else ctx.rect(x0, y0, w1, hh); ctx.fill(); ctx.stroke();
      }
      ctx.textAlign = "left"; ctx.font = "600 " + Math.round(Math.max(11, H * 0.034)) + "px system-ui, sans-serif";
      ctx.fillStyle = "rgba(235,230,215,0.8)";
      ctx.fillText("SHOT DOWN — BAILED OUT", 16, 26);
      const C = D.chute;
      if (C && C.t > 2.6) { // the box flying on without us
        const bd = Math.hypot(BOX_C.x - EYE.x, BOX_C.y - EYE.y, BOX_C.z - EYE.z) * 1.5 / 1000;
        ctx.font = "500 " + Math.round(Math.max(10, H * 0.028)) + "px system-ui, sans-serif"; ctx.fillStyle = "rgba(235,230,215,0.62)";
        ctx.fillText("THE BOX IS " + bd.toFixed(1) + " KM AWAY · " + (Math.round((25000 + (EYE.y - CAM.y) * 1.5 / 0.3048) / 100) * 100).toLocaleString("en-US") + " FT", 16, 26 + Math.round(Math.max(13, H * 0.042)));
      }
    }
    ctx.restore();
  }

  function draw() {
    const inChute = !!(downSeq && (downSeq.phase === "chute" || (downSeq.phase === "done" && state !== "GAMEOVER")));
    const use3d = World3D && World3D.ready;
    const models3d = use3d && World3D.modelsReady;
    if (use3d) {
      World3D.sync(enemies, gunner, clouds);
      if (models3d && World3D.setTracers) { const n = fillTracerBuf(); World3D.setTracers(tracerBuf, n); }
      World3D.render();
      ctx.clearRect(0, 0, W, H);
      // soft atmospheric haze only (no tiled ground wash)
      const hy = H * 0.78;
      const haze = ctx.createLinearGradient(0, hy, 0, H);
      if (!models3d) {
        haze.addColorStop(0, "rgba(120,140,160,0)");
        haze.addColorStop(0.4, "rgba(90,100,80,0.12)");
        haze.addColorStop(1, "rgba(20,24,18,0.35)");
        ctx.fillStyle = haze;
        ctx.fillRect(0, hy, W, H - hy);
      }
      // Friendlies (far) → contrails → 3D bandits show through canvas (near slash)
      // 1.3.1: friendlies, contrails, clouds, town are real 3D now
      // 3D fighters are primary — do NOT overlay atlas cardboard
      if (!models3d) drawEnemies();
    } else {
      ctx.fillStyle = "#0b1520";
      ctx.fillRect(0, 0, W, H);
      drawSky();
      drawHorizon();
      drawClouds();
      drawFriendlies();
      drawContrails();
      drawEnemies();
    }
    if (!models3d) drawFlak(); // 1.3.6: 3D flak (depth-tested black bursts) in world3d
    // 2D wing only as subtle cue when pitched down — never cover 3D turret
    if (!models3d) drawBomber();
    if (!models3d) drawBullets(); // 1.3.7: 3D mode draws tracers in world3d (depth-tested)
    drawParticles();
    if (!models3d) drawEnemyTracers();
    if (!models3d) {
      drawCanopy();
      drawTurretInterior();
      drawGuns();
    } else if (!inChute) {
      // light plexi dirt + vignette only — metal/glass come from GLTF
      drawPlexiOverlay();
    }
    drawMuzzleGrit();
    if (!models3d) drawBrass();
    if (!inChute) drawCabinFx();
    if (!downSeq) drawCrosshair(models3d && !inChute);
    if (!inChute) drawHitMarks();
    if (!models3d) drawFarFighters(); // 1.3.6: 3D mode draws far 109s as depth-tested GL specks
    if (!downSeq) { drawIncoming(); if (!mouse.desktop) drawControls(); } // 1.4.0-web: no touch hints on desktop
    if (downSeq) drawDownOverlay(inChute);
    // 1.3.2: flash lives at the barrel tips in 3D; only a faint warm kick at the bottom edge here
    if (guns.muzzle > 0.08 && state === "PLAYING") {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = "rgba(255,150,60," + (0.025 * guns.muzzle).toFixed(3) + ")";
      ctx.fillRect(0, H * 0.72, W, H * 0.28);
      ctx.restore();
    }
    // 1.5.1: CRISP — no colour-grade wash, no always-on film grain (grain only as hit grit)
    if (bomber && (bomber.flash > 0 || bomber.health < 30)) drawFilmGrain();
    if (state === "PLAYING" && guns.overheated) {
      // jam cue: thin red edge only (no full-screen wash)
      ctx.save();
      ctx.strokeStyle = "rgba(200,40,30,0.35)";
      ctx.lineWidth = 3;
      ctx.strokeRect(1.5, 1.5, W - 3, H - 3);
      ctx.restore();
    }
    if (state === "PLAYING" && bomber && bomber.health < 35 && !inChute) { // 1.4.0: not under the canopy
      ctx.save();
      const crit = bomber.health <= 15;
      // Soft edge vignette — do NOT nuke the whole frame red
      const vg = ctx.createRadialGradient(W*0.5, H*0.48, H*0.28, W*0.5, H*0.48, H*0.92);
      vg.addColorStop(0, "rgba(0,0,0,0)");
      vg.addColorStop(0.55, "rgba(0,0,0,0)");
      vg.addColorStop(1, crit ? "rgba(90,12,8,0.42)" : "rgba(60,10,8,0.28)");
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, W, H);
      if (crit) {
        ctx.globalAlpha = 0.12 + 0.08 * Math.sin(elapsed * 5);
        ctx.fillStyle = "rgba(180,30,20,0.18)";
        ctx.fillRect(0, 0, W, H * 0.08);
        ctx.fillRect(0, H * 0.92, W, H * 0.08);
        ctx.globalAlpha = 1;
        ctx.fillStyle = "rgba(255,210,140,0.85)";
        ctx.font = "bold 13px sans-serif";
        ctx.textAlign = "center";
        /* 1.3.1: HP shown in HUD bar; no center text over the fight */
      }
      ctx.restore();
    }
  }

    function drawSky() {
    if (assets.sky) {
      const iw = assets.sky.width, ih = assets.sky.height;
      // yaw wraps horizontally across the cropped sky strip
      const u = ((gunner.yaw / Math.PI) * 0.5 + 0.5 + 1) % 1;
      const v = clamp(0.08 - gunner.pitch * 0.22, 0.0, 0.42);
      const sw = iw * 0.42, sh = ih * 0.72;
      let sx = u * (iw - sw);
      const sy = v * Math.max(1, ih - sh);
      ctx.drawImage(assets.sky, sx, sy, sw, sh, 0, 0, W, H);
      // slight cool altitude grade (not muddy purple wash)
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, "rgba(20,50,90,0.12)");
      g.addColorStop(0.55, "rgba(255,255,255,0)");
      g.addColorStop(1, "rgba(40,50,35,0.18)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    } else {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, "#4a7aaa");
      g.addColorStop(0.28, "#7aa4c4");
      g.addColorStop(0.55, "#c4b08a");
      g.addColorStop(0.78, "#d4b07a");
      g.addColorStop(1, "#8a7a58");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    // high cirrus streaks for depth
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.strokeStyle = "#e8e4dc";
    ctx.lineWidth = 2;
    for (let i = 0; i < 5; i++) {
      const yy = H * (0.08 + i * 0.06) + gunner.pitch * 20;
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.bezierCurveTo(W * 0.3, yy - 8, W * 0.6, yy + 10, W, yy - 4 + i);
      ctx.stroke();
    }
    ctx.restore();
    const sunX = W * (0.72 - gunner.yaw * 0.12);
    const sunY = H * (0.42 + gunner.pitch * 0.15);
    const rg = ctx.createRadialGradient(sunX, sunY, 4, sunX, sunY, H * 0.45);
    rg.addColorStop(0, "rgba(255,220,140,0.85)");
    rg.addColorStop(0.12, "rgba(255,190,90,0.35)");
    rg.addColorStop(1, "rgba(255,180,80,0)");
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, H);
  }

  function drawHorizon() {
    const p0 = project(-800, -8, 900);
    const p1 = project(800, -8, 900);
    if (p0 && p1) {
      const hy = clamp((p0.sy + p1.sy) * 0.5, H * 0.42, H * 0.92);
      if (assets.ground) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(0, H); ctx.lineTo(W, H); ctx.lineTo(W, hy); ctx.lineTo(0, hy); ctx.closePath();
        ctx.clip();
        const parallax = (-gunner.yaw * 80) % 256;
        ctx.globalAlpha = 0.75;
        for (let x = -256 + parallax; x < W + 256; x += 256) {
          for (let y = hy; y < H; y += 256) {
            const scale = 1 + (y - hy) / (H - hy + 1);
            ctx.drawImage(assets.ground, x, y, 256 * scale, 256 * scale);
          }
        }
        ctx.globalAlpha = 1;
        const haze = ctx.createLinearGradient(0, hy, 0, H);
        haze.addColorStop(0, "rgba(160,180,200,0.35)");
        haze.addColorStop(0.35, "rgba(90,100,70,0.25)");
        haze.addColorStop(1, "rgba(30,40,25,0.55)");
        ctx.fillStyle = haze;
        ctx.fillRect(0, hy, W, H - hy);
        ctx.restore();
      } else {
        const ground = ctx.createLinearGradient(0, hy, 0, H);
        ground.addColorStop(0, "rgba(120,100,60,0.55)");
        ground.addColorStop(0.35, "rgba(70,85,45,0.5)");
        ground.addColorStop(1, "rgba(40,50,30,0.65)");
        ctx.fillStyle = ground;
        ctx.fillRect(0, hy, W, H - hy);
      }
    }
  }

  function drawClouds() {
    const sorted = clouds.slice().sort((a, b) => b.z - a.z);
    for (const c of sorted) {
      const p = project(c.x, c.y, c.z);
      if (!p) continue;
      ctx.globalAlpha = c.a;
      ctx.fillStyle = c.layer ? "#d8d2c4" : "#f4f0e6";
      ctx.beginPath();
      const cw = Math.min(180, c.s * p.s * 0.38), ch = Math.min(80, c.s * p.s * 0.18);
      ctx.ellipse(p.sx, p.sy, cw, ch, 0, 0, TAU);
      ctx.ellipse(p.sx - cw * 0.5, p.sy + 4, cw * 0.62, ch * 0.75, 0, 0, TAU);
      ctx.ellipse(p.sx + cw * 0.55, p.sy + 2, cw * 0.55, ch * 0.7, 0, 0, TAU);
      ctx.ellipse(p.sx + cw * 0.1, p.sy - ch * 0.4, cw * 0.45, ch * 0.55, 0, 0, TAU);
      ctx.fill();
      // soft undershadow
      ctx.globalAlpha = c.a * 0.25;
      ctx.fillStyle = "#8a8070";
      ctx.beginPath();
      ctx.ellipse(p.sx, p.sy + ch * 0.5, cw * 0.8, ch * 0.35, 0, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }


  function drawTargetCity() {
    if (!MISSION_MODE || !mission || !mission.cityVisible) return;
    // Simplified northern-European town + rail depot ahead on the ground plane
    const range = 180 + mission.timeLeft * 2.2; // approaches as clock runs
    const p = project(0, -35, Math.max(60, range));
    if (!p || p.z < 40) return;
    const sc = Math.max(0.4, Math.min(4.5, p.s * 2.2));
    ctx.save();
    ctx.translate(p.sx, p.sy);
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = "#3a4a32";
    ctx.fillRect(-40 * sc, -4 * sc, 80 * sc, 10 * sc);
    ctx.fillStyle = "#5a5040";
    for (let i = -3; i <= 3; i++) {
      ctx.fillRect((i * 10 - 3) * sc, -12 * sc, 6 * sc, 10 * sc);
    }
    // Rail depot
    ctx.fillStyle = "#6a5a40";
    ctx.fillRect(-8 * sc, -18 * sc, 16 * sc, 8 * sc);
    ctx.strokeStyle = "rgba(40,40,30,0.7)";
    ctx.lineWidth = Math.max(1, sc);
    ctx.beginPath();
    ctx.moveTo(-50 * sc, 2 * sc); ctx.lineTo(50 * sc, 2 * sc);
    ctx.moveTo(-50 * sc, 5 * sc); ctx.lineTo(50 * sc, 5 * sc);
    ctx.stroke();
    if (mission.doorsOpen && !mission.bombsAway) {
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = "#ffe08a";
      ctx.font = "bold " + Math.max(9, (8 * sc) | 0) + "px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("TARGET", 0, -22 * sc);
    }
    ctx.restore();
  }

  function drawBombBayCue() {
    return; // 1.3.1: shown in the DOM mission bar instead (#baystatus)
    if (!MISSION_MODE || !mission || !mission.doorsOpen || mission.bombsAway || state !== "PLAYING") return;
    ctx.save();
    const x = W * 0.5, y = 50;
    ctx.globalAlpha = 0.75 + 0.2 * Math.sin(elapsed * 5);
    ctx.fillStyle = "rgba(10,8,4,0.6)";
    ctx.fillRect(x - 44, y - 8, 88, 15);
    ctx.fillStyle = "#ffd060";
    ctx.font = "bold 9px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("BAY DOORS OPEN", x, y);
    ctx.restore();
  }


  function drawFlak() {
    // 1.3.2: flak only over the target run-in (fighters leave it to the 88s); black
    // bursts — brief orange flash, then an irregular dark puff that grows and fades.
    if (MISSION_MODE && (!mission || mission.timeLeft > 32 || (mission.post || 0) > 8)) return;
    for (let k = 0; k < flak.length; k++) {
      const f = flak[k];
      const p = project(f.x, f.y, f.z);
      if (!p) continue;
      const t = f.age;
      if (t > 3.2) continue;
      const grow = 0.45 + Math.min(1, t / 1.2) * 0.75;
      const rad = Math.min(34, f.r * p.s * 0.6 * grow);
      if (rad < 1) continue;
      const a = t < 0.15 ? 1 : Math.max(0, 1 - (t - 0.15) / 3.05);
      ctx.save();
      for (let l = 0; l < 4; l++) {
        const ang = k * 1.7 + l * 1.57, off = l ? rad * 0.42 : 0;
        const cx = p.sx + Math.cos(ang) * off, cy = p.sy + Math.sin(ang) * off * 0.7;
        const r = rad * (l ? 0.72 : 1);
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, "rgba(34,32,30," + (0.62 * a).toFixed(3) + ")");
        g.addColorStop(0.6, "rgba(48,45,42," + (0.4 * a).toFixed(3) + ")");
        g.addColorStop(1, "rgba(60,58,55,0)");
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
      }
      if (t < 0.15) {
        ctx.globalCompositeOperation = "lighter";
        const g = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, rad * 0.5);
        g.addColorStop(0, "rgba(255,210,140,0.9)");
        g.addColorStop(1, "rgba(255,120,30,0)");
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.sx, p.sy, rad * 0.5, 0, TAU); ctx.fill();
        if (Math.random() < 0.05) sfxFlak();
      }
      ctx.restore();
    }
  }


  function poly(pts, fill, stroke, width) {
    const pr = pts.map((q) => project(q[0], q[1], q[2]));
    if (pr.some((p) => !p)) return;
    ctx.beginPath();
    ctx.moveTo(pr[0].sx, pr[0].sy);
    for (let i = 1; i < pr.length; i++) ctx.lineTo(pr[i].sx, pr[i].sy);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = width || 1; ctx.stroke(); }
  }

  function drawBomber() {
    // First-person B-17: wings in the lower third, nose below the sight.
    const px = -gunner.yaw * (W * 0.36);
    const py = gunner.pitch * (H * 0.30);
    const jx = gunner.shake * 14;
    const jy = gunner.recoil * 12 + gunner.shake * 9;
    const olive = "#616844";
    const oliveD = "#3d432c";
    const oliveL = "#838a5c";
    const metal = "#5c5850";
    ctx.save();
    ctx.translate(px + jx, py + jy);
    if (bomber && bomber.list) ctx.rotate(bomber.list * 0.65);

    const lead = H * 0.70;
    const trail = H * 0.98;
    const midX = W * 0.5;

    // wings (perspective: leading edge narrower / higher)
    ctx.beginPath();
    ctx.moveTo(midX - W * 0.72, trail);
    ctx.lineTo(midX - W * 0.58, lead);
    ctx.lineTo(midX + W * 0.58, lead);
    ctx.lineTo(midX + W * 0.72, trail);
    ctx.closePath();
    ctx.fillStyle = olive;
    ctx.fill();
    {
      const tex = assets.olive || assets.rust;
      if (tex) {
        ctx.save();
        ctx.clip();
        ctx.globalAlpha = 0.55;
        ctx.drawImage(tex, midX - W * 0.72, lead - 20, W * 1.44, trail - lead + 40);
        if (assets.rust) {
          ctx.globalAlpha = 0.25;
          ctx.drawImage(assets.rust, midX - W * 0.5, lead, W, trail - lead);
        }
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = "rgba(55,65,40,0.45)";
        ctx.fill();
        ctx.restore();
      }
    }
    ctx.strokeStyle = "#2b301c";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = oliveL;
    ctx.beginPath();
    ctx.moveTo(midX - W * 0.56, lead);
    ctx.lineTo(midX + W * 0.56, lead);
    ctx.lineTo(midX + W * 0.54, lead + H * 0.03);
    ctx.lineTo(midX - W * 0.54, lead + H * 0.03);
    ctx.closePath();
    ctx.fill();
    // flap lines
    ctx.strokeStyle = "rgba(30,32,20,0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(midX - W * 0.62, trail - H * 0.04);
    ctx.lineTo(midX + W * 0.62, trail - H * 0.04);
    ctx.stroke();

    // fuselage tube: from just below sight down through the wing
    ctx.fillStyle = olive;
    ctx.beginPath();
    ctx.moveTo(midX - W * 0.034, lead + H * 0.02);
    ctx.lineTo(midX + W * 0.034, lead + H * 0.02);
    ctx.lineTo(midX + W * 0.026, H * 1.05);
    ctx.lineTo(midX - W * 0.026, H * 1.05);
    ctx.closePath();
    ctx.fill();
    // nose toward horizon (small, under crosshair)
    ctx.beginPath();
    ctx.moveTo(midX - W * 0.03, lead + H * 0.01);
    ctx.lineTo(midX + W * 0.03, lead + H * 0.01);
    ctx.lineTo(midX + W * 0.016, lead - H * 0.10);
    ctx.lineTo(midX, lead - H * 0.155);
    ctx.lineTo(midX - W * 0.016, lead - H * 0.10);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#2b301c";
    ctx.stroke();
    // cockpit greenhouse
    ctx.fillStyle = "rgba(160,205,225,0.45)";
    ctx.beginPath();
    ctx.moveTo(midX - W * 0.018, lead - H * 0.02);
    ctx.lineTo(midX + W * 0.018, lead - H * 0.02);
    ctx.lineTo(midX + W * 0.012, lead - H * 0.09);
    ctx.lineTo(midX - W * 0.012, lead - H * 0.09);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(190,225,235,0.75)";
    ctx.stroke();
    // chin turret hint
    ctx.fillStyle = oliveD;
    ctx.beginPath();
    ctx.ellipse(midX, lead - H * 0.12, W * 0.012, H * 0.012, 0, 0, TAU);
    ctx.fill();

    // four nacelles sitting on the leading edge
    const slots = [-0.34, -0.175, 0.175, 0.34];
    for (let i = 0; i < 4; i++) {
      const ex = midX + slots[i] * W;
      const ey = lead + H * 0.012;
      const fire = bomber ? bomber.engines[i].fire : 0;
      ctx.fillStyle = oliveD;
      ctx.beginPath();
      ctx.ellipse(ex, ey + H * 0.02, W * 0.024, H * 0.04, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = fire > 0.25 ? "#4a2410" : metal;
      ctx.beginPath();
      ctx.ellipse(ex, ey, W * 0.026, H * 0.03, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = "#1c1c16";
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = "#e6e0d2";
      ctx.beginPath();
      ctx.ellipse(ex, ey - H * 0.006, W * 0.048, H * 0.055, 0, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (fire > 0) {
        ctx.globalAlpha = 0.6 * fire;
        ctx.fillStyle = "#ff6a14";
        ctx.beginPath();
        ctx.ellipse(ex, ey - H * 0.04, W * 0.018, H * 0.04, 0, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 0.35 * fire;
        ctx.fillStyle = "#2a2a28";
        ctx.beginPath();
        ctx.ellipse(ex, ey - H * 0.08, W * 0.028, H * 0.05, 0, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    // star-and-bar
    ctx.save();
    ctx.translate(midX + W * 0.28, lead + H * 0.10);
    const st = Math.min(W, H) * 0.032;
    ctx.fillStyle = "#e8eef2";
    ctx.fillRect(-st * 2.15, -st * 0.32, st * 4.3, st * 0.64);
    ctx.beginPath(); ctx.arc(0, 0, st * 0.92, 0, TAU); ctx.fill();
    ctx.fillStyle = "#2c4a8c";
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + i * TAU / 5;
      const x = Math.cos(a) * st * 0.68, y = Math.sin(a) * st * 0.68;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      const a2 = a + TAU / 10;
      ctx.lineTo(Math.cos(a2) * st * 0.26, Math.sin(a2) * st * 0.26);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // battle damage on airframe when critical
    if (bomber && bomber.health < 30) {
      const dmg = (30 - bomber.health) / 30;
      ctx.globalAlpha = 0.35 + dmg * 0.4;
      ctx.fillStyle = "#1a1008";
      for (let i = 0; i < 5; i++) {
        const hx = midX + Math.sin(i * 2.1 + elapsed) * W * 0.25 * dmg;
        const hy = lead + H * (0.04 + (i % 3) * 0.05);
        ctx.beginPath(); ctx.ellipse(hx, hy, 8 + dmg * 10, 3, i, 0, TAU); ctx.fill();
      }
      if (bomber.health < 15) {
        ctx.globalAlpha = 0.5 + 0.4 * Math.sin(elapsed * 14);
        ctx.fillStyle = "#ff6a14";
        ctx.beginPath();
        ctx.ellipse(midX - W * 0.18, lead - H * 0.02, 10, 16, 0, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    const aft = Math.abs(gunner.yaw) / (Math.PI * 0.98);
    if (aft > 0.42) {
      const a = (aft - 0.42) / 0.58;
      const tx = midX + (gunner.yaw > 0 ? -1 : 1) * W * 0.18 * a;
      ctx.globalAlpha = a;
      ctx.fillStyle = olive;
      ctx.beginPath();
      ctx.moveTo(tx - 7, H * 0.46);
      ctx.lineTo(tx + 7, H * 0.46);
      ctx.lineTo(tx + 4, H * 0.16);
      ctx.lineTo(tx - 4, H * 0.16);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = oliveD;
      ctx.fillRect(tx - W * 0.09, H * 0.44, W * 0.18, H * 0.028);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function drawFighter(e) {
    const p = project(e.x, e.y, e.z);
    if (!p) return null;
    const sc = Math.max(1.4, p.s * 4.0);
    const blink = e.flash > 0.3;
    const typeRow = e.type === "190" ? 1 : e.type === "110" ? 2 : 0;
    // map bank -0.7..0.7 to atlas columns 0..4
    const bankCol = clamp(((e.bank + 0.7) / 1.4) * 4, 0, 4) | 0;
    const cell = 256;
    const span = Math.max(40, (e.type === "110" ? 30 : 24) * sc);
    ctx.save();
    ctx.translate(p.sx, p.sy);
    // slight extra rotate if between atlas frames
    ctx.rotate(e.bank * 0.15);
    if (assets.fighters) {
      const dw = span * 2.5, dh = span * 2.5;
      ctx.globalAlpha = blink ? 0.9 : 1;
      if (blink) { ctx.filter = "brightness(1.8)"; }
      ctx.drawImage(
        assets.fighters,
        bankCol * cell, typeRow * cell, cell, cell,
        -dw * 0.5, -dh * 0.55, dw, dh
      );
      ctx.filter = "none";
      ctx.globalAlpha = 1;
    } else {
      // fallback silhouette
      ctx.fillStyle = blink ? "#fff6c8" : "#5a4830";
      ctx.beginPath();
      ctx.moveTo(0, -span); ctx.lineTo(span * 0.15, span * 0.6); ctx.lineTo(-span * 0.15, span * 0.6);
      ctx.closePath(); ctx.fill();
      ctx.fillRect(-span, span * 0.05, span * 2, span * 0.22);
    }
    if (e.smoke > 0.2) {
      ctx.globalAlpha = 0.45 * e.smoke;
      ctx.fillStyle = "#2a2a28";
      ctx.beginPath();
      ctx.ellipse(0, span * 0.15, 5 * sc, 4 * sc, 0, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    // Always-on contrail / smoke streak so a moving bandit reads on a phone
    const trail = e.trail && e.trail.length > 2 ? e.trail : null;
    if (trail) {
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      let started = false;
      ctx.beginPath();
      for (let i = 0; i < trail.length; i++) {
        const tp = project(trail[i].x, trail[i].y, trail[i].z);
        if (!tp) continue;
        if (!started) { ctx.moveTo(tp.sx, tp.sy); started = true; }
        else ctx.lineTo(tp.sx, tp.sy);
      }
      if (started) {
        ctx.strokeStyle = "rgba(230,232,228," + (0.42 + e.smoke * 0.35) + ")";
        ctx.lineWidth = Math.max(2.2, 5.5 * p.s);
        ctx.stroke();
        ctx.strokeStyle = "rgba(255,255,250," + (0.22 + e.smoke * 0.2) + ")";
        ctx.lineWidth = Math.max(1.0, 2.2 * p.s);
        ctx.stroke();
      }
      ctx.restore();
    } else if (e.smoke > 0.1 || e.phase === "break" || e.phase === "dive") {
      const p2 = project(e.x - (e.vx || 0) * 0.9, e.y - (e.vy || 0) * 0.9 + 1, e.z - (e.vz || 0) * 0.9);
      if (p2) {
        ctx.strokeStyle = "rgba(230,230,220," + (0.35 + e.smoke * 0.35) + ")";
        ctx.lineWidth = Math.max(2, 5 * p.s);
        ctx.beginPath(); ctx.moveTo(p.sx, p.sy); ctx.lineTo(p2.sx, p2.sy); ctx.stroke();
      }
    }
    return p;
  }

  function strokeTrailPts(pts, width, alpha) {
    if (!pts || pts.length < 3) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const screen = [];
    for (let i = 0; i < pts.length; i++) {
      const tp = project(pts[i].x, pts[i].y, pts[i].z);
      if (tp) screen.push(tp);
    }
    if (screen.length < 3) { ctx.restore(); return; }
    function path() {
      ctx.beginPath();
      ctx.moveTo(screen[0].sx, screen[0].sy);
      for (let i = 1; i < screen.length; i++) ctx.lineTo(screen[i].sx, screen[i].sy);
    }
    // Soft bloom underlay (sky clutter read at phone scale)
    path();
    ctx.strokeStyle = "rgba(245,248,252," + Math.min(0.35, alpha).toFixed(3) + ")";
    ctx.lineWidth = Math.min(2, width);
    ctx.stroke();
    ctx.restore();
  }

  function drawContrails() {
    // 2D fallback only (3D path draws thin GL lines). Thin, faint, far.
    for (const e of enemies) {
      if (!e.alive) continue;
      const trail = e.trail;
      if (!trail || trail.length < 3) continue;
      strokeTrailPts(trail.slice(-18), 1.4, 0.18);
    }
  }


  /** Readable friendly B-17 silhouettes — MotA formation layering (Cycle 137). */
  function drawFriendlies() {
    if (!friendlies.length) return;
    const list = friendlies
      .filter((f) => f.health >= 0)
      .map((f) => ({ f, p: project(f.x, f.y, f.z) }))
      .filter((q) => q.p && q.p.z > 25)
      .sort((a, b) => b.p.z - a.p.z);
    for (const q of list) {
      const f = q.f, p = q.p;
      const sc = Math.max(0.55, Math.min(3.4, p.s * 1.65 * (f.scale || 1)));
      ctx.save();
      ctx.translate(p.sx, p.sy);
      ctx.rotate((f.yaw || 0) * 0.35);
      ctx.rotate(f.bank || 0);
      if (f.spiraling) ctx.globalAlpha = Math.max(0.15, 0.7 - (f.spiralT || 0) * 0.08);
      // Soft sky occlusion shadow so bandits read in front
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = "#0a0c0e";
      ctx.beginPath();
      ctx.ellipse(1.5 * sc, 2 * sc, 34 * sc, 7 * sc, 0, 0, TAU);
      ctx.fill();
      // Olive-drab body (readable vs black speck)
      ctx.globalAlpha = 0.72;
      const body = ctx.createLinearGradient(-20 * sc, 0, 20 * sc, 0);
      body.addColorStop(0, "#1a1e14");
      body.addColorStop(0.45, "#2c3224");
      body.addColorStop(1, "#161a12");
      ctx.fillStyle = body;
      // Long B-17 fuselage + glazed nose
      ctx.beginPath();
      ctx.ellipse(2 * sc, 0, 22 * sc, 3.6 * sc, 0, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = "#3a4034";
      ctx.beginPath();
      ctx.ellipse(20 * sc, 0.2 * sc, 5.5 * sc, 2.4 * sc, 0, 0, TAU);
      ctx.fill();
      // High-aspect wing with chord
      ctx.globalAlpha = 0.78;
      ctx.fillStyle = "#1e2218";
      ctx.beginPath();
      ctx.moveTo(-36 * sc, -0.4 * sc);
      ctx.lineTo(32 * sc, -1.6 * sc);
      ctx.lineTo(34 * sc, 2.2 * sc);
      ctx.lineTo(-34 * sc, 2.8 * sc);
      ctx.closePath();
      ctx.fill();
      // Wing root thicker
      ctx.fillStyle = "#24281c";
      ctx.fillRect(-10 * sc, -1.8 * sc, 22 * sc, 4.2 * sc);
      // Four engine nacelles + prop discs
      ctx.globalAlpha = 0.85;
      for (const ex of [-26, -14, 12, 24]) {
        ctx.fillStyle = "#121410";
        ctx.beginPath();
        ctx.ellipse(ex * sc, 1.6 * sc, 2.8 * sc, 2.0 * sc, 0, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = "rgba(180,185,170,0.55)";
        ctx.lineWidth = Math.max(0.6, 0.9 * sc);
        ctx.beginPath();
        ctx.arc(ex * sc, 1.6 * sc, 3.4 * sc, 0, TAU);
        ctx.stroke();
        ctx.globalAlpha = 0.85;
      }
      // Engine fire / smoke on damaged nacelles
      if (f.engines) {
        const nacX = [-26, -14, 12, 24];
        for (let ei = 0; ei < 4; ei++) {
          const eng = f.engines[ei];
          if (!eng || eng.fire < 0.2) continue;
          ctx.globalAlpha = 0.55 * eng.fire;
          ctx.fillStyle = eng.out ? "#ff6020" : "#ffaa40";
          ctx.beginPath();
          ctx.arc(nacX[ei] * sc, 1.6 * sc, (2.2 + eng.fire * 2) * sc, 0, TAU);
          ctx.fill();
        }
      }
      // Twin vertical stabilizers + horizontal stab (B-17 tell)
      ctx.fillStyle = "#1a1e16";
      ctx.fillRect(-14 * sc, -2.2 * sc, 12 * sc, 1.8 * sc); // H-stab leftish of tail
      ctx.fillRect(-6 * sc, -11 * sc, 2.2 * sc, 11 * sc);
      ctx.fillRect(-1.5 * sc, -11 * sc, 2.2 * sc, 11 * sc);
      // Tiny dorsal gun blister hint
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = "#2a2e26";
      ctx.beginPath();
      ctx.arc(4 * sc, -3.2 * sc, 1.6 * sc, 0, TAU);
      ctx.fill();
      // Contrail whisps from outboard engines
      ctx.globalAlpha = 0.28;
      ctx.strokeStyle = "rgba(240,245,255,0.9)";
      ctx.lineWidth = Math.max(1.2, 2.2 * sc);
      ctx.beginPath();
      ctx.moveTo(-26 * sc, 1.6 * sc);
      ctx.lineTo(-42 * sc, 0.5 * sc);
      ctx.moveTo(24 * sc, 1.6 * sc);
      ctx.lineTo(8 * sc, 0.8 * sc);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawEnemies() {
    const list = enemies
      .filter((e) => e.alive || e.flash > 0)
      .map((e) => ({ e, p: project(e.x, e.y, e.z) }))
      .filter((q) => q.p)
      .sort((a, b) => b.p.z - a.p.z);
    for (const q of list) drawFighter(q.e);
  }

  /** Project a world segment, clipping against the near plane. Returns [x0,y0,x1,y1,zNear] or null. */
  function projSeg(ax, ay, az, bx, by, bz) {
    const b = lookBasis();
    const f = (H * 0.5) / Math.tan(FOV * 0.5);
    const toCam = (x, y, z) => {
      const dx = x - CAM.x, dy = y - CAM.y, dz = z - CAM.z;
      return [dx * b.rx + dy * b.ry + dz * b.rz, dx * b.ux + dy * b.uy + dz * b.uz, dx * b.fx + dy * b.fy + dz * b.fz];
    };
    let A = toCam(ax, ay, az), B = toCam(bx, by, bz);
    const NEAR = 0.6;
    if (A[2] < NEAR && B[2] < NEAR) return null;
    if (A[2] < NEAR || B[2] < NEAR) {
      const t = (NEAR - A[2]) / (B[2] - A[2]);
      const C = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, NEAR];
      if (A[2] < NEAR) A = C; else B = C;
    }
    return [W * 0.5 + (A[0] / A[2]) * f, H * 0.5 - (A[1] / A[2]) * f,
      W * 0.5 + (B[0] / B[2]) * f, H * 0.5 - (B[1] / B[2]) * f, Math.min(A[2], B[2])];
  }

  // 1.3.3: thin bright core + soft glow, both fading from the head (q0,q1) to the tail (q2,q3)
  function strokeStreak(q, coreRgb, glowRgb, a, wCore, wGlow) {
    const g1 = ctx.createLinearGradient(q[0], q[1], q[2], q[3]);
    g1.addColorStop(0, "rgba(" + glowRgb + "," + (0.32 * a).toFixed(3) + ")");
    g1.addColorStop(1, "rgba(" + glowRgb + ",0)");
    ctx.strokeStyle = g1; ctx.lineWidth = wGlow;
    ctx.beginPath(); ctx.moveTo(q[0], q[1]); ctx.lineTo(q[2], q[3]); ctx.stroke();
    const g2 = ctx.createLinearGradient(q[0], q[1], q[2], q[3]);
    g2.addColorStop(0, "rgba(" + coreRgb + "," + a.toFixed(3) + ")");
    g2.addColorStop(0.6, "rgba(" + coreRgb + "," + (0.55 * a).toFixed(3) + ")");
    g2.addColorStop(1, "rgba(" + coreRgb + ",0)");
    ctx.strokeStyle = g2; ctx.lineWidth = wCore;
    ctx.beginPath(); ctx.moveTo(q[0], q[1]); ctx.lineTo(q[2], q[3]); ctx.stroke();
  }

  // 1.3.7: pack every live tracer as a world-space segment (head, tail, kind, alpha) for world3d,
  // which draws them as depth-tested screen-width quads (hidden behind our airframe / other ships).
  const TRACER_CAP = 1600;
  const tracerBuf = new Float32Array(TRACER_CAP * 8);
  const tracerExtra = []; // debug/test injections: {hx,hy,hz,tx,ty,tz,kind,a}
  function fillTracerBuf() {
    let n = 0, nA = 0;
    const put = (hx, hy, hz, tx, ty, tz, kind, a) => {
      if (n >= TRACER_CAP) return;
      const o = n * 8; tracerBuf[o] = hx; tracerBuf[o + 1] = hy; tracerBuf[o + 2] = hz; tracerBuf[o + 3] = tx; tracerBuf[o + 4] = ty; tracerBuf[o + 5] = tz; tracerBuf[o + 6] = kind; tracerBuf[o + 7] = a; n++;
    };
    for (const b of bullets) {
      if (!b.tracer) continue;
      // 1.3.9: a free round like the gunners' — 22 u streak behind the head along its own velocity,
      // no barrel anchoring; it fades in over the first ~16 u (≈19 m) and burns out at end of life.
      const sp = Math.hypot(b.vx, b.vy, b.vz) || 1, trav = b.trav || 0;
      if (trav < 0.5) continue;
      const tl = Math.min(28, 0.45 * trav); // 28 u = the same ~65 ms of travel as the gunners' 22 u at 330 u/s; near the gun the tail never reaches back to the barrel
      const fi = clamp((trav - 4) / 14, 0, 1);  // fades in between ~5 m and ~22 m from the muzzle
      const a = fi * fi * (3 - 2 * fi) * clamp(b.life / TRACER_BURN, 0, 1);
      if (a < 0.02) continue;
      put(b.x, b.y, b.z, b.x - b.vx / sp * tl, b.y - b.vy / sp * tl, b.z - b.vz / sp * tl, 0, a);
    }
    const capA = 240, capX = 120; let nX = 0; // 1.4.0: draw caps — the gunners' and the 109s' glowing rounds never swamp the sky
    for (const t of tracers) {
      if (t.hid || t.delay > 0 || t.vx == null) continue;
      if (t.team === "allied" ? nA >= capA : nX >= capX) continue;
      const allied = t.team === "allied";
      if (t.life < 0.05) continue;
      const sp = Math.hypot(t.vx, t.vy, t.vz) || 1, tail = Math.min(t.trav || 0, 22);
      if (tail < 0.5) continue;
      let a = clamp(t.life / TRACER_BURN, 0, 1); // 1.3.9: same burnout for everyone
      // 1.3.7: rounds whipping past within a few spans of the eye (e.g. our own ship's waist/tail guns)
      // read as screen-wide laser lines — real ones are a blur. Fade them in with range from the eye.
      const dE = Math.hypot(t.x - CAM.x, t.y - CAM.y, t.z - CAM.z);
      a *= clamp((dE - 20) / 70, 0, 1); // 1.5.1: every CPU tracer fades like the gunners'
      if (a < 0.02) continue;
      put(t.x, t.y, t.z, t.x - t.vx / sp * tail, t.y - t.vy / sp * tail, t.z - t.vz / sp * tail, t.p51 ? 4 : allied ? 1 : t.k190 ? 3 : 2, a);
      if (allied) nA++; else nX++;
    }
    for (const q of tracerExtra) put(q.hx, q.hy, q.hz, q.tx, q.ty, q.tz, q.kind || 1, q.a == null ? 1 : q.a);
    drawEnemyTracers.lastAllied = nA;
    return n;
  }
  function drawBullets() {
    // 1.3.2: YELLOW .50 tracers — thin fast streaks of light that start AT the barrel tip,
    // short bright tail, head brighter than the tail.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    const maxLen = Math.min(W, H) * 0.45;
    for (const b of bullets) {
      if (!b.tracer) continue;
      const sp = Math.hypot(b.vx, b.vy, b.vz) || 1;
      const tail = Math.min(b.trav || 0, 42);
      const q = projSeg(b.x, b.y, b.z, b.x - b.vx / sp * tail, b.y - b.vy / sp * tail, b.z - b.vz / sp * tail);
      if (!q) continue;
      const len = Math.hypot(q[2] - q[0], q[3] - q[1]);
      if (len > maxLen) continue;
      const fade = clamp(b.life / TRACER_BURN, 0, 1) * clamp((b.trav || 0) / 16, 0, 1);
      strokeStreak(q, "255,248,200", "255,196,60", 0.95 * fade, 0.9, 2.6);
    }
    ctx.restore();
  }


  function drawEnemyTracers() {
    // RED = Bf 109 cannon/MG (individual gradient streaks), YELLOW = the other B-17 gunners —
    // 1.3.6: hundreds of them, so they are batched into 4 strokes (glow + core, head + tail halves).
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    const maxLen = Math.min(W, H) * 0.3;
    const glowH = new Path2D(), coreH = new Path2D(), glowT = new Path2D(), coreT = new Path2D();
    let nA = 0, nX2 = 0;
    const capA = 240, capX = 120; let nX = 0; // 1.4.0: draw caps — the gunners' and the 109s' glowing rounds never swamp the sky
    for (const t of tracers) {
      if (t.hid || t.delay > 0 || t.vx == null) continue;
      if (t.team === "allied" ? nA >= capA : nX >= capX) continue;
      const sp = Math.hypot(t.vx, t.vy, t.vz) || 1;
      const allied = t.team === "allied";
      const tail = Math.min(t.trav || 0, 15);
      if (tail < 0.5) continue;
      const q = projSeg(t.x, t.y, t.z, t.x - t.vx / sp * tail, t.y - t.vy / sp * tail, t.z - t.vz / sp * tail);
      if (!q) continue;
      const len = Math.hypot(q[2] - q[0], q[3] - q[1]);
      if (len > maxLen) continue;
      if (t.k190) { if (t.life < 0.05) continue; strokeStreak(q, "255,120,80", "255,36,10", 0.95 * clamp(t.life / 0.2, 0, 1), 0.9, 2.6); nX2++; continue; } // 1.5.3: Fw 190 tracers red
      {
        if (t.life < 0.05) continue;
        const mx = (q[0] + q[2]) * 0.5, my = (q[1] + q[3]) * 0.5;
        coreH.moveTo(q[0], q[1]); coreH.lineTo(mx, my); glowH.moveTo(q[0], q[1]); glowH.lineTo(mx, my);
        coreT.moveTo(mx, my); coreT.lineTo(q[2], q[3]); glowT.moveTo(mx, my); glowT.lineTo(q[2], q[3]);
        nA++;
        continue;
      }
      const near = q[4]; // (unreachable: 1.5.1 all CPU tracers use the gunners' look)
      const a = clamp(t.life / 0.2, 0, 1) * clamp((near - 3) / 10, 0.25, 1);
      strokeStreak(q, "255,130,100", "255,40,20", 0.95 * a, 0.9, 2.6);
    }
    if (nA) {
      ctx.strokeStyle = "rgba(255,190,60,0.22)"; ctx.lineWidth = 2.6; ctx.stroke(glowH);
      ctx.strokeStyle = "rgba(255,190,60,0.1)"; ctx.stroke(glowT);
      ctx.strokeStyle = "rgba(255,236,160,0.9)"; ctx.lineWidth = 1.0; ctx.stroke(coreH);
      ctx.strokeStyle = "rgba(255,226,140,0.42)"; ctx.lineWidth = 0.8; ctx.stroke(coreT);
    }
    drawEnemyTracers.lastAllied = nA;
    ctx.restore();
  }


  function drawParticles() {
    for (const p of particles) {
      if (p.wait > 0) continue;
      const q = project(p.x, p.y, p.z);
      if (!q) continue;
      const a = clamp(p.life / (p.max || 0.6), 0, 1);
      if (p.kind === "flash" || p.kind === "bloom") { // 1.5.4: very bright yellow-orange hit flash (white-hot centre, ragged cross-flare); heavy hits add a soft white bloom
        const R = Math.min(p.kind === "bloom" ? 38 : 13, Math.max(p.kind === "bloom" ? 6 : 2, p.r * q.s * 0.3));
        ctx.save(); ctx.translate(q.sx, q.sy); ctx.globalCompositeOperation = "lighter";
        if (p.kind === "bloom") {
          const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
          g.addColorStop(0, "rgba(255,244,214," + (0.7 * a).toFixed(3) + ")"); g.addColorStop(0.45, "rgba(255,200,120," + (0.28 * a).toFixed(3) + ")"); g.addColorStop(1, "rgba(255,150,60,0)");
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
        } else {
          const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
          g.addColorStop(0, "rgba(255,252,225," + a.toFixed(3) + ")"); g.addColorStop(0.35, "rgba(255,190,60," + (0.85 * a).toFixed(3) + ")"); g.addColorStop(1, "rgba(255,110,10,0)");
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
          ctx.rotate(p.ang || 0); ctx.strokeStyle = "rgba(255,225,140," + (0.8 * a).toFixed(3) + ")"; ctx.lineWidth = Math.max(1, R * 0.16);
          ctx.beginPath(); ctx.moveTo(-R * 1.9, 0); ctx.lineTo(R * 1.9, 0); ctx.stroke();
        }
        ctx.restore(); continue;
      }
      const r = Math.min(p.kind === "fire" ? 6 : 8, Math.max(1.0, p.r * q.s * 0.22));
      ctx.save();
      ctx.translate(q.sx, q.sy);
      if (p.kind === "bomb") {
        ctx.globalAlpha = Math.min(1, a * 1.5);
        ctx.fillStyle = "#1c1e18";
        const bl = Math.max(2, q.s * 1.1), bw = Math.max(1, q.s * 0.35);
        ctx.fillRect(-bw / 2, -bl / 2, bw, bl);
        ctx.restore();
        continue;
      }
      if (p.kind === "chip") { // 1.5.3: torn skin / debris chip — small dark tumbling flake with a bright edge (user's shredding refs: dark specks flying off the wing)
        ctx.globalAlpha = Math.min(1, a * 1.6);
        ctx.rotate(p.life * 17 + p.r * 3);
        const cw = Math.max(1.5, r * 1.3), chh = Math.max(1, r * 0.7);
        ctx.fillStyle = "#23261d"; ctx.fillRect(-cw / 2, -chh / 2, cw, chh);
        ctx.fillStyle = "rgba(200,205,190,0.7)"; ctx.fillRect(-cw / 2, -chh / 2, cw, Math.max(0.6, chh * 0.28));
        ctx.restore();
        continue;
      }
      if (p.kind === "spark") {
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = a;
        const ang = Math.atan2(p.vy || 1, p.vx || 1);
        const len = r * (2 + 3 * a);
        ctx.strokeStyle = "rgba(255,230,120," + (0.95 * a) + ")";
        ctx.lineWidth = Math.max(1.2, r * 0.45);
        ctx.beginPath();
        ctx.moveTo(-Math.cos(ang) * len * 0.2, -Math.sin(ang) * len * 0.2);
        ctx.lineTo(Math.cos(ang) * len, Math.sin(ang) * len);
        ctx.stroke();
        ctx.fillStyle = "rgba(255,255,220," + (0.9 * a) + ")";
        ctx.beginPath(); ctx.arc(0, 0, r * 0.55, 0, TAU); ctx.fill();
      } else if (p.kind === "fire") {
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = a;
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 1.8);
        g.addColorStop(0, "rgba(255,255,200," + (0.95 * a) + ")");
        g.addColorStop(0.35, "rgba(255,140,30," + (0.7 * a) + ")");
        g.addColorStop(1, "rgba(255,40,0,0)");
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(0, 0, r * 1.8, 0, TAU); ctx.fill();
        // debris shard
        ctx.fillStyle = "rgba(255,200,80," + (0.8 * a) + ")";
        ctx.fillRect(-r * 0.3, -r * 1.2, r * 0.6, r * 2.4);
      } else {
        // 1.3.2: soft smoke puff (no flat grey discs)
        const R = r * 1.6;
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
        g.addColorStop(0, "rgba(46,44,40," + (0.4 * a).toFixed(3) + ")");
        g.addColorStop(1, "rgba(46,44,40,0)");
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }
  }


  // strikes live in screen fractions, kept to the rim so the centre stays clear
  const CRACKS = (() => {
    let sd = 77; const R = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
    const pts = [[0.08, 0.2, 30], [0.93, 0.72, 25], [0.15, 0.86, 17], [0.84, 0.12, 12], [0.04, 0.55, 8], [0.62, 0.05, 5]];
    return pts.map(([x, y, th]) => {
      const legs = [];
      const n = 7 + ((R() * 5) | 0);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 6.283 + R() * 0.5, len = 40 + R() * 120, seg = [];
        let px = 0, py = 0, aa = a;
        const ns = 3 + ((R() * 3) | 0);
        for (let k = 0; k < ns; k++) { aa += (R() - 0.5) * 0.5; px += Math.cos(aa) * len / ns; py += Math.sin(aa) * len / ns; seg.push([px, py]); }
        legs.push(seg);
      }
      const rings = [0.25 + R() * 0.1, 0.5 + R() * 0.15];
      return { x, y, th, legs, rings };
    });
  })();
  function drawDomeCracks(hp, u) {
    ctx.save();
    ctx.lineCap = "round";
    for (const C of CRACKS) {
      if (hp >= C.th) continue;
      const cx = C.x * W, cy = C.y * H, k = u * (hp < 10 ? 1.15 : 0.9);
      // dark crack line + bright refraction edge
      for (const pass of [0, 1]) {
        ctx.strokeStyle = pass ? "rgba(235,242,250,0.55)" : "rgba(20,24,28,0.45)";
        ctx.lineWidth = (pass ? 0.8 : 1.6) * u;
        for (const leg of C.legs) {
          ctx.beginPath(); ctx.moveTo(cx + (pass ? 0.7 : 0), cy);
          for (const [px, py] of leg) ctx.lineTo(cx + px * k + (pass ? 0.7 : 0), cy + py * k);
          ctx.stroke();
        }
        // concentric web between legs
        for (const r of C.rings) {
          ctx.beginPath();
          C.legs.forEach((leg, i) => { const p = leg[Math.min(leg.length - 1, Math.floor(r * leg.length))]; const x = cx + p[0] * k * r * 1.4, y = cy + p[1] * k * r * 1.4; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
          ctx.closePath(); ctx.stroke();
        }
      }
      // the strike itself: a frosted crater with a hole
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 14 * u);
      g.addColorStop(0, "rgba(10,10,12,0.9)"); g.addColorStop(0.25, "rgba(210,220,230,0.55)"); g.addColorStop(1, "rgba(210,220,230,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, 14 * u, 0, 6.283); ctx.fill();
    }
    ctx.restore();
  }
  function drawPlexiOverlay() {
    // 1.3.2: thin, non-obstructive Sperry dome facsimile — a slim frame arc that only shows in
    // the corners, a hair-thin ring rail on the very bottom edge, faint plexiglass glints and
    // smudges. Nothing solid over the sky.
    ctx.save();
    // smudges (very faint, edges only)
    if (assets.dirt) {
      const dirtBoost = (bomber && bomber.flash > 0 ? 0.05 : 0);
      ctx.globalAlpha = 0.045 + dirtBoost;
      ctx.drawImage(assets.dirt, 0, H * 0.7, W * 0.22, H * 0.3);
      ctx.globalAlpha = 1;
    }
    // plexiglass glints: two long soft diagonal reflections
    ctx.globalCompositeOperation = "screen";
    const glint = (x0, x1, x2, x3, a) => {
      const g = ctx.createLinearGradient(x0, 0, x3, H * 0.5);
      g.addColorStop(0, "rgba(255,255,255,0)");
      g.addColorStop(0.5, "rgba(235,242,255," + a + ")");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x0, 0); ctx.lineTo(x1, 0); ctx.lineTo(x2, H * 0.55); ctx.lineTo(x3, H * 0.55);
      ctx.closePath(); ctx.fill();
    };
    glint(W * 0.16, W * 0.19, W * 0.1, W * 0.06, 0.05);
    glint(W * 0.205, W * 0.215, W * 0.13, W * 0.12, 0.04);
    glint(W * 0.86, W * 0.875, W * 0.95, W * 0.93, 0.035);
    ctx.globalCompositeOperation = "source-over";
    // 1.4.0: the dome frame, struts and turret ring/sill are real 3D now (world3d cage, drawn in the turret pass)
    const ex = W * 0.5, ey = H * 0.56, rx = W * 0.57, ry = H * 0.74;
    const u = Math.min(W, H) / 412; // scale with the short side
    // (d) plexiglass: faint curved highlight inside the rim + a soft reflection band along the top edge
    ctx.globalCompositeOperation = "screen";
    ctx.lineWidth = 3 * u; ctx.strokeStyle = "rgba(225,235,250,0.06)";
    ctx.beginPath(); ctx.ellipse(ex, ey, rx - 10 * u, ry - 10 * u, 0, Math.PI * 1.05, Math.PI * 1.45); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(ex, ey, rx - 10 * u, ry - 10 * u, 0, Math.PI * 1.6, Math.PI * 1.9); ctx.stroke();
    const tg = ctx.createLinearGradient(0, 0, 0, H * 0.12);
    tg.addColorStop(0, "rgba(220,230,245,0.07)"); tg.addColorStop(1, "rgba(220,230,245,0)");
    ctx.fillStyle = tg; ctx.fillRect(0, 0, W, H * 0.12);
    ctx.globalCompositeOperation = "source-over";
    // (d2) 1.4.0: cracked Plexiglas at low health — spider cracks radiating from bullet strikes near the dome edge
    if (bomber && bomber.health < 30 && state === "PLAYING" && !(downSeq && downSeq.phase !== "fall")) drawDomeCracks(bomber.health, u);
    // (e) edge vignette (canopy shadow), a touch stronger than 1.3.6 but still clear in the middle
    const vg = ctx.createRadialGradient(W * 0.5, H * 0.45, H * 0.3, W * 0.5, H * 0.5, H * 1.05);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(0.62, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(2,3,5,0.12)"); // 1.5.1: lighter canopy shadow
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  function drawCanopy() {
    ctx.save();
    // Sperry cage — metal ribs with texture
    const rib = (x0, y0, x1, y1, w) => {
      ctx.lineWidth = w;
      ctx.strokeStyle = "rgba(18,20,22,0.85)";
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo((x0+x1)*0.5, (y0+y1)*0.5 - 8, x1, y1); ctx.stroke();
      ctx.lineWidth = Math.max(1, w * 0.35);
      ctx.strokeStyle = "rgba(160,155,140,0.35)";
      ctx.beginPath(); ctx.moveTo(x0+1, y0); ctx.quadraticCurveTo((x0+x1)*0.5+1, (y0+y1)*0.5 - 8, x1+1, y1); ctx.stroke();
    };
    rib(W * 0.05, 0, W * 0.95, 0, 8);
    rib(0, H * 0.12, 0, H * 0.88, 7);
    rib(W, H * 0.12, W, H * 0.88, 7);
    // vertical struts
    for (const x of [0.18, 0.36, 0.64, 0.82]) {
      rib(W * x, 0, W * x + (x - 0.5) * 24, H * 0.78, 3.5);
    }
    // cross brace
    ctx.strokeStyle = "rgba(25,28,30,0.45)";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(W * 0.12, H * 0.08); ctx.lineTo(W * 0.88, H * 0.08);
    ctx.stroke();
    // plexi dirt / scratches (Cycle 137: stronger diegetic glass)
    if (assets.dirt) {
      ctx.globalAlpha = 0.58;
      ctx.drawImage(assets.dirt, 0, 0, W, H * 0.62);
      ctx.globalAlpha = 0.42;
      ctx.drawImage(assets.dirt, W * 0.45, H * 0.01, W * 0.58, H * 0.48);
      ctx.globalAlpha = 0.30;
      ctx.drawImage(assets.dirt, W * 0.08, H * 0.32, W * 0.42, H * 0.34);
      ctx.globalAlpha = 0.18;
      ctx.drawImage(assets.dirt, W * 0.55, H * 0.4, W * 0.4, H * 0.28);
    } else {
      ctx.globalAlpha = 0.34;
      ctx.fillStyle = "#3a3428";
      ctx.beginPath(); ctx.ellipse(W * 0.18, H * 0.22, 40, 18, 0.4, 0, TAU); ctx.fill();
    }
    // fine scratch streaks + hairline cracks
    ctx.globalAlpha = 0.28;
    ctx.strokeStyle = "rgba(235,225,205,0.9)";
    ctx.lineWidth = 1.25;
    for (let i = 0; i < 20; i++) {
      const x0 = (i * 79 + 28) % W;
      const y0 = ((i * 47) % (H * 0.58));
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + 52 + (i % 3) * 24, y0 + 1 + (i % 5));
      ctx.stroke();
    }
    ctx.globalAlpha = 0.14;
    ctx.strokeStyle = "rgba(200,210,220,0.7)";
    ctx.lineWidth = 0.8;
    for (let i = 0; i < 6; i++) {
      const x0 = W * (0.15 + i * 0.12);
      const y0 = H * (0.12 + (i % 3) * 0.08);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + 18, y0 + 28 + i * 3);
      ctx.lineTo(x0 + 40, y0 + 12);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // dark edge vignette (physical canopy shadow)
    const vg = ctx.createRadialGradient(W * 0.5, H * 0.42, H * 0.22, W * 0.5, H * 0.45, H * 0.88);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(6,8,12,0.2)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  function drawGuns() {
    const recoil = gunner.recoil * 18;
    ctx.save();
    function barrel(x0, x1, x2, x3, mx) {
      // Cycle 135: barrels dominate foreground (tips higher)
      ctx.beginPath();
      ctx.moveTo(x0, H + 10);
      ctx.lineTo(x1, H * 0.66 + recoil);
      ctx.lineTo(x2, H * 0.66 + recoil);
      ctx.lineTo(x3, H + 10);
      ctx.closePath();
      // metal body first, subtle texture overlay (not full diamond-plate wash)
      {
        const g = ctx.createLinearGradient(x1, 0, x2, 0);
        g.addColorStop(0, "#1c1e18");
        g.addColorStop(0.35, "#6a6e62");
        g.addColorStop(0.5, "#9a9e90");
        g.addColorStop(0.65, "#5a5e52");
        g.addColorStop(1, "#181a14");
        ctx.fillStyle = g;
        ctx.fill();
      }
      if (assets.metal) {
        ctx.save();
        ctx.clip();
        ctx.globalAlpha = 0.28;
        ctx.drawImage(assets.metal, Math.min(x0, x3) - 20, H * 0.55, Math.abs(x3 - x0) + 60, H * 0.5);
        ctx.restore();
      }
      ctx.strokeStyle = "#0a0a08";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // receiver / cooling jacket rings
      ctx.fillStyle = "#2e302a";
      ctx.fillRect(x1 - 4, H * 0.66 + recoil - 4, (x2 - x1) + 8, 8);
      ctx.strokeStyle = "rgba(180,180,160,0.25)";
      for (let i = 0; i < 5; i++) {
        const yy = H * 0.70 + recoil + i * 11;
        ctx.beginPath();
        ctx.moveTo(lerp(x0, x1, 0.35), yy);
        ctx.lineTo(lerp(x3, x2, 0.35), yy);
        ctx.stroke();
      }
      if (guns.muzzle > 0 && state !== "TITLE") {
        const a = guns.muzzle;
        const my = H * 0.665 + recoil;
        // Directional muzzle bloom (NOT a UI-sized circle pad)
        ctx.save();
        ctx.translate(mx, my);
        ctx.globalCompositeOperation = "lighter";
        // core hot point
        const core = ctx.createRadialGradient(0, 0, 0, 0, 0, 10 + 8 * a);
        core.addColorStop(0, "rgba(255,255,240," + (0.95 * a) + ")");
        core.addColorStop(0.4, "rgba(255,200,80," + (0.55 * a) + ")");
        core.addColorStop(1, "rgba(255,100,0,0)");
        ctx.fillStyle = core;
        ctx.beginPath(); ctx.arc(0, 0, 10 + 8 * a, 0, TAU); ctx.fill();
        // long forward streaks
        for (let i = 0; i < 5; i++) {
          const ang = -Math.PI / 2 + (i - 2) * 0.12;
          const len = 28 + 55 * a * (0.7 + (i % 2) * 0.3);
          ctx.strokeStyle = "rgba(255," + (220 - i * 20) + ",80," + (0.55 * a) + ")";
          ctx.lineWidth = 2.2 - i * 0.25;
          ctx.beginPath();
          ctx.moveTo(Math.cos(ang) * 4, Math.sin(ang) * 4);
          ctx.lineTo(Math.cos(ang) * len, Math.sin(ang) * len);
          ctx.stroke();
        }
        // side sparks
        for (let i = 0; i < 4; i++) {
          const ang = rand(-0.8, 0.8) - Math.PI / 2;
          const len = 12 + rand(8, 28) * a;
          ctx.strokeStyle = "rgba(255,240,160," + (0.4 * a) + ")";
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(Math.cos(ang) * len, Math.sin(ang) * len);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
    barrel(W * 0.22, W * 0.372, W * 0.448, W * 0.34, W * 0.410);
    barrel(W * 0.78, W * 0.628, W * 0.552, W * 0.66, W * 0.590);
    // ammo belt hint
    ctx.globalAlpha = 0.55;
    if (assets.rust) {
      ctx.drawImage(assets.rust, W * 0.44, H * 0.88, W * 0.12, H * 0.14);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }


  function drawMuzzle3D() {
    // 1.3.1: compact muzzle flash at the (low) barrel tips — no giant orange discs
    if (guns.muzzle <= 0 || state === "TITLE") return;
    const a = guns.muzzle;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const mx of MUZZLE_SX) {
      const x = W * mx, y = H * MUZZLE_SY + gunner.recoil * 4;
      const R = 6 + 9 * a; // 1.5.4: faint — a small sharp flash like the waist-gun reference, not a bloom
      const core = ctx.createRadialGradient(x, y, 0, x, y, R);
      core.addColorStop(0, "rgba(255,250,220," + (0.7 * a) + ")");
      core.addColorStop(0.3, "rgba(255,190,70," + (0.5 * a) + ")");
      core.addColorStop(1, "rgba(255,60,0,0)");
      ctx.fillStyle = core;
      ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }


  // 1.4.0: the iron ring sight is gone — a light FLOATING reflector reticle is back, centred on the sight line
  // (the camera axis), which is exactly where both guns' rounds cross at 320 u (CONV_R + the AIMTAB drop/drift
  // correction). Thin ring + centre dot + four short ticks, pale with a dark hairline so it reads on sky and ground.
  let leadHint = null; // first-time lead hint (once per install)
  let difficulty = "easy"; // 1.4.1 (set from the title screen, see setDifficulty)
  function drawCrosshair() {
    const vb = fx154.vib; // 1.5.4 gun vibration: the reflector sight buzzes at the guns' rate while firing (jitter + a faint double image)
    const cx = W * 0.5 + gunner.shake * (Math.sin(elapsed * 73) * 1.1) + vb * Math.sin(elapsed * 211) * 1.5 + (gunner.kx || 0) * W * 0.25;
    const cy = H * 0.5 + gunner.recoil * 2 + gunner.shake * (Math.cos(elapsed * 61) * 0.6) + vb * Math.cos(elapsed * 187) * 1.1 + (gunner.ky || 0) * H * 0.25;
    ctx.save();
    {
      const hot = guns.overheated;
      const R = Math.max(18, Math.min(26, H * 0.045));
      const line = (col, lw) => {
        ctx.strokeStyle = col; ctx.lineWidth = lw;
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - R - 7, cy); ctx.lineTo(cx - R + 5, cy);
        ctx.moveTo(cx + R - 5, cy); ctx.lineTo(cx + R + 7, cy);
        ctx.moveTo(cx, cy - R - 7); ctx.lineTo(cx, cy - R + 5);
        ctx.moveTo(cx, cy + R - 5); ctx.lineTo(cx, cy + R + 7);
        ctx.stroke();
      };
      if (vb > 0.25) { ctx.save(); ctx.translate(Math.sin(elapsed * 97) * 2.2, Math.cos(elapsed * 83) * 1.6); line("rgba(255,226,150," + (0.22 * vb).toFixed(3) + ")", 1.4); ctx.restore(); }
      line("rgba(20,18,14,0.28)", 2.6);
      line(hot ? "rgba(235,110,60,0.8)" : "rgba(255,226,150,0.72)", 1.2);
      ctx.fillStyle = hot ? "rgba(235,110,60,0.85)" : "rgba(255,226,150,0.85)";
      ctx.strokeStyle = "rgba(20,18,14,0.35)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, 1.6, 0, TAU); ctx.fill(); ctx.stroke();
    }
    // 1.5.2 EASY: a red box on every German fighter that scales with range — faint, thin and small beyond ~1 mile, thick, dark and
    // opaque red inside ~400 yd. Size/alpha/width are smoothed per fighter (exponential), so nothing pops or flickers as range changes.
    if (state === "PLAYING" && difficulty !== "medium" && !window.__FG_NOBOX) {
      const dtB = 1 / 60;
      for (const e of enemies) {
        if (e.team === "allied" || e.phase === "debug") continue;
        const bx = e._bx || (e._bx = { a: 0, w: 0.8, h: 8, k: 0 });
        let aT = 0, sxp = 0, syp = 0, rangeYd = 0;
        if (e.alive && !e.hold) {
          const dxe = e.x - CAM.x, dye = e.y - CAM.y, dze = e.z - CAM.z, de = Math.hypot(dxe, dye, dze);
          rangeYd = de * 1.5 / 0.9144;
          const pe = projectStable(e.x, e.y, e.z);
          if (pe && pe.sx > -20 && pe.sx < W + 20 && pe.sy > -20 && pe.sy < H + 20 && rangeYd < 3400 && !ownShipHides(dxe / de, dye / de, dze / de)) {
            sxp = pe.sx; syp = pe.sy; aT = 1;
            const kT = 1 - smooth01((rangeYd - 400) / (1760 - 400)); // 0 beyond a mile … 1 inside 400 yd
            bx.k += (kT - bx.k) * Math.min(1, dtB * 6);
            const spanPx = (e.type === "190" ? 7.0 : 6.6) * pe.s;   // wingspan in pixels
            const hT = Math.max(6, spanPx * 0.62 + 4 + 5 * bx.k);
            bx.h += (hT - bx.h) * Math.min(1, dtB * 10);
            bx.sx = sxp; bx.sy = syp;
          }
        }
        bx.a += (aT * (0.2 + 0.7 * bx.k) - bx.a) * Math.min(1, dtB * (aT ? 8 : 5));
        if (bx.a < 0.02 || bx.sx == null) continue;
        const col = (c0, c1) => Math.round(c0 + (c1 - c0) * bx.k);
        const lw = 0.8 + 1.7 * bx.k;
        if (window.__FG_BOXLOG) window.__FG_BOXLOG.push({ id: e.id, type: e.type, yd: Math.round(rangeYd), a: +bx.a.toFixed(3), lw: +lw.toFixed(2), h: +bx.h.toFixed(1), k: +bx.k.toFixed(3) });
        ctx.save();
        ctx.lineJoin = "miter";
        ctx.strokeStyle = "rgba(10,6,6," + (0.35 * bx.a).toFixed(3) + ")"; ctx.lineWidth = lw + 1.4;     // thin dark keyline so it reads on bright sky
        ctx.strokeRect(bx.sx - bx.h, bx.sy - bx.h * 0.78, bx.h * 2, bx.h * 1.56);
        ctx.strokeStyle = "rgba(" + col(240, 178) + "," + col(96, 14) + "," + col(86, 14) + "," + bx.a.toFixed(3) + ")"; ctx.lineWidth = lw;
        ctx.strokeRect(bx.sx - bx.h, bx.sy - bx.h * 0.78, bx.h * 2, bx.h * 1.56);
        ctx.restore();
      }
    }
    // Gold lead pip only — teaches deflection; no green on-target HUD
    // (window.__FG_NOPIP: test-harness only, keeps the pip off pinned flyby targets)
    if (state === "PLAYING" && !window.__FG_NOPIP && difficulty !== "medium") { // MEDIUM: no lead markers
      let best = null, bestPlane = null, bestZ = 1e9;
      for (const e of enemies) {
        if (!e.alive || e.team === "allied") continue;
        // 1.3.6: pip only for 109s in gun range and not hidden behind our own airframe
        const dxe = e.x - CAM.x, dye = e.y - CAM.y, dze = e.z - CAM.z, de = Math.hypot(dxe, dye, dze);
        if (de > 1000 || de > bestZ * 1.6 || ownShipHides(dxe / de, dye / de, dze / de)) continue;
        const lp = leadAimPoint(e);
        const q = projectStable(lp.x, lp.y, lp.z);
        const pe = projectStable(e.x, e.y, e.z);
        if (q && q.z < bestZ && q.z > 8 && q.sx > 12 && q.sx < W - 12) {
          best = q; bestPlane = pe; bestZ = q.z;
        }
      }
      if (best) {
        const pulse = 0.5 + 0.5 * Math.sin(elapsed * 9);
        ctx.strokeStyle = "rgba(245,200,90," + (0.50 + 0.25 * pulse).toFixed(2) + ")";
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(best.sx, best.sy, 6, 0, TAU); ctx.stroke();
        ctx.beginPath(); ctx.arc(best.sx, best.sy, 1.5, 0, TAU); ctx.stroke();
        if (bestPlane && Math.hypot(best.sx - bestPlane.sx, best.sy - bestPlane.sy) > 14) {
          ctx.setLineDash([3, 5]);
          ctx.strokeStyle = "rgba(230,190,100,0.28)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(bestPlane.sx, bestPlane.sy);
          ctx.lineTo(best.sx, best.sy);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        // 1.4.0: first-time lead hint — the first time a pip appears, say what it is (once per install)
        if (!leadHint) {
          let seen = false; try { seen = localStorage.getItem("fg_leadHint") === "1"; } catch (e) { /* no storage */ }
          leadHint = { t: seen ? -1 : 6.5 };
          if (!seen) try { localStorage.setItem("fg_leadHint", "1"); } catch (e) { /* no storage */ }
        }
      }
      if (leadHint && leadHint.t > 0) {
        leadHint.t -= 1 / 60;
        const a = clamp(leadHint.t / 1.0, 0, 1) * clamp((6.5 - leadHint.t) / 0.4, 0, 1);
        const hx = best ? clamp(best.sx, 120, W - 120) : W * 0.5, hy = best ? clamp(best.sy - 30, 70, H - 60) : H * 0.35;
        ctx.globalAlpha = a;
        ctx.font = "bold 13px sans-serif"; ctx.textAlign = "center";
        const t1 = "LEAD HIM: PUT THE GOLD PIP IN THE RING", tw = ctx.measureText(t1).width;
        ctx.fillStyle = "rgba(10,10,8,0.55)"; ctx.fillRect(hx - tw / 2 - 8, hy - 15, tw + 16, 22);
        ctx.fillStyle = "rgba(255,214,120,1)"; ctx.fillText(t1, hx, hy + 1);
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
  }

  function drawHitMarks() {
    for (const m of hitMarks) {
      if (!m.text) { // 1.3.2: plain strike sparkle (no big bloom)
        const a = clamp(m.life / 0.2, 0, 1);
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.strokeStyle = "rgba(255,240,180," + (0.8 * a).toFixed(2) + ")";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(m.x - 5, m.y); ctx.lineTo(m.x + 5, m.y);
        ctx.moveTo(m.x, m.y - 5); ctx.lineTo(m.x, m.y + 5);
        ctx.stroke();
        ctx.restore();
        continue;
      }
      ctx.save();
      const lifeMax = m.big ? 0.7 : 0.28;
      const a = Math.max(0, m.life / lifeMax);
      ctx.globalAlpha = a;
      ctx.globalCompositeOperation = "lighter";
      const s = m.big ? 1.05 : 0.8;
      // flash bloom
      const g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, 28 * s);
      g.addColorStop(0, "rgba(255,255,220," + (0.85 * a) + ")");
      g.addColorStop(0.35, "rgba(255,180,60," + (0.45 * a) + ")");
      g.addColorStop(1, "rgba(255,80,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(m.x, m.y, 28 * s, 0, TAU); ctx.fill();
      ctx.strokeStyle = "#fff8c0";
      ctx.lineWidth = 2.5 * s;
      const arm = 10 * s;
      ctx.beginPath();
      ctx.moveTo(m.x - arm, m.y - arm); ctx.lineTo(m.x - arm * 0.25, m.y - arm * 0.25);
      ctx.moveTo(m.x + arm, m.y - arm); ctx.lineTo(m.x + arm * 0.25, m.y - arm * 0.25);
      ctx.moveTo(m.x - arm, m.y + arm); ctx.lineTo(m.x - arm * 0.25, m.y + arm * 0.25);
      ctx.moveTo(m.x + arm, m.y + arm); ctx.lineTo(m.x + arm * 0.25, m.y + arm * 0.25);
      ctx.stroke();
      ctx.fillStyle = m.text === "KILL" ? "#ffcc66" : "#ffe08a";
      ctx.font = "bold " + (m.big ? 16 : 12) + "px sans-serif";
      ctx.textAlign = "center";
      ctx.shadowColor = "rgba(0,0,0,0.6)";
      ctx.shadowBlur = 4;
      ctx.fillText(m.text, m.x, m.y - 14 * s);
      ctx.restore();
    }
  }

  // 1.3.5: FAR 109 IMPOSTOR. Beyond 300u (~450 m) world3d hides the mesh and we draw a projected
  // vector silhouette of the real planform (thin tapered fuselage, tapered wings with dihedral,
  // tailplane, fin), oriented by the flight model's heading + bank, anti-aliased on the 2D canvas.
  // Below a minimum on-screen span it is scaled up about its centre (stays a plane shape, never a
  // block), then fades into the haze with distance.
  const IMP_D = 300;
  const IMP_PARTS = (() => {
    const W = (sx) => [[0.35 * sx, 0, 1.1], [4.9 * sx, 0.28, 0.4], [4.9 * sx, 0.28, -0.3], [0.35 * sx, 0, -0.95]];
    const T = (sx) => [[0.18 * sx, 0.12, -3.05], [1.75 * sx, 0.14, -3.45], [1.75 * sx, 0.14, -3.85], [0.18 * sx, 0.12, -3.95]];
    return [
      [[0, 0, 4.4], [-0.34, 0.05, 2.4], [-0.36, 0.05, 0.2], [-0.13, 0.08, -4.0], [0.13, 0.08, -4.0], [0.36, 0.05, 0.2], [0.34, 0.05, 2.4]], // fuselage
      W(1), W(-1), T(1), T(-1),
      [[0, 0.1, -3.1], [0, 1.35, -3.65], [0, 1.4, -4.0], [0, 0.12, -4.1]], // fin
    ];
  })();
  function drawFarFighters() {
    if (state !== "PLAYING") return;
    ctx.save();
    ctx.lineJoin = "round";
    for (const e of enemies) {
      if (!e.alive) continue;
      const dist = Math.hypot(e.x - CAM.x, e.y - CAM.y, e.z - CAM.z);
      if (dist <= IMP_D || dist > 12000) continue;
      const c = project(e.x, e.y, e.z);
      if (!c || c.sx < -20 || c.sx > W + 20 || c.sy < -20 || c.sy > H + 20) continue;
      // body axes (same construction as world3d): f = heading, r = f × up, u = r × f, banked about f
      let fx = e.hx, fy = e.hy, fz = e.hz;
      const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
      let rx = -fz, ry = 0, rz = fx; // f × (0,1,0)
      let rl = Math.hypot(rx, rz); if (rl < 1e-4) { rx = 1; rz = 0; rl = 1; } rx /= rl; rz /= rl;
      let ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
      const th = -(e.bank || 0), cs = Math.cos(th), sn = Math.sin(th);
      // rotate r,u about f by th
      const r2x = rx * cs + (fy * rz - fz * ry) * sn, r2y = ry * cs + (fz * rx - fx * rz) * sn, r2z = rz * cs + (fx * ry - fy * rx) * sn;
      const u2x = ux * cs + (fy * uz - fz * uy) * sn, u2y = uy * cs + (fz * ux - fx * uz) * sn, u2z = uz * cs + (fx * uy - fy * ux) * sn;
      // natural span on screen (css px) → minimum-size boost
      const spanPx = 9.8 * c.s;
      const minPx = clamp(9.5 - dist / 900, 4.5, 8.5);
      const k = spanPx < minPx ? minPx / spanPx : 1;
      const fog = clamp((dist - 900) / 11000, 0, 1);
      const lift = e.team === "allied" ? 70 : 0; // Mustangs: natural metal, lighter specks
      const col = "rgb(" + Math.round(38 + lift + (170 - 38) * fog * 0.75) + "," + Math.round(42 + lift + (182 - 42) * fog * 0.75) + "," + Math.round(50 + lift * 0.9 + (196 - 50) * fog * 0.75) + ")";
      ctx.globalAlpha = clamp(1.05 - fog * 0.6, 0.4, 0.95) * clamp((dist - IMP_D) / 25 + 0.4, 0, 1);
      ctx.fillStyle = col; ctx.strokeStyle = col; ctx.lineWidth = 0.7;
      for (const part of IMP_PARTS) {
        ctx.beginPath();
        let ok = true;
        for (let i = 0; i < part.length; i++) {
          const [lx, ly, lz] = part[i];
          const wx = (r2x * lx + u2x * ly + fx * lz) * k, wy = (r2y * lx + u2y * ly + fy * lz) * k, wz = (r2z * lx + u2z * ly + fz * lz) * k;
          const p = project(e.x + wx, e.y + wy, e.z + wz);
          if (!p) { ok = false; break; }
          if (i === 0) ctx.moveTo(p.sx, p.sy); else ctx.lineTo(p.sx, p.sy);
        }
        if (!ok) continue;
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      // occasional sun glint off the canopy / wing (small, soft)
      const h = (e.id.charCodeAt(0) * 7 + e.id.charCodeAt(1) * 13) % 97;
      const g = Math.sin(elapsed * (1.7 + (h % 5) * 0.31) + h);
      if (g > 0.965 && dist > 600) {
        ctx.globalAlpha = (g - 0.965) / 0.035 * 0.8;
        ctx.fillStyle = "rgb(255,248,220)";
        ctx.beginPath(); ctx.arc(c.sx, c.sy, 1.3, 0, TAU); ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawIncoming() {
    // 1.3.2: small plain red arrows on the screen edge for OFF-screen bandits only.
    // No numbers. Merged by direction (16 sectors), nearest first, max 5.
    if (state !== "PLAYING") return;
    const b = lookBasis();
    const f = (H * 0.5) / Math.tan(FOV * 0.5);
    const sectors = new Map();
    for (const e of enemies) {
      if (!e.alive || e.team === "allied") continue;
      const dx = e.x - CAM.x, dy = e.y - CAM.y, dz = e.z - CAM.z;
      const dist = Math.hypot(dx, dy, dz);
      // near bandits, plus far ones that are coming in (opening swarm high ahead, set-up runs)
      if (dist > 420 && !(dist < 9000 && (e.phase === "inbound" || e.phase === "attack"))) continue;
      const camZ = dx * b.fx + dy * b.fy + dz * b.fz;
      const camX = dx * b.rx + dy * b.ry + dz * b.rz;
      const camY = dx * b.ux + dy * b.uy + dz * b.uz;
      if (camZ > 1.2) {
        const sx = W * 0.5 + (camX / camZ) * f, sy = H * 0.5 - (camY / camZ) * f;
        if (sx > 0 && sx < W && sy > 0 && sy < H) continue; // on screen → no arrow
      }
      const ang = Math.atan2(-camY, camX);
      const sec = ((Math.round(ang / (TAU / 16)) % 16) + 16) % 16;
      const cur = sectors.get(sec);
      if (!cur || dist < cur.dist) sectors.set(sec, { dist, camX, camY });
    }
    const list = [...sectors.values()].sort((p, q) => p.dist - q.dist).filter((it, k, a) => k < 2 || (k === 2 && it.dist < 420) || (k === 2 && a[0].dist >= 420)); // 1.4.0: 2–3 arrows max (was 5)
    const cx = W * 0.5, cy = H * 0.5;
    const padX = 14, padTop = 66, padBot = 18;
    ctx.save();
    for (const it of list) {
      let vx = it.camX, vy = -it.camY;
      if (Math.abs(vx) < 1e-3 && Math.abs(vy) < 1e-3) vy = 1;
      const hx = vx > 0 ? (W - padX - cx) : (cx - padX);
      const hy = vy > 0 ? (H - padBot - cy) : (cy - padTop);
      const k = Math.min(hx / Math.max(1e-3, Math.abs(vx)), hy / Math.max(1e-3, Math.abs(vy)));
      let x = cx + vx * k, y = cy + vy * k;
      if (x < 150 && y < 118) y = 118; // keep clear of the left HUD column
      const ang = Math.atan2(vy, vx);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(ang);
      ctx.globalAlpha = it.dist < 150 ? 0.95 : 0.65;
      ctx.fillStyle = "rgb(255,64,40)";
      ctx.strokeStyle = "rgba(40,0,0,0.5)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(7, 0); ctx.lineTo(-4, -5); ctx.lineTo(-2, 0); ctx.lineTo(-4, 5); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }


  function pad(side) {
    // Hint positions only (not hit targets)
    const r = 18;
    if (side === "left") return { x: 28, y: H - 28, r };
    return { x: W - 32, y: H - 28, r };
  }


  function drawTurretInterior() {
    ctx.save();
    // ring gear / race under guns
    ctx.strokeStyle = "rgba(40,38,32,0.85)";
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.ellipse(W * 0.5, H * 1.05, W * 0.42, H * 0.18, 0, Math.PI, TAU);
    ctx.stroke();
    if (assets.metal) {
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(W * 0.5, H * 1.05, W * 0.44, H * 0.2, 0, Math.PI, TAU);
      ctx.ellipse(W * 0.5, H * 1.05, W * 0.36, H * 0.14, 0, TAU, Math.PI, true);
      ctx.clip();
      ctx.globalAlpha = 0.55;
      ctx.drawImage(assets.metal, W * 0.08, H * 0.78, W * 0.84, H * 0.28);
      ctx.restore();
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(180,170,130,0.3)";
    for (let i = 0; i < 18; i++) {
      const a = Math.PI + (i / 18) * Math.PI;
      const x0 = W * 0.5 + Math.cos(a) * W * 0.38;
      const y0 = H * 1.05 + Math.sin(a) * H * 0.16;
      const x1 = W * 0.5 + Math.cos(a) * W * 0.45;
      const y1 = H * 1.05 + Math.sin(a) * H * 0.2;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
    // seat pad
    ctx.fillStyle = "rgba(28,24,18,0.7)";
    ctx.beginPath();
    ctx.ellipse(W * 0.5, H * 0.98, W * 0.16, H * 0.06, 0, 0, TAU);
    ctx.fill();
    if (assets.rust) {
      ctx.globalAlpha = 0.35;
      ctx.drawImage(assets.rust, W * 0.38, H * 0.9, W * 0.24, H * 0.1);
      ctx.globalAlpha = 1;
    }
    // oil stains
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = "#1a1408";
    ctx.beginPath(); ctx.ellipse(W * 0.35, H * 0.92, 30, 10, 0.2, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(W * 0.68, H * 0.94, 24, 8, -0.3, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawMuzzleGrit() {
    for (const c of muzzleSmoke) {
      const a = clamp(c.life * 2.2, 0, 0.45);
      ctx.save();
      ctx.globalAlpha = a;
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.r);
      g.addColorStop(0, "rgba(190,185,175,0.30)");
      g.addColorStop(0.5, "rgba(170,166,158,0.12)");
      g.addColorStop(1, "rgba(150,150,145,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, TAU); ctx.fill();
      ctx.restore();
    }
  }

  function drawBrass() {
    // 1.3.2: .50 cases as small shaded brass cylinders, tumbling (foreshortened) as they fall
    for (const c of brass) {
      const len = c.len || 9;
      const L = len * (0.35 + 0.65 * Math.abs(Math.cos(c.tumble || 0)));
      const Wd = len * 0.34;
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.rot);
      ctx.globalAlpha = clamp(c.life * 3, 0, 1);
      const g = ctx.createLinearGradient(0, -Wd / 2, 0, Wd / 2);
      g.addColorStop(0, "#5a3e0c");
      g.addColorStop(0.3, "#e8c060");
      g.addColorStop(0.42, "#fff2b8");
      g.addColorStop(0.7, "#a87e28");
      g.addColorStop(1, "#4a320a");
      ctx.fillStyle = g;
      ctx.beginPath();
      const r = Wd * 0.3;
      ctx.moveTo(-L / 2 + r, -Wd / 2); ctx.lineTo(L / 2, -Wd / 2); ctx.lineTo(L / 2, Wd / 2);
      ctx.lineTo(-L / 2 + r, Wd / 2); ctx.quadraticCurveTo(-L / 2, Wd / 2, -L / 2, 0);
      ctx.quadraticCurveTo(-L / 2, -Wd / 2, -L / 2 + r, -Wd / 2); ctx.closePath();
      ctx.fill();
      // open mouth (dark) shows when the case is end-on-ish, rim at the base
      const endVis = Math.abs(Math.sin(c.tumble || 0));
      ctx.fillStyle = "rgba(40,26,6,0.85)";
      ctx.beginPath(); ctx.ellipse(-L / 2 + 0.4, 0, 0.4 + endVis * Wd * 0.3, Wd * 0.38, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = "#7a5a18";
      ctx.fillRect(L / 2 - 1.1, -Wd / 2, 1.1, Wd);
      ctx.restore();
    }
  }


  function drawColorGrade() {
    // Soft warm/cool wash so photographic sky and MeshStandard fighters share a palette
    ctx.save();
    ctx.globalCompositeOperation = "soft-light";
    ctx.globalAlpha = 0.20;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#d4e0ec");
    g.addColorStop(0.45, "#e0d4be");
    g.addColorStop(1, "#8a8478");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    // slight lift so 3D metals aren't a different "render" from the HDRI
    ctx.save();
    ctx.globalCompositeOperation = "overlay";
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = "#c8bca8";
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  function drawFilmGrain() {
    grainTick++;
    if (!grainCanvas || grainCanvas.width !== 128) {
      grainCanvas = document.createElement("canvas");
      grainCanvas.width = 128; grainCanvas.height = 128;
      grainCtx = grainCanvas.getContext("2d");
    }
    if (grainTick % 5 === 0) {
      const id = grainCtx.createImageData(128, 128);
      for (let i = 0; i < id.data.length; i += 4) {
        const n = (Math.random() * 255) | 0;
        id.data[i] = id.data[i + 1] = id.data[i + 2] = n;
        id.data[i + 3] = 42;
      }
      grainCtx.putImageData(id, 0, 0);
    }
    ctx.save();
    ctx.globalCompositeOperation = "overlay";
    const grit = 0
      + (guns.muzzle > 0 ? 0.12 : 0)
      + (input.fire && !guns.overheated ? 0.04 : 0)
      + (bomber && bomber.health < 30 ? 0.07 : 0)
      + (bomber && bomber.flash > 0 ? 0.06 : 0);
    ctx.globalAlpha = grit;
    ctx.drawImage(grainCanvas, 0, 0, W, H);
    ctx.restore();
    // Battlefield grit flashes — brief dirt/soot smear when Fortress takes hits
    if (bomber && bomber.flash > 0.15) {
      ctx.save();
      ctx.globalAlpha = clamp(bomber.flash * 0.35, 0, 0.4);
      if (assets.dirt) {
        ctx.drawImage(assets.dirt, rand(-20, 20), rand(-10, 10), W * 1.05, H * 0.7);
      } else {
        ctx.fillStyle = "rgba(40,32,20,0.5)";
        ctx.fillRect(0, 0, W, H * 0.55);
      }
      ctx.restore();
    }
  }

  function drawControls() {
    if (state !== "PLAYING") return;
    // Tiny optional hints only — hit targets are FULL half-screens, not these marks
    const fade = clamp(1 - (timeAlive - 0.7) * 1.1, 0.0, 0.16);
    const L = pad("left"), R = pad("right");
    if (fade <= 0.02 && !input.fire && !input.stickActive) return;
    ctx.save();
    ctx.globalAlpha = (input.fire ? 0.55 : fade);
    ctx.fillStyle = guns.overheated ? "#c0392b" : "#c9a227";
    ctx.beginPath(); ctx.arc(L.x, L.y, 12, 0, TAU); ctx.fill();
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = "#1a1408";
    ctx.font = "bold 9px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(guns.overheated ? "WAIT" : "FIRE", L.x, L.y);
    // look hint
    ctx.globalAlpha = input.stickActive ? 0.45 : 0.18;
    ctx.strokeStyle = "#c9b27a";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(R.x, R.y, 18, 0, TAU); ctx.stroke();
    const kx = R.x - input.stickVX * 10;
    const ky = R.y - input.stickVY * 10;
    ctx.globalAlpha = input.stickActive ? 0.65 : 0.25;
    ctx.fillStyle = "#e8d9a0";
    ctx.beginPath(); ctx.arc(kx, ky, 6, 0, TAU); ctx.fill();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = "#c9b27a";
    ctx.font = "bold 8px sans-serif";
    ctx.fillText("LOOK", R.x, R.y + 28);
    // faint half-screen divider (very subtle)
    ctx.globalAlpha = 0.06;
    ctx.strokeStyle = "#fff";
    ctx.setLineDash([4, 10]);
    ctx.beginPath(); ctx.moveTo(W * 0.5, H * 0.72); ctx.lineTo(W * 0.5, H - 8); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // ----- loop -----
  function frame(t) {
    const dt = Math.min(0.033, (t - lastT) / 1000 || 0.016);
    lastT = t;
    if (!window.__FG_FREEZE) update(dt); // debug: headless stills render an exact sim state
    draw();
    if (mouse.desktop) { // 1.4.0-web: free the cursor for DOM buttons (END MISSION, results)
      const endShown = endBtn && !endBtn.classList.contains("hidden");
      if (mouse.locked && (state !== "PLAYING" || endShown) && document.exitPointerLock) document.exitPointerLock();
      updateLockHint();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ----- input -----
  function inCircle(x, y, c) {
    return Math.hypot(x - c.x, y - c.y) <= c.r + 8;
  }

  // ===== 1.4.0-web: DESKTOP MOUSE CONTROLS (touch path below is untouched) =====
  // Mouse aims 1:1 (no smoothing, no inertia), hold LEFT button = fire. Pointer Lock: click the view to lock,
  // Esc releases (a small "click to play" hint shows while unlocked). No Pointer Lock → aim by dragging.
  // Desktop is detected from (pointer: fine) without touch, or from the first real mouse event.
  const mouse = {
    desktop: !!(window.matchMedia && window.matchMedia("(pointer: fine)").matches && !("ontouchstart" in window) && !(navigator.maxTouchPoints > 0)),
    lockOK: !!(canvas.requestPointerLock && "pointerLockElement" in document),
    locked: false, held: false, dragBtns: 0,
    sens: (() => { try { const v = parseFloat(localStorage.getItem("fg_mouseSens")); return v > 0.2 && v < 5 ? v : 1; } catch (e) { return 1; } })(),
  };
  const lockHint = document.getElementById("lockHint");
  function mouseRadPerPx() { // 1:1 — moving the mouse one screen-width turns the view by one horizontal field of view (× sens)
    const hfov = 2 * Math.atan(Math.tan(FOV * 0.5) * (W / Math.max(1, H)));
    return mouse.sens * hfov / Math.max(320, W);
  }
  function mouseLook(dx, dy) {
    if (!dx && !dy) return;
    const k = mouseRadPerPx();
    gunner.yaw = wrapYaw(gunner.yaw - dx * k); // continuous yaw, wraps forever
    gunner.pitch = clampPitch(gunner.pitch - dy * k);
    gunner.yawV = 0; gunner.pitchV = 0;
  }
  function becomeDesktop() { if (!mouse.desktop) { mouse.desktop = true; document.body.classList.add("desktop"); } }
  if (mouse.desktop) document.body.classList.add("desktop");
  function updateLockHint() {
    if (!lockHint) return;
    const endShown = endBtn && !endBtn.classList.contains("hidden");
    const show = mouse.desktop && mouse.lockOK && !mouse.locked && state === "PLAYING" && !endShown;
    if (show === lockHint.classList.contains("hidden")) lockHint.classList.toggle("hidden", !show);
  }
  window.__FG_MOUSE = mouse;
  document.addEventListener("pointerlockchange", () => {
    mouse.locked = document.pointerLockElement === canvas;
    if (!mouse.locked && input.fireId === "mouse") { input.fire = false; input.fireId = null; }
    updateLockHint();
  });
  document.addEventListener("pointerlockerror", () => { mouse.lockOK = false; updateLockHint(); });
  // All mouse input rides on POINTER events (pointerType "mouse"): preventDefault on pointerdown suppresses the
  // compatibility mouse events, and chorded buttons only arrive as pointermove with a new ev.buttons mask.
  function mouseButtons(ev) { // hold LEFT = fire (only once aiming is live: locked, or the no-lock fallback)
    const live = mouse.locked || !mouse.lockOK;
    const want = live && state === "PLAYING" && (ev.buttons & 1) === 1;
    if (want && input.fireId !== "mouse") { input.fire = true; input.fireId = "mouse"; }
    else if (!want && input.fireId === "mouse") { input.fire = false; input.fireId = null; }
    mouse.dragBtns = ev.buttons | 0;
  }
  function mouseDown(ev) {
    becomeDesktop();
    if (state !== "PLAYING") return;
    ev.preventDefault();
    if (mouse.lockOK && !mouse.locked) { // the locking click never fires a burst
      try { const r = canvas.requestPointerLock(); if (r && r.catch) r.catch(() => { mouse.lockOK = false; }); } catch (e) { mouse.lockOK = false; }
      return;
    }
    mouseButtons(ev);
  }
  window.addEventListener("pointermove", (ev) => {
    if (ev.pointerType !== "mouse") return;
    becomeDesktop();
    if (state !== "PLAYING") return;
    if (mouse.locked || !mouse.lockOK) mouseButtons(ev);
    if (mouse.locked) mouseLook(ev.movementX || 0, ev.movementY || 0);
    else if (!mouse.lockOK && (ev.buttons | 0)) mouseLook(ev.movementX || 0, ev.movementY || 0); // fallback: drag to aim
  });
  window.addEventListener("pointerup", (ev) => { if (ev.pointerType === "mouse") mouseButtons(ev); });
  window.addEventListener("blur", () => { if (input.fireId === "mouse") { input.fire = false; input.fireId = null; } mouse.dragBtns = 0; });
  canvas.addEventListener("contextmenu", (ev) => { if (mouse.desktop) ev.preventDefault(); });
  window.addEventListener("keydown", (e) => { // [ and ] adjust mouse sensitivity (saved)
    if (e.key === "[" || e.key === "]") { mouse.sens = clamp(mouse.sens * (e.key === "]" ? 1.15 : 1 / 1.15), 0.25, 4); try { localStorage.setItem("fg_mouseSens", mouse.sens.toFixed(3)); } catch (er) {} pushCallout("MOUSE SENSITIVITY " + mouse.sens.toFixed(2) + "×", 0.9); }
    if (e.key === "Enter" && endBtn && !endBtn.classList.contains("hidden") && downSeq && !downSeq.finished) finishDownSeq();
  });

  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType === "mouse") { mouseDown(ev); return; } // 1.4.0-web: desktop mouse (touch + pen unchanged)
    const x = ev.clientX, y = ev.clientY;
    if (state !== "PLAYING") return;
    if (downSeq) { // 1.3.8: look around by dragging; a quick tap skips to the debrief (after SKIP_AT)
      input.downTap = { id: ev.pointerId, x, y, t: performance.now() };
      input.stickActive = true; input.stickId = ev.pointerId;
      input.stickX = x; input.stickY = y; input.lastX = x; input.lastY = y;
      ev.preventDefault();
      return;
    }
    // PERMANENT: LEFT HALF = FIRE anywhere; RIGHT HALF = LOOK/AIM anywhere
    // Circles are visual hints only — never the hit targets.
    if (x < W * 0.5) {
      input.fire = true;
      input.fireId = ev.pointerId;
      ev.preventDefault();
      return;
    }
    input.stickActive = true;
    input.stickId = ev.pointerId;
    input.stickX = x; input.stickY = y;
    input.lastX = x; input.lastY = y;
    input.stickVX = 0; input.stickVY = 0;
    ev.preventDefault();
  });

  window.addEventListener("pointermove", (ev) => {
    if (ev.pointerType === "mouse") return; // 1.4.0-web: mouse is handled by the mousemove path above
    if (state !== "PLAYING") return;
    if (input.stickActive && ev.pointerId === input.stickId) {
      // 1.3.3: direct drag-to-rotate — camera moves exactly with the finger, nothing after
      const dx = ev.clientX - input.lastX;
      const dy = ev.clientY - input.lastY;
      input.lastX = ev.clientX; input.lastY = ev.clientY;
      applyLookDelta(dx, dy);
      input.stickVX = clamp(-(ev.clientX - input.stickX) / 60, -1, 1); // hint knob only
      input.stickVY = clamp((input.stickY - ev.clientY) / 60, -1, 1);
      return;
    }
  });

  function endPointer(ev) {
    const tp = input.downTap;
    if (tp && tp.id === ev.pointerId) {
      input.downTap = null;
      // 1.4.0: no tap-to-skip any more — the END MISSION button ends it (a stray tap while looking around must not)
    }
    if (ev.pointerId === input.fireId) { input.fire = false; input.fireId = null; }
    if (ev.pointerId === input.stickId) {
      input.stickActive = false; input.stickId = null;
      input.stickVX = 0; input.stickVY = 0;
    }
    if (ev.pointerId === input.pointerId) { input.dragging = false; input.pointerId = null; }
  }
  window.addEventListener("pointerup", endPointer);
  window.addEventListener("pointercancel", endPointer);

  function setStick(x, y) {
    // LOOK: drag anywhere on right half — velocity from motion + offset from touch start
    const originX = input.stickX || (W * 0.75);
    const originY = input.stickY || (H * 0.72);
    const reach = Math.max(48, Math.min(W, H) * 0.18);
    let dx = (x - originX) / reach;
    let dy = (originY - y) / reach;
    const m = Math.hypot(dx, dy);
    if (m > 1) { dx /= m; dy /= m; }
    input.stickVX = -dx; // drag right → look right (3D camera-right = world -X)
    input.stickVY = dy;
  }

  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    input.keys[k] = true;
    if (k === " " || k === "enter") {
      if (state === "TITLE") startGame();
      else if (state === "GAMEOVER") restartGame();
      else input.fire = true;
      e.preventDefault();
    }
  });
  window.addEventListener("keyup", (e) => {
    const k = e.key.toLowerCase();
    input.keys[k] = false;
    if (k === " ") input.fire = false;
  });

  // 1.4.1 difficulty: EASY = the game as it was (gold lead pip + dashed lead line on the aimed 109, first-time lead
  // hint); MEDIUM = those markers removed. Remembered in localStorage "fg_difficulty". Buttons work on mouse + touch.
  try { const d = localStorage.getItem("fg_difficulty"); if (d === "medium" || d === "easy") difficulty = d; } catch (e) { /* no storage */ }
  function setDifficulty(d) {
    difficulty = d === "medium" ? "medium" : "easy";
    try { localStorage.setItem("fg_difficulty", difficulty); } catch (e) { /* no storage */ }
    for (const b of document.querySelectorAll("#diffRow .diffBtn")) { const on = b.dataset.diff === difficulty; b.classList.toggle("sel", on); b.setAttribute("aria-checked", on ? "true" : "false"); }
  }
  for (const b of document.querySelectorAll("#diffRow .diffBtn")) {
    b.addEventListener("click", (ev) => { ev.stopPropagation(); setDifficulty(b.dataset.diff); });
    b.addEventListener("touchstart", (ev) => { ev.stopPropagation(); }, { passive: true });
    b.addEventListener("pointerdown", (ev) => { ev.stopPropagation(); });
  }
  setDifficulty(difficulty);
  document.getElementById("startBtn").addEventListener("click", startGame);
  document.getElementById("restartBtn").addEventListener("click", restartGame);

  function startGame() {
    if (endBtn) endBtn.classList.add("hidden");
    ensureAudio();
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    titleEl.classList.add("hidden");
    gameoverEl.classList.add("hidden");
    resetRun();
    state = "PLAYING";
    pushCallout(mouse.desktop ? "BOX OF 19 — MOUSE AIMS · HOLD LEFT BUTTON TO FIRE" : MISSION_MODE ? "BOX OF 19 — LEFT FIRE · RIGHT AIM" : "LEFT FIRE · RIGHT LOOK", 1.4); // 1.4.0-web
  }
  function restartGame() {
    gameoverEl.classList.add("hidden");
    resetRun();
    state = "PLAYING";
    pushCallout("NEW CREW — SAME SKY", 2.0);
  }

  // playtest hook
  window.__FG = {
    start: startGame,
    restart: restartGame,
    state: () => ({
      mode: state, score, kills, cpuKills, wave,
      health: bomber ? bomber.health : 0,
      engOut: bomber ? engineOutCount(bomber.engines) : 0,
      viewRoll,
      heat: guns.heat, overheated: guns.overheated,
      yaw: gunner.yaw, pitch: gunner.pitch,
      enemies: enemies.filter((e) => e.alive).map((e) => ({
        type: e.type, x: e.x, y: e.y, z: e.z, hp: e.hp, phase: e.phase,
        vx: e.vx, vy: e.vy, vz: e.vz, bank: e.bank, speed: e.speed,
        pitchAtt: e.pitchAtt, yawAtt: e.yawAtt, energy: e.energy,
        alive: true,
        distFt: Math.hypot(e.x, e.y - BOMBER_AIM_Y, e.z) * FT_PER_UNIT,
        screen: project(e.x, e.y, e.z),
      })),
      flightModel: { ftPerUnit: FT_PER_UNIT, b17Mph: B17_MPH, bf109MaxMph: BF109_MPH_MAX },
      callout: calloutEl.textContent,
      immortal: true,
      controls: { left: "FIRE", right: "LOOK", mode: "half-screen", padsAreHintsOnly: true, lookX: "drag-right=look-right", lookXSign: -1 },
      brass: brass.length,
      enemyTracers: tracers.length,
      playerBullets: bullets.length,
      shake: gunner.shake,
      recoil: gunner.recoil,
      muzzle: guns.muzzle,
      skyTrails: skyTrails.length,
      friendlies: friendlies.length,
      pendingPair: !!pendingPair,
      assetsReady: assets.ready,
      mission: mission ? {
        passes: mission.passes || 0, bursts: mission.bursts || 0,
        timeLeft: mission.timeLeft,
        doorsOpen: mission.doorsOpen,
        bombsAway: mission.bombsAway,
        fightersSpawned: mission.fightersSpawned,
        bombersDropped: mission.bombersDropped,
        friendliesLost: mission.friendliesLost,
        bombCapable: countBombCapable(),
        aliveBombers: countAliveBombers(),
        phase: mission.phase,
        evaluated: mission.evaluated,
      } : null,
    }),
    aim: (yaw, pitch) => {
      if (yaw != null) gunner.yaw = wrapYaw(yaw);
      if (pitch != null) gunner.pitch = clamp(pitch, PITCH_MIN, PITCH_MAX);
      gunner.yawV = 0; gunner.pitchV = 0;
      input.swipeAimX = 0; input.swipeAimY = 0;
      input.stickVX = 0; input.stickVY = 0; input.stickActive = false;
    },
    lookAt: (x, y, z) => {
      const dx = x - CAM.x, dy = y - CAM.y, dz = z - CAM.z;
      gunner.yaw = wrapYaw(Math.atan2(dx, dz));
      const horiz = Math.hypot(dx, dz);
      gunner.pitch = clamp(Math.atan2(dy, horiz), PITCH_MIN, PITCH_MAX);
      gunner.yawV = 0; gunner.pitchV = 0;
      input.swipeAimX = 0; input.swipeAimY = 0;
      input.stickVX = 0; input.stickVY = 0; input.stickActive = false;
    },
    leadFlightTime: (dist) => leadFlightTime(Number(dist) || 0),
    /** Aim at lead pip of nearest on-screen bandit (same formula as hitscan). */
    leadAim: (preferId) => {
      let best = null, bestZ = 1e9;
      if (preferId) best = enemies.find((e) => e.alive && e.id === preferId) || null;
      if (!best) for (const e of enemies) {
        if (!e.alive || e.team === "allied") continue;
        const p = project(e.x, e.y, e.z);
        if (!p || p.z < 4) continue;
        if (p.z < bestZ) { best = e; bestZ = p.z; }
      }
      if (!best) return false;
      const lp = leadAimPoint(best);
      const dx = lp.x - CAM.x, dy = lp.y - CAM.y, dz = lp.z - CAM.z;
      gunner.yaw = wrapYaw(Math.atan2(dx, dz));
      const horiz = Math.hypot(dx, dz);
      gunner.pitch = clamp(Math.atan2(dy, horiz), PITCH_MIN, PITCH_MAX);
      gunner.yawV = 0; gunner.pitchV = 0;
      input.swipeAimX = 0; input.swipeAimY = 0;
      input.stickVX = 0; input.stickVY = 0; input.stickActive = false;
      return best.id || true;
    },
    fire: (on) => { input.fire = !!on; },
    setHeat: (h) => { guns.heat = h; if (h >= 1) guns.overheated = true; }, // test hook (1.5.6): force the overheat cut
    _bul: () => bullets.filter((b) => b.tracer).map((b) => { const sp = Math.hypot(b.vx, b.vy, b.vz) || 1; const tail = Math.min(b.trav || 0, 22); const q = projSeg(b.x, b.y, b.z, b.x - b.vx / sp * tail, b.y - b.vy / sp * tail, b.z - b.vz / sp * tail); return { trav: Math.round(b.trav), life: +b.life.toFixed(2), q: q && q.map((v) => Math.round(v)) }; }),
    attacker: (maxD) => {
      let best = null, bd = maxD || 500;
      for (const e of enemies) {
        if (!e.alive || e.phase !== "attack") continue;
        const d = Math.hypot(e.x - CAM.x, e.y - CAM.y, e.z - CAM.z);
        if (d < bd) { bd = d; best = e; }
      }
      return best ? best.id : 0;
    },
    stick: (x, y) => { applyLookDelta(-x * 40, -y * 40); },
    drag: (dx, dy) => { applyLookDelta(dx, dy); },
    friendlies: () => friendlies.map((f) => ({ name: f.name, x: f.x, y: f.y, z: f.z, yaw: f.yaw, bank: f.bank || 0, health: f.health, ok: friendlyOk(f), eng: f.engines.map((q) => +q.fire.toFixed(2) + (q.out ? "X" : "")) })),
    cam: () => ({ x: CAM.x, y: CAM.y, z: CAM.z }),
    fighters: () => enemies.map((e) => ({ sweep: e.sweep || 0, id: e.id, type: e.type, team: e.team, alive: e.alive, phase: e.phase, x: e.x, y: e.y, z: e.z, vx: e.vx, vy: e.vy, vz: e.vz, hx: e.hx, hy: e.hy, hz: e.hz, V: e.V, g: e.gLoad, bank: e.bank, p: e.p, ux: e.ux, uy: e.uy, uz: e.uz, w: e.turnW, mode: e.mode, diveT: e.diveT, dbg: e.dbg, dbg2: e.dbg2, tk: e.tgt ? e.tgt.kind : null, tt: e.target ? e.target.type : null, foe: e.foe ? e.foe.id : null, role: e.duelRole || null, hp: e.hp, sturm: !!e.sturm, fl: e.fl, slot: e.slot, f109: e.flight109, f190: e.flight190, hold: !!e.hold, strag: !!(e.tgt && isStragTgt(e.tgt)), drives: e.drives || 0, tx: e.tgt && e.tgt.kind === 'friendly' ? e.tgt.f.x : 0, tz: e.tgt && e.tgt.kind === 'friendly' ? e.tgt.f.z : 0, ty: e.tgt && e.tgt.kind === 'friendly' ? e.tgt.f.y : 0 })),
    aimBlocked: () => aimHitsOwnShip(),
    bulletsRaw: () => bullets.map((b) => ({ x: b.x - CAM.x, y: b.y - CAM.y, z: b.z - CAM.z, vx: b.vx, vy: b.vy, vz: b.vz, trav: b.trav, life: b.life })),
    ownPart: (x, y, z) => ownPartAt(x, y, z),
    difficulty: (d) => { if (d) setDifficulty(d); return difficulty; },
    missionInfo: () => mission ? { breakoffs: mission.breakoffs || 0, breakoffsBy: mission.breakoffsBy || {}, breakoffsStrag: mission.breakoffsStrag || 0, p51Icpt: mission.p51Icpt || [], p51Follow: mission.p51Follow || 0, firstShotT: mission.firstShotT, mt: mission.t, duelStarts: mission.duelStarts || 0, az190: mission.az190 || [], n190bingo: mission.n190bingo || 0, n190gone: mission.n190gone || 0, firstLaunch190: mission.firstLaunch190, p51x: { bursts: mission.p51Bursts || 0, burstsNear: mission.p51BurstsNear || 0, fireSec: +(mission.p51FireSec || 0).toFixed(1), fireSecNear: +(mission.p51FireSecNear || 0).toFixed(1), fightNearSec: +(mission.p51FightNearSec || 0).toFixed(1), fireWinSec: +(mission.p51FireWinSec || 0).toFixed(1), hits: mission.p51Hits || 0, drove: mission.p51Drove || 0, jumps: mission.p51Jumps || 0, endPass: mission.p51EndPass || 0, endLost: mission.p51EndLost || 0, endT: mission.p51EndT || 0, endDive: mission.p51EndDive || 0, endLeash: mission.p51EndLeash || 0 }, rkt: mission.rkt || { fired: 0, direct: 0, burst: 0, fragHits: 0, shooters: 0 }, r190: mission.r190 || null, p51cap: mission.p51cap || null, stragInfo: { outT: mission.playerOutT != null ? +mission.playerOutT.toFixed(1) : null, why: mission.playerOutWhy || null, hp: mission.playerOutHp != null ? mission.playerOutHp : null, passes: mission.stragPasses || 0, passes190: mission.strag190Passes || 0, hunters: mission.huntAssign || 0, stragSeen: mission.stragSeen || 0, k: playerStragK() }, p51ff: { hitYou: mission.p51HitYou || 0, hitGun: mission.p51HitGun || 0, lost: mission.p51Lost || 0, lostYou: mission.p51LostYou || 0, lostGun: mission.p51LostGun || 0, lostGer: mission.p51LostGer || 0 }, duelStarts: mission.duelStarts || 0, duelWhy: mission.duelWhy || null, duelSec: mission.duelSec || 0, p51Lost: mission.p51Lost || 0, duelGerHits: mission.duelGerHits || 0, duelGerBursts: mission.duelGerBursts || 0, duelP51Bursts: mission.duelP51Bursts || 0, idleEnd: idleAxisNow(), killsBy: mission.killsBy || {}, firstSeenT: mission.firstSeenT, fireSpeeds: mission.fireSpeeds || [], evades: mission.evades || 0, waves: mission.waves || 0, finalN: mission.finalN, t: mission.t, firstShotT: mission.firstShotT, passes: mission.passes, bursts: mission.bursts, lost: mission.friendliesLost, killed: mission.fightersKilled, cpuKills, youKills: kills, cpuShots: mission.cpuShots || 0, cpuHits: mission.cpuHits || 0, ff: mission.friendlyHits || 0, ffCpu: mission.friendlyHitsCpu || 0, ffLost: mission.friendlyFFLost || 0, dropped: mission.bombersDropped, done: mission.evaluated, modeStats: mission.modeStats, heading: mission.heading || 0, post: mission.post, ownHits: mission.ownHits || 0, engHits: mission.hs || null, cpuTracers: mission.cpuTracers || 0, gunStats: mission.gunStats || null, tail: bomber ? bomber.tail.fire : 0, engFire: bomber ? bomber.engines.map((q) => +q.fire.toFixed(2)) : null, phases: enemies.filter((q) => q.alive).reduce((a, q) => { a[q.phase] = (a[q.phase] || 0) + 1; return a; }, {}), alive109: MISSION_FIGHTERS - mission.fightersKilled, state, playerDead: !!(bomber && bomber.dead), downAt: downSeq ? downSeq.missionT : null, downCause: downSeq ? downSeq.cause : null, chutesSpawned: mission.chutes || 0, health: bomber ? bomber.health : 0, flak: mission.flakStats || null, timeLeft: mission.timeLeft, outLog: mission.outLog || [], outBox: outBoxCount(), hitLog: mission.hitLog || null, hitVic: mission.hitVic || null, passAgg: mission.passAgg || null, kYou: mission.kYou || 0, kGun: mission.kGun || 0, kP51: mission.kP51 || 0, p51: { jumps: mission.p51Jumps || 0, on190: mission.p51On190 || 0, hits: mission.p51Hits || 0, kills: mission.p51Kills || 0, kills190: mission.p51Kills190 || 0, drove: mission.p51Drove || 0, abort109: mission.p51Abort || 0, bursts: mission.p51Bursts || 0, endT: mission.p51EndT || 0, endLost: mission.p51EndLost || 0, endLeash: mission.p51EndLeash || 0, endDive: mission.p51EndDive || 0, endPass: mission.p51EndPass || 0, egress: mission.p51Egress || 0 }, waves190: mission.waves190 || 0, s190: { seen: mission.n190seen || 0, killedSeen: mission.k190seen || 0, drove: mission.n190drove || 0, killed: mission.k190 || 0 }, slipOn190: !!mission.slipOn190, 
      fHealth: friendlies.map((f) => Math.round(f.health)), player: bomber ? Math.round(bomber.health) : null, VF, MPH } : null,
    hitEnemy: (id, n) => {
      const e = enemies.find((q) => q.id === id);
      if (!e || !e.alive) return -1;
      for (let i = 0; i < (n || 1); i++) { e.hp -= 1; spawnHit(e); if (e.hp <= 0) { killEnemy(e, false); break; } }
      return e.hp;
    },
    // debug: freeze a set of static posed fighters (distance / render tests). arr: [{x,y,z,hx,hy,hz,bank}]
    project: (x, y, z) => project(x, y, z),
    testTracers: (x, y, z, red, n) => { for (let i = 0; i < (n || 6); i++) tracers.push({ x: CAM.x + x + i * 0.8, y: CAM.y + y + i * 0.15, z: CAM.z + z + i * 3.5, vx: 0, vy: 0, vz: -BULLET_UPS * 0.02, life: 1.5, maxLife: 1.8, trav: 22, team: "axis", hid: false, k190: !!red }); }, // 1.5.3 test hook: static enemy tracers (red = 190)
    poseFighters: (arr) => {
      enemies = arr.map((p, i) => { const e = makeMissionFighter(p.type); Object.assign(e, { id: "dbg" + i, phase: "debug", x: p.x, y: p.y, z: p.z, V: 150, hp: 5, maxHp: 5 }); initAttitude(e, { x: p.hx, y: p.hy, z: p.hz }, p.bank || 0); e.vx = 0; e.vy = 0; e.vz = 0; return e; });
      return enemies.length;
    },
    enemyPos: (id) => { const e = enemies.find((q) => q.id === id); return e ? { x: e.x, y: e.y, z: e.z, alive: e.alive, hp: e.hp } : null; },
    rocketList: () => rockets.map((r) => ({ x: r.x, y: r.y, z: r.z, t: r.t })),
    ffTest: (idx, by, n, aimOffset) => { // test hook: fire n swept rounds at Mustang #idx's mesh centre from 120 u away
      const ps = enemies.filter((q) => q.type === "p51" && q.alive); const e = ps[idx | 0]; if (!e) return null;
      const hp0 = e.hp; let hits = 0;
      for (let i = 0; i < n && e.alive; i++) { const d = norm3(e.hx, e.hy, e.hz), ox = e.x - d.x * 120 + (aimOffset || 0), oy = e.y - d.y * 120, oz = e.z - d.z * 120; const mh = hitMustangSeg(ox, oy, oz, e.x + d.x * 5 + (aimOffset || 0) * 0.0, e.y + d.y * 5, e.z + d.z * 5); if (mh) { hits++; ffMustang(mh.e, mh.fh, by); } }
      return { hp0, hp: e.hp, alive: e.alive, hits, id: e.id };
    },
    tgtResult: () => { const r = tgtResult(); return r; }, tgtState: () => { const t = mission && mission.tgt; return t ? { n: t.n, landed: t.landed, onYard: t.onYard, pts: t.pts } : null; }, // 1.5.3 test hooks
        killShip: (who, why) => { const s = who === "player" ? bomber : friendlies.filter((f) => friendlyOk(f))[who | 0]; if (!s) return false; s.lastSrc = s.lastSrc || "190"; if (s.sd && why === "wingroot") { s.sd.wr[0] = 0; s.sd.wr[1] = 0; } destroyShip(s, why || "wingroot"); return true; }, // 1.5.3 test hook: natural (random) death pick
    forceOut: (why) => { if (bomber && !bomber.dead) { bomber.engines[0].out = true; bomber.engines[1].out = true; leaveBox(bomber, why || "engines"); } },
    forceDeath: (who, kind, side) => { const s = who === "player" ? bomber : friendlies.filter((f) => friendlyOk(f))[who | 0]; if (!s) return false; s.forceDeath = { kind, side: side || 1 }; s.lastSrc = s.lastSrc || "190"; destroyShip(s, "forced"); return true; },
    deathLog: () => (mission && mission.deathLog) || [],
    forceOutFriendly: (n, why) => { let k = 0; for (const f of friendlies) if (friendlyOk(f) && !f.out && k < n) { leaveBox(f, why || "engines"); k++; } return k; },
    ownEngine: (i, fire, out) => { if (!bomber) return; const e = bomber.engines[i]; e.fire = fire; e.out = !!out; },
    // Deterministic time advance for headless playtests (rAF+dt-cap runs slow under SwiftShader)
    advance: (sec) => {
      const s = Math.max(0, Number(sec) || 0);
      const step = 0.016;
      let left = s;
      while (left > 0.0001) {
        const dt = Math.min(step, left);
        update(dt);
        left -= dt;
      }
    },
    seedEnemy: (type) => spawnEnemy(type || "109"),
    placeEnemy: (type, x, y, z) => {
      spawnEnemy(type || "109");
      const e = enemies[enemies.length - 1];
      if (!e) return;
      e.x = x; e.y = y; e.z = z;
      e.phase = "attack";
      // Keep visible motion even in posed shots — never hover at vz≈0
      const toC = Math.hypot(CAM.x - x, CAM.y - y, CAM.z - z) || 1;
      e.vx = (CAM.x - x) / toC * 4.5 + rand(-1.5, 1.5);
      e.vy = (CAM.y - y) / toC * 2.0;
      e.vz = (CAM.z - z) / toC * 4.5 - 3.2;
      e.speed = Math.hypot(e.vx, e.vy, e.vz);
      attitudeFromVel(e);
      e.bank = (x >= 0 ? 1 : -1) * 0.7;
      if (MISSION_MODE) { // real flight model: head at us at 350 mph airspeed
        const h = norm3(CAM.x + 40 - x, CAM.y - 25 - y, CAM.z - z + VF * 2);
        e.V = 350 * MPH; initAttitude(e, h, 0);
        e.tgt = { kind: "player" }; commitPass(e); e.burstsLeft = 0;
      }
      return e.id;
    },
    damage: (n) => { if (bomber) flakDamage(bomber, n || 10, 1); return bomber ? bomber.health : 0; }, // test hook (1.5.4: was a dead reference)
    tune: (o) => Object.assign(TUNE, o || {}),
    gunsDbg: () => { const out = []; for (const f of friendlies) { if (!f.guns || !friendlyOk(f)) continue; const c = Math.cos(f.yaw || 0), sn = Math.sin(f.yaw || 0); f.guns.forEach((g, gi) => { if (!(g.burst > 0 && g.tgt && g.tgt.alive)) return; const G = CPU_GUNS[gi]; const ox = f.x + G.p[0] * c + G.p[2] * sn, oy = f.y + G.p[1], oz = f.z - G.p[0] * sn + G.p[2] * c; const dx = g.tgt.x - ox, dy = g.tgt.y - oy, dz = g.tgt.z - oz, d = Math.hypot(dx, dy, dz) || 1; out.push({ gi, n: CPU_GUNS.length, tid: g.tgt.id, lx: (dx * c - dz * sn) / d, ly: dy / d, lz: (dx * sn + dz * c) / d, ship: f.name }); }); } return out; },
    killPlayer: (cause) => { playerShotDown(cause || "__test"); return !!downSeq; },
    downInfo: () => downSeq ? { T: +downSeq.T.toFixed(2), phase: downSeq.phase, cause: downSeq.cause, missionT: downSeq.missionT, eye: { x: EYE.x, y: EYE.y, z: EYE.z }, roll: viewRoll, ship: { x: downSeq.ship.x, y: downSeq.ship.y, z: downSeq.ship.z, pd: downSeq.ship.pd, tailOff: !!downSeq.ship.tailOff, wingOff: downSeq.ship.wingOff || 0, kind: downSeq.kind }, chute: downSeq.chute ? { y: downSeq.chute.y, z: downSeq.chute.z, vy: downSeq.chute.vy, vz: downSeq.chute.vz, t: downSeq.chute.t } : null, finished: downSeq.finished } : null,
    skipDown: () => { if (downSeq) finishDownSeq(); return state; },
    chutes: () => chutes.map((c) => ({ id: c.id, kind: c.kind, x: c.x, y: c.y, z: c.z, open: c.open, t: c.t })),
    spawnChute: (x, y, z, kind) => spawnChute(x, y, z, 0, -4, -VF, kind || "us", 0.01),
    tracerExtra: (arr) => { tracerExtra.length = 0; if (arr) for (const q of arr) tracerExtra.push(q); return tracerExtra.length; },
    clearTracers: () => { tracers.length = 0; bullets.length = 0; },
    clearBandits: () => {
      enemies = [];
      spawnQueue = 0;
      spawnTimer = 99;
      wavePause = 999;
    },
    resetStats: () => {
      score = 0; kills = 0; hitsLanded = 0; wave = 1;
      leadDebug.hitscanOk = 0; leadDebug.hitscanReject = 0; leadDebug.ballOk = 0; leadDebug.ballReject = 0; leadDebug.sepSum = 0; leadDebug.sepN = 0;
      if (bomber) { bomber.health = 100; bomber.flash = 0; }
      updateHud();
    },
    leadDebug: () => ({
      ...leadDebug,
      sepAvg: leadDebug.sepN ? leadDebug.sepSum / leadDebug.sepN : 0,
    }),
    seedDive: (type, style, stagger) => {
      const stStyle = style || "frontal";
      spawnEnemy(type || "109", { type: type || "109", style: stStyle, muteCall: true });
      const e = enemies[enemies.length - 1];
      if (!e) return null;
      const side = (stStyle === "beam" || Math.random() < 0.5) ? (e.passSide || 1) : -(e.passSide || 1);
      e.passSide = side;
      e.nextStyle = stStyle;
      const st = Number(stagger) || 0;
      if (stStyle === "beam") {
        e.x = side * (70 + st * 8);
        e.y = BOMBER_AIM_Y + 54;
        e.z = 128 - st * 6;
      } else if (stStyle === "highside") {
        e.x = side * (78 + st * 8);
        e.y = BOMBER_AIM_Y + 56;
        e.z = 128 + st * 8;
      } else if (stStyle === "lowclimb") {
        e.x = side * (22 + st * 6);
        e.y = BOMBER_AIM_Y - 58;
        e.z = 118 + st * 8;
      } else {
        e.x = side * (92 + st * 8);
        e.y = BOMBER_AIM_Y + 58;
        e.z = 122 + st * 10;
      }
      e.phase = "dive"; e.phaseT = 0; e.energy = 460;
      e.weaveAmp = 22; e.smoke = 0.45; e.trail = [];
      const boost = stStyle === "highside" ? 24.0 : stStyle === "lowclimb" ? 21.0 : stStyle === "beam" ? 18.5 : 19.5;
      const ty = stStyle === "lowclimb" ? BOMBER_AIM_Y + 10 : BOMBER_AIM_Y - 4;
      setVelToward(e, -side * (stStyle === "beam" ? 36 : stStyle === "highside" ? 28 : 34), ty, 2, mphRel(490, boost));
      attitudeFromVel(e);
      intercomBanditCall(e.x, e.z, stStyle);
      return { id: e.id, x: e.x, y: e.y, z: e.z, clock: clockLabel(e.x, e.z), style: stStyle };
    },
    seedPair: (type, style) => {
      enqueuePair();
      if (type || style) {
        // override pending + last lead
        const lead = enemies[enemies.length - 1];
        if (lead) {
          if (type) lead.type = type;
          if (style) lead.nextStyle = style;
        }
        if (pendingPair) {
          if (type) pendingPair.type = type;
          if (style) pendingPair.style = style;
        }
      }
      return { pending: !!pendingPair, enemies: enemies.length };
    },
    dbg: () => (mission ? { heading: mission.heading || 0, post: mission.post || 0, turning: !!mission.turningBack, timeLeft: mission.timeLeft, phase: mission.phase, geoRot: mission.geo ? mission.geo.rot : 0 } : null),
    friendliesRaw: () => friendlies.map((f) => ({ ...f })),
    skyTrailCount: () => skyTrails.length,
    flak: (x, y, z, delay) => { if (!mission) return; const F = mission.flakStats || (mission.flakStats = { bursts: 0, near: 0, hitsF: 0, lostF: 0, blown: 0, hitsP: 0, closeP: 0 }); spawnFlakBurst(x, y, z, delay || 0, F); },
    flakList: () => flakBursts.map((b) => ({ id: b.id, x: b.x, y: b.y, z: b.z, t: b.t })),
    boxC: () => ({ x: BOX_C.x, y: BOX_C.y, z: BOX_C.z }),
    god: (b) => { godMode = !!b; },
    p51Tracers: () => tracers.filter((t) => t.p51 && t.life > 0).map((t) => ({ x: t.x, y: t.y, z: t.z, vx: t.vx, vy: t.vy, vz: t.vz })), // 1.5.4 test hook
    // 1.4.0 harness: look in the SHIP frame (deg; yaw 0 = nose, 180 = tail) and set our ship's health (drives the damage look)
    lookFromEye: (x, y, z) => { const dx = x - EYE.x, dy = y - EYE.y, dz = z - EYE.z; gunner.yaw = wrapYaw(Math.atan2(dx, dz)); gunner.pitch = clamp(Math.atan2(dy, Math.hypot(dx, dz)), PITCH_MIN, PITCH_MAX); gunner.yawV = 0; gunner.pitchV = 0; return [gunner.yaw, gunner.pitch]; },
    look: (ywDeg, ptDeg) => { gunner.yaw = wrapYaw(ywDeg * Math.PI / 180); gunner.pitch = clamp(ptDeg * Math.PI / 180, PITCH_MIN, PITCH_MAX); gunner.yawV = 0; gunner.pitchV = 0; input.swipeAimX = 0; input.swipeAimY = 0; input.stickVX = 0; input.stickVY = 0; input.stickActive = false; },
    setHealth: (h) => { if (bomber) { bomber.health = h; healthEngineCheck(); } },
    forceRoll: (r) => { forcedRoll = r == null ? null : +r; if (forcedRoll != null) viewRoll = forcedRoll; },
    // aim at a WORLD point through the (rolled / spinning) airframe: yaw/pitch are in the ship's frame
    lookAtWorld: (x, y, z) => {
      const O = ownPose().o === CAM ? EYE : EYE; const l = toOwnLocal(ownPose(), x - O.x, y - O.y, z - O.z);
      gunner.yaw = wrapYaw(Math.atan2(l.x, l.z)); gunner.pitch = clamp(Math.atan2(l.y, Math.hypot(l.x, l.z)), PITCH_MIN, PITCH_MAX);
      gunner.yawV = 0; gunner.pitchV = 0; input.swipeAimX = 0; input.swipeAimY = 0; input.stickVX = 0; input.stickVY = 0; input.stickActive = false;
    },
    ownLocalToWorld: (x, y, z) => { // own frame → world (forward rotation Rz → Rx → Ry)
      const P = ownPose(); let c = Math.cos(P.Rl), s = Math.sin(P.Rl);
      let x1 = x * c - y * s, y1 = x * s + y * c, z1 = z;
      c = Math.cos(P.P); s = Math.sin(P.P); const y2 = y1 * c - z1 * s, z2 = y1 * s + z1 * c;
      c = Math.cos(P.Y); s = Math.sin(P.Y); return { x: P.o.x + x1 * c + z2 * s, y: P.o.y + y2, z: P.o.z - x1 * s + z2 * c };
    },
    ownSeg: (x0, y0, z0, x1, y1, z1) => { const h = hitOwnShipSeg(x0, y0, z0, x1, y1, z1, 99); return h ? { part: h.part, x: h.x + CAM.x, y: h.y + CAM.y, z: h.z + CAM.z, lx: h.lx, ly: h.ly, lz: h.lz } : null; },
    ownHitLog: () => (mission && mission.ownHitLog) || [],
    fHitLog: () => (mission && mission.fHitLog) || [],
    fMeshMiss: () => (mission && mission.fMeshMiss) || 0,
    fighterDecals: (id) => World3D && World3D.fighterDecalInfo ? World3D.fighterDecalInfo(id) : null,
    pinFighter: (id, o) => { const e = enemies.find((q) => q.id === id); if (!e) return null; o = o || {}; if (o.x != null) { e.x = o.x; e.y = o.y; e.z = o.z; } if (o.h) { e.hx = o.h[0]; e.hy = o.h[1]; e.hz = o.h[2]; } if (o.u) { e.ux = o.u[0]; e.uy = o.u[1]; e.uz = o.u[2]; } if (o.bank != null) e.bank = o.bank; e.vx = e.vy = e.vz = 0; e.hp = o.hp || 999; e.maxHp = e.hp; e.phase = "reform"; return { x: e.x, y: e.y, z: e.z, hx: e.hx, hy: e.hy, hz: e.hz, ux: e.ux, uy: e.uy, uz: e.uz }; },
    rayFighterId: (id, x0, y0, z0, x1, y1, z1) => { const e = enemies.find((q) => q.id === id); return e && World3D && World3D.rayFighter ? World3D.rayFighter(e, x0, y0, z0, x1, y1, z1) : null; },
    shootSeg: (x0, y0, z0, x1, y1, z1) => { // one round along this segment through the REAL hit path; reports what it struck
      const dt = 1 / 60, b = { x: x1, y: y1, z: z1, vx: (x1 - x0) / dt, vy: (y1 - y0) / dt, vz: (z1 - z0) / dt, trav: 99 };
      const hp = enemies.map((e) => e.hp), fh = friendlies.map((f) => f.health), oh = mission && mission.ownHitLog ? mission.ownHitLog.length : 0, fl = mission && mission.fHitLog ? mission.fHitLog.length : 0;
      const r = hitTestBullet(b, dt);
      const out = { hit: !!r, fighter: null, friendly: null, own: null };
      enemies.forEach((e, i) => { if (e.hp !== hp[i]) out.fighter = { id: e.id, at: mission && mission.fHitLog ? mission.fHitLog[mission.fHitLog.length - 1] : null }; });
      friendlies.forEach((f, i) => { if (f.health !== fh[i]) out.friendly = { slot: f.slot != null ? f.slot : i }; });
      if (mission && mission.ownHitLog && mission.ownHitLog.length > oh) out.own = mission.ownHitLog[mission.ownHitLog.length - 1];
      if (r && !out.fighter && !out.friendly && !out.own) { const h = hitOwnShipSeg(x0, y0, z0, x1, y1, z1, 99); if (h) out.own = { part: h.part, x: h.x + CAM.x, y: h.y + CAM.y, z: h.z + CAM.z, lx: h.lx, ly: h.ly, lz: h.lz, deadShip: true }; }
      return out;
    },
    ffSeg: (x0, y0, z0, x1, y1, z1, exact, fi) => { const skipAll = fi != null; const keep = friendlies[fi]; const h = skipAll ? (() => { const save = friendlies.slice(); friendlies.length = 0; friendlies.push(keep); const r = hitFriendlySeg(x0, y0, z0, x1, y1, z1, null, !!exact); friendlies.length = 0; for (const q of save) friendlies.push(q); return r; })() : hitFriendlySeg(x0, y0, z0, x1, y1, z1, null, !!exact); return h ? { part: h.part, x: h.x, y: h.y, z: h.z, slot: h.slot } : null; },
    friendlyLocalOf: (i, x, y, z) => { const f = friendlies[i]; return f ? friendlyLocal(f, x - f.x, y - f.y, z - f.z) : null; },
    setFriendly: (i, o) => { const f = friendlies[i]; if (!f) return null; Object.assign(f, o || {}); return { x: f.x, y: f.y, z: f.z, yaw: f.yaw, bank: f.bank }; },
    projectW: (x, y, z) => { const p = project(x, y, z); return p ? { sx: p.sx, sy: p.sy } : null; },
    clearFx: () => { particles.length = 0; hitMarks.length = 0; },
    fx154: () => ({ n: fx154.n, peakKick: +fx154.peakKick.toFixed(3), peakBlur: +fx154.peakBlur.toFixed(3), peakVig: +fx154.peakVig.toFixed(3), cabin: fx154.cabin.length, kicks: fx154.kicks.length, blur: fx154.blur, vib: fx154.vib }),
    fireTest154: (slot, ks, own) => { const f = own ? bomber : friendlies.find((q) => (q.slot != null ? q.slot : -1) === slot) || friendlies[slot]; if (!f || !f.sd) return null; for (const k of ks) { f.sd.eng[k].fire = true; } syncShip(f); return f.engines.map((e) => +e.fire.toFixed(2)); },
    holeTest154: (slot, n, size, own) => { // test hook: rounds through the German hole path (holes + torn skin) on friendly `slot`, or on the player's ship
      const f = own ? bomber : friendlies.find((q) => (q.slot != null ? q.slot : -1) === slot) || friendlies[slot]; if (!f) return null;
      const P = own ? { x: CAM.x, y: CAM.y, z: CAM.z } : { x: f.x, y: f.y, z: f.z }; let k = 0;
      for (let i = 0; i < n; i++) { f.holeT = -9; const sg = (own ? 1 : (P.x < 0 ? -1 : 1)), y = P.y + (Math.random() * 3 - 0.8), z = P.z + (Math.random() * 16 - 8); holeAt(f, P.x + sg * 40, y, z, P.x - sg * 40, y, z, size || 0.2); k++; }
      return { n: k, holeN: f.holeN };
    },
    fxTest154: (what, a, b2) => { if (what === 'flak') addKick('flak', a || 0.4); else if (what === 'cannon') addKick('cannon', a || 0.17); else if (what === 'cabin') cabinHit(a == null ? 0.8 : a, 'test'); else if (what === 'cluster') hitCluster(CAM.x + (a || 0), CAM.y + (b2 || 0), CAM.z + 40, 0, 0, 0, true, 1); },
    // 1.3.9: harmonisation check — fire one spread-free round from each gun along the current look
    // with the real launch code + balStep, report where it crosses the 320 u plane vs the sight line
    convTest: (yawDeg, pitchDeg, sdt = 1 / 60) => {
      if (yawDeg != null) { gunner.yaw = yawDeg * Math.PI / 180; gunner.pitch = pitchDeg * Math.PI / 180; }
      const bs = lookBasis(), out = [];
      for (const side of [0, 1]) {
        const m = muzzleWorld(side);
        const cx = CAM.x + bs.fx * CONV_R, cy = CAM.y + bs.fy * CONV_R, cz = CAM.z + bs.fz * CONV_R;
        const cc = aimCorr(bs.fx, bs.fy, bs.fz);
        const ax = cx + cc[0], ay = cy + cc[1], az = cz + cc[2];
        const L = Math.hypot(ax - m.x, ay - m.y, az - m.z) || 1;
        const r = { x: m.x, y: m.y, z: m.z, vx: (ax - m.x) / L * BULLET_UPS, vy: (ay - m.y) / L * BULLET_UPS, vz: (az - m.z) / L * BULLET_UPS };
        const noCorr = Math.acos(clamp(((cx - m.x) * (ax - m.x) + (cy - m.y) * (ay - m.y) + (cz - m.z) * (az - m.z)) / (Math.hypot(cx - m.x, cy - m.y, cz - m.z) * L), -1, 1)) * 180 / Math.PI;
        let t = 0, al = 0, pal = 0;
        while (t < 3) { balStep(r, sdt); t += sdt; pal = al; al = (r.x - CAM.x) * bs.fx + (r.y - CAM.y) * bs.fy + (r.z - CAM.z) * bs.fz; if (al >= CONV_R) break; }
        const k = al > pal ? (CONV_R - pal) / (al - pal) : 1;
        const hx = r.px + (r.x - r.px) * k - CAM.x, hy = r.py + (r.y - r.py) * k - CAM.y, hz = r.pz + (r.z - r.pz) * k - CAM.z;
        const ang = Math.acos(clamp((hx * bs.fx + hy * bs.fy + hz * bs.fz) / Math.hypot(hx, hy, hz), -1, 1)) * 180 / Math.PI;
        out.push({ side, errDeg: ang, missU: Math.hypot(hx - bs.fx * CONV_R, hy - bs.fy * CONV_R, hz - bs.fz * CONV_R), tof: t - sdt * (1 - k), corrDeg: noCorr, drop: -(cc[1]) });
      }
      return out;
    },
    holdOff: (x, y, z) => holdOff(x, y, z),
    // 1.3.9: one of our rounds and a box-gunner tracer launched with the same state; after the air
    // frame turns they must still be in the same place (both swing with the formation)
    twinRound: (dx, dy, dz) => { const L = Math.hypot(dx, dy, dz); const o = { x: CAM.x, y: CAM.y + 3, z: CAM.z, vx: dx / L * BULLET_UPS, vy: dy / L * BULLET_UPS, vz: dz / L * BULLET_UPS }; const bl = Object.assign({ life: BULLET_LIFE, tracer: true, side: 0, trav: 0, twin: 1 }, o); bullets.push(bl); const tr = Object.assign({ life: BULLET_LIFE, maxLife: BULLET_LIFE, trav: 0, team: "allied", twin: 1 }, o); tracers.push(tr); window.__twin = [bl, tr]; return true; },
    twinCheck: () => { const t = window.__twin; if (!t) return null; const [b, r] = t; return { sep: Math.hypot(b.x - r.x, b.y - r.y, b.z - r.z), bLife: b.life, rLife: r.life, heading: mission ? mission.heading || 0 : null, roll: mission ? mission.turnRoll || 0 : null, b: { x: b.x - CAM.x, z: b.z - CAM.z } }; },
    balInfo: () => ({ BAL_G, BAL_K, BULLET_UPS, BULLET_LIFE, VF, CONV_R }),
    // world-space fighter pin with attitude for the flyby harness
    lodOf: (id) => (World3D && World3D.lodOf ? World3D.lodOf(id) : null),
    lastSparks: (n) => particles.filter((q) => q.kind === "spark").slice(-(n || 8)).map((q) => ({ x: q.x, y: q.y, z: q.z })),
    friendlyPose: () => friendlies.map((f, i) => ({ i, slot: f.slot != null ? f.slot : i, x: f.x, y: f.y, z: f.z, yaw: f.yaw || 0, bank: f.bank || 0, ok: friendlyOk(f), spiraling: !!f.spiraling })),
    forcePhase: (phase) => {
      for (const e of enemies) {
        if (!e.alive) continue;
        e.phase = phase || "dive";
        e.phaseT = 0;
      }
    },
    /** Run N seconds of gameplay logic at fixed 60Hz (headless-safe). */
    sim: (seconds) => {
      const n = Math.max(0, Number(seconds) || 0);
      const steps = Math.min(4000, Math.ceil(n / (1 / 60)));
      for (let i = 0; i < steps; i++) update(1 / 60);
    },
  };
})();
