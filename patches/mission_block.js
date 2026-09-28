
  // ===== MISSION MODE 1.3.0 — combat box / bomb run / 44× Bf 109 =====
  const MISSION_DURATION = 120;       // seconds until target
  const MISSION_DOORS_AT = 105;       // remaining when bay doors open (t=15s)
  const MISSION_RELEASE_AT = 98;      // remaining when bombs away (~t=22s)
  const MISSION_BOMBERS = 19;         // including player
  const MISSION_FIGHTERS = 44;
  const MISSION_WIN_DROPS = 15;
  const BF109_FLAT_MAX_MPH = 350;     // brief: flat max 350 mph
  const MISSION_MODE = true;          // default play mode

  let mission = null;

  function makeEngineSet() {
    return [
      { id: 0, fire: 0, out: false },
      { id: 1, fire: 0, out: false },
      { id: 2, fire: 0, out: false },
      { id: 3, fire: 0, out: false },
    ];
  }

  /** Historical-ish 19-ship combat box slots (player is ship 0 at origin — not drawn). */
  function combatBoxSlots() {
    // Units: 100 ft. Tight phone-readable box ahead / abeam / trail.
    return [
      // Lead element (ahead)
      { x:  0,  y:  6, z:  52 },
      { x: 28,  y: 10, z:  62 },
      { x: -28, y:  4, z:  58 },
      // High squadron (starboard-high)
      { x: 58,  y: 24, z:  28 },
      { x: 82,  y: 30, z:  42 },
      { x: 72,  y: 22, z:   8 },
      { x: 98,  y: 28, z:  55 },
      { x: 48,  y: 20, z: -12 },
      { x: 110, y: 32, z:  18 },
      // Low squadron (port-low)
      { x: -58, y: -6, z:  22 },
      { x: -84, y: -10,z:  36 },
      { x: -72, y: -4, z:   4 },
      { x: -100,y: -12,z:  48 },
      { x: -48, y: -8, z: -14 },
      { x: -112,y: -6, z:  12 },
      // Trail / rear element
      { x:  22, y:  6, z: -42 },
      { x: -22, y:  2, z: -48 },
      { x:   0, y: 12, z: -72 },
    ];
  }

  function initMissionState() {
    mission = {
      timeLeft: MISSION_DURATION,
      fightersSpawned: 0,
      fightersKilled: 0,
      doorsOpen: false,
      bombsAway: false,
      turningBack: false,
      evaluated: false,
      bombersDropped: 0,
      cityVisible: false,
      spawnAcc: 0,
      gunnerTick: 0,
      phase: "ingress",
    };
  }

  function countBombCapable() {
    // Player always can drop (immortal). Friendlies must be alive & not spiraling.
    let n = 1;
    for (const f of friendlies) {
      if (f.alive && !f.spiraling && f.health > 0) n++;
    }
    return n;
  }

  function countAliveBombers() {
    let n = 1; // player
    for (const f of friendlies) if (f.alive && f.health > 0) n++;
    return n;
  }

  function damageFriendly(f, amount) {
    if (!f || !f.alive || f.spiraling) return;
    f.health = Math.max(0, f.health - amount);
    f.flash = 1;
    const eng = f.engines[(Math.random() * 4) | 0];
    eng.fire = Math.min(1, eng.fire + 0.4 + (f.health < 40 ? 0.2 : 0));
    if (eng.fire > 0.85) eng.out = true;
    // Listing toward dead engines
    const left = (f.engines[0].out || f.engines[0].fire > 0.5 ? 1 : 0)
               + (f.engines[1].out || f.engines[1].fire > 0.5 ? 1 : 0);
    const right = (f.engines[2].out || f.engines[2].fire > 0.5 ? 1 : 0)
                + (f.engines[3].out || f.engines[3].fire > 0.5 ? 1 : 0);
    f.listTarget = (right - left) * 0.18;
    if (f.health <= 0) {
      f.alive = false;
      f.spiraling = true;
      f.spiralT = 0;
      f.vy = -rand(1.5, 3.5);
      f.vx = rand(-4, 4);
      f.vz = rand(-2, 2);
      pushCallout((f.name || "FORTRESS") + " GOING DOWN!", 1.6);
      sfxDamage();
      score = Math.max(0, score - 25);
    }
  }

  function pickFormationTarget(attacker) {
    // Prefer nearby friendlies; sometimes the player (weighted).
    const candidates = [];
    candidates.push({ kind: "player", w: 1.6, dist: Math.hypot(attacker.x, attacker.y - BOMBER_AIM_Y, attacker.z) });
    for (const f of friendlies) {
      if (!f.alive || f.spiraling) continue;
      const d = Math.hypot(attacker.x - f.x, attacker.y - f.y, attacker.z - f.z);
      candidates.push({ kind: "friendly", f, w: 1.0 / (0.35 + d * 0.012), dist: d });
    }
    let sum = 0;
    for (const c of candidates) sum += c.w;
    let r = Math.random() * sum;
    for (const c of candidates) {
      r -= c.w;
      if (r <= 0) return c;
    }
    return candidates[0];
  }

  function updatePlayerList(dt) {
    if (!bomber) return;
    const en = bomber.engines;
    const left = (en[0].fire > 0.35 ? 1 : 0) + (en[1].fire > 0.35 ? 1 : 0)
               + (en[0].out ? 1 : 0) + (en[1].out ? 1 : 0);
    const right = (en[2].fire > 0.35 ? 1 : 0) + (en[3].fire > 0.35 ? 1 : 0)
                + (en[2].out ? 1 : 0) + (en[3].out ? 1 : 0);
    const want = clamp((right - left) * 0.14, -0.35, 0.35);
    bomber.list = lerp(bomber.list || 0, want, 1 - Math.pow(0.08, dt));
    // Mark engines out when fully burning
    for (const e of en) {
      if (e.fire > 0.9) e.out = true;
    }
  }

  function updateFormation(dt) {
    for (const f of friendlies) {
      f.flash = Math.max(0, (f.flash || 0) - dt * 2.5);
      f.bank = lerp(f.bank || 0, (f.listTarget || 0) + Math.sin(elapsed * 0.4 + f.z * 0.02) * 0.03, 0.08);
      // Engine fire/smoke particles (LOD: only nearer planes)
      const near = Math.hypot(f.x, f.z) < 160;
      if (near) {
        for (const eng of f.engines) {
          if (eng.fire > 0.15 && Math.random() < dt * 6 * eng.fire) {
            const ex = f.x + (eng.id < 2 ? -1 : 1) * (12 + (eng.id % 2) * 8);
            particles.push({
              x: ex, y: f.y + 1, z: f.z,
              vx: rand(-3, 3), vy: rand(3, 10), vz: rand(-10, -3),
              life: rand(0.35, 0.8), max: 0.8,
              kind: eng.fire > 0.5 ? "fire" : "smoke",
              r: rand(2, 5),
            });
          }
        }
      }
      if (f.spiraling) {
        f.spiralT = (f.spiralT || 0) + dt;
        f.bank = (f.bank || 0) + dt * 1.8;
        f.x += (f.vx || 0) * dt;
        f.y += (f.vy || -2) * dt;
        f.z += (f.vz || 0) * dt;
        f.vy = (f.vy || -2) - 4 * dt;
        f.yaw = (f.yaw || 0) + dt * 1.2;
        if (f.spiralT > 8 || f.y < -80) f.health = -1; // mark for cull later
        continue;
      }
      // Formation hold — slight parallax; after turn-back drift aft
      if (mission && mission.turningBack) {
        f.z -= B17_UPS * 0.35 * dt;
        f.bank = lerp(f.bank, (f.x > 0 ? 0.25 : -0.25), 0.04);
      } else {
        f.z += Math.sin(elapsed * 0.12 + f.slot) * 0.15 * dt;
        f.x += Math.sin(elapsed * 0.18 + f.z * 0.01) * 0.5 * dt;
      }
    }
    // Cull long-dead spirals from draw list (keep array stable otherwise)
    friendlies = friendlies.filter((f) => f.health >= 0 || (f.spiraling && (f.spiralT || 0) < 8));
  }

  /** CPU gunners on friendlies — yellow tracers toward nearby bandits. */
  function updateCpuGunners(dt) {
    if (!mission || mission.evaluated) return;
    mission.gunnerTick -= dt;
    if (mission.gunnerTick > 0) return;
    mission.gunnerTick = rand(0.18, 0.42);
    // Limit simultaneous CPU fire for mobile perf
    let fired = 0;
    const bandits = enemies.filter((e) => e.alive);
    if (!bandits.length) return;
    for (const f of friendlies) {
      if (fired >= 3) break;
      if (!f.alive || f.spiraling) continue;
      if (Math.random() > 0.55) continue;
      // Pick nearest bandit in a loose arc
      let best = null, bestD = 1e9;
      for (const e of bandits) {
        const d = Math.hypot(e.x - f.x, e.y - f.y, e.z - f.z);
        if (d < bestD && d < 140) { best = e; bestD = d; }
      }
      if (!best) continue;
      // Accuracy: occasional hit
      const hit = Math.random() < 0.12;
      const life = 0.35 + Math.random() * 0.25;
      // Yellow B-17 tracers (friendly)
      tracers.push({
        x: f.x + rand(-2, 2), y: f.y + rand(0, 3), z: f.z + rand(-2, 2),
        tx: best.x + rand(-4, 4), ty: best.y + rand(-3, 3), tz: best.z + rand(-4, 4),
        life, maxLife: life,
        team: "allied", // yellow
      });
      if (hit && best.alive) {
        best.hp -= 1;
        if (best.hp <= 0) killEnemy(best);
        else spawnHit(best);
      }
      fired++;
    }
  }

  function spawnMissionFighters(count) {
    const n = Math.min(count, MISSION_FIGHTERS - (mission ? mission.fightersSpawned : 0));
    for (let i = 0; i < n; i++) {
      // Stagger perch: ahead-high (~30k ft narrative → compressed)
      const side = Math.random() < 0.5 ? -1 : 1;
      const style = pickAttackStyle();
      spawnEnemy("109", {
        type: "109",
        passSide: side,
        style,
        muteCall: i > 0 && Math.random() < 0.7,
        offset: {
          x: side * rand(0, 40),
          y: rand(20, 55), // start above box (~30k compressed)
          z: rand(40, 90),
        },
      });
      if (mission) mission.fightersSpawned++;
    }
  }

  function updateMission(dt) {
    if (!MISSION_MODE || !mission || state !== "PLAYING") return;
    if (mission.evaluated) return;

    mission.timeLeft = Math.max(0, mission.timeLeft - dt);

    // Staggered spawn of 44 Bf 109s before bomb drop
    if (!mission.bombsAway && mission.fightersSpawned < MISSION_FIGHTERS) {
      mission.spawnAcc += dt;
      const aliveN = enemies.filter((e) => e.alive).length;
      // Keep ~10–14 concurrent for mobile; drip until 44 spawned
      const wantBurst = mission.fightersSpawned < 8 ? 0.35
        : mission.fightersSpawned < 24 ? 0.55
        : 0.85;
      if (mission.spawnAcc >= wantBurst && aliveN < 14) {
        mission.spawnAcc = 0;
        const left = MISSION_FIGHTERS - mission.fightersSpawned;
        spawnMissionFighters(Math.min(2, left));
      }
    }

    // Doors at 1:45 remaining
    if (!mission.doorsOpen && mission.timeLeft <= MISSION_DOORS_AT) {
      mission.doorsOpen = true;
      mission.phase = "doors";
      pushCallout("BOMB BAY DOORS OPEN", 2.0);
      sfxIntercom();
    }

    // Bombs away
    if (mission.doorsOpen && !mission.bombsAway && mission.timeLeft <= MISSION_RELEASE_AT) {
      mission.bombsAway = true;
      mission.phase = "release";
      mission.bombersDropped = countBombCapable();
      pushCallout("BOMBS AWAY — " + mission.bombersDropped + " SHIPS", 2.4);
      sfxIntercom();
      // Visual bomb particles from box
      for (const f of friendlies) {
        if (!f.alive || f.spiraling) continue;
        for (let b = 0; b < 3; b++) {
          particles.push({
            x: f.x + rand(-2, 2), y: f.y - 2, z: f.z,
            vx: rand(-1, 1), vy: -rand(8, 14), vz: rand(-1, 1),
            life: rand(1.2, 2.0), max: 2.0, kind: "smoke", r: rand(2, 4),
          });
        }
      }
      // Player bombs
      for (let b = 0; b < 4; b++) {
        particles.push({
          x: rand(-3, 3), y: 2, z: rand(4, 10),
          vx: 0, vy: -rand(10, 16), vz: 0,
          life: 1.8, max: 1.8, kind: "smoke", r: 3,
        });
      }
    }

    // Turn back shortly after release
    if (mission.bombsAway && !mission.turningBack && mission.timeLeft <= MISSION_RELEASE_AT - 4) {
      mission.turningBack = true;
      mission.phase = "egress";
      pushCallout("FORMATION TURNING BACK", 1.8);
    }

    // Evaluate win/fail after release settles
    if (mission.bombsAway && !mission.evaluated && mission.timeLeft <= MISSION_RELEASE_AT - 6) {
      mission.evaluated = true;
      mission.phase = "done";
      endMission(mission.bombersDropped >= MISSION_WIN_DROPS);
    }

    // City comes into view late in ingress
    if (mission.timeLeft < 40) mission.cityVisible = true;

    updatePlayerList(dt);
    updateFormation(dt);
    updateCpuGunners(dt);
  }

  function endMission(won) {
    state = "GAMEOVER";
    input.fire = false;
    const dropped = mission ? mission.bombersDropped : 0;
    const alive = countAliveBombers();
    goEyebrow.textContent = won ? "TARGET HIT" : "MISSION FAILED";
    goTitle.textContent = won ? "BOMBS ON TARGET" : "BOX BROKEN";
    goStats.innerHTML =
      (won
        ? "≥15 Fortresses released — <b>WIN</b>"
        : "&lt;15 Fortresses released — <b>FAIL</b>") +
      "<br>Dropped <b>" + dropped + "</b> / " + MISSION_BOMBERS +
      " · Alive at release <b>" + alive + "</b>" +
      "<br>Bf 109s down <b>" + kills + "</b> / " + MISSION_FIGHTERS +
      " · Score <b>" + score + "</b>";
    gameoverEl.classList.remove("hidden");
    updateHud();
    pushCallout(won ? "GOOD BOMBING — RTB" : "NOT ENOUGH BOMBS — RTB", 2.5);
  }

  function formatMissionClock(sec) {
    const s = Math.max(0, Math.ceil(sec));
    const m = (s / 60) | 0;
    const r = s % 60;
    return m + ":" + (r < 10 ? "0" : "") + r;
  }
