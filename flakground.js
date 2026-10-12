// 1.6.8 FLAK GROUND — real 88 mm batteries on the ground (ring round the town / factory / yard + along the approach),
// salvo muzzle flashes tied to the sky bursts (~FLAK_TOF later), each leaving a drifting grey-brown smoke puff.
// Two THREE.Points draw calls (pooled, no per-flash allocation), screen-size clamped so a flash stays several px wide at
// 7–11 km slant range, fog-exempt (like the town bake), drawn on top of the ground in the Earth (far) pass.
import * as THREE from "three";

export function createFlakGround(env) {
  const { landG, TOWN_X, TOWN_Z, TOWN_S, renderer, camera, clock } = env; // clock(): sim seconds (same value for every shell of one salvo)
  const LGU_M = 10.5; // 1 landG unit ≈ 10.5 m
  let seed = 8801; const R = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const RR = (a, b) => a + (b - a) * R();
  // town-local → landG
  const tl = (u, v) => [TOWN_X + TOWN_S * u, TOWN_Z + TOWN_S * v];
  const km = (k) => k * 1000 / LGU_M;
  const batteries = [];
  function battery(cx, cz) {
    const n = 4 + ((R() * 3) | 0), rot = R() * 6.283, guns = [];
    const rad = RR(25, 40) / LGU_M; // guns on a ring ~25–40 m round the command post (classic 4- or 6-gun 88 layout)
    for (let i = 0; i < n; i++) { const a = rot + i / n * 6.283 + RR(-0.15, 0.15); guns.push([cx + Math.cos(a) * rad, cz + Math.sin(a) * rad]); }
    batteries.push({ x: cx, z: cz, guns, last: -99 });
  }
  // ring round the town, the factory and the rail yard (town-local centres → landG), 2.5–6.5 km out
  const ctr = tl(-4, 1);
  for (let i = 0; i < 16; i++) { const a = i / 16 * 6.283 + RR(-0.15, 0.15), r = km(RR(2.6, 6.5)); battery(ctr[0] + Math.cos(a) * r, ctr[1] + Math.sin(a) * r); }
  for (let i = 0; i < 5; i++) { const a = R() * 6.283, r = km(RR(1.4, 2.4)); const c = tl(3, 0); battery(c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r); } // inner ring at the yard / factory
  // along the approach (the box comes in from −z): fields either side of the track, 3–35 km out
  for (let i = 0; i < 22; i++) { const d = km(RR(3, 35)), side = R() < 0.5 ? -1 : 1, off = km(RR(1.5, 8)); battery(ctr[0] + side * off, ctr[1] - d); }

  // ---- point sprites (flash + smoke), one shader, uMinPx clamps the on-screen size
  const mkTex = (stops, N) => { const c = document.createElement("canvas"); c.width = c.height = N; const x = c.getContext("2d"); const g = x.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2); for (const [o, s] of stops) g.addColorStop(o, s); x.fillStyle = g; x.fillRect(0, 0, N, N); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; };
  const flashTex = mkTex([[0, "rgba(255,255,240,1)"], [0.22, "rgba(255,238,160,1)"], [0.42, "rgba(255,180,70,0.85)"], [0.7, "rgba(255,120,40,0.3)"], [1, "rgba(255,90,20,0)"]], 64);
  const smokeTex = (() => { const N = 64, c = document.createElement("canvas"); c.width = c.height = N; const x = c.getContext("2d"); let s = 3; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; for (let k = 0; k < 14; k++) { const bx = 32 + (r() - 0.5) * 22, by = 32 + (r() - 0.5) * 22, br = 9 + r() * 12; const g = x.createRadialGradient(bx, by, 0, bx, by, br); g.addColorStop(0, "rgba(255,255,255,0.5)"); g.addColorStop(1, "rgba(255,255,255,0)"); x.fillStyle = g; x.beginPath(); x.arc(bx, by, br, 0, 7); x.fill(); } const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
  const uVH = { value: 1000 };
  function pts(N, tex, additive, minPx) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aS", new THREE.BufferAttribute(new Float32Array(N), 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aC", new THREE.BufferAttribute(new Float32Array(N * 4), 4).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, uVH, uMinPx: { value: minPx } },
      vertexShader: `attribute float aS; attribute vec4 aC; uniform float uVH; uniform float uMinPx; varying vec4 vC;
void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
  float px = aS * length(modelViewMatrix[0].xyz) * projectionMatrix[1][1] * 0.5 * uVH / max(0.001, -mv.z); // landG is scaled (Earth pass)
  float cl = max(px, uMinPx * (0.7 + 0.8 * clamp(aC.a, 0.0, 1.0)) * step(0.001, aS)); // a fresh flash blooms bigger
  vC = aC;
  gl_PointSize = min(cl, 160.0); if (aC.a <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }`,
      fragmentShader: `uniform sampler2D map; varying vec4 vC; void main(){ vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(t.rgb * vC.rgb, t.a * vC.a); if (gl_FragColor.a < 0.003) discard; }`,
      transparent: true, depthWrite: false, depthTest: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, fog: false,
    });
    const P = new THREE.Points(g, m); P.frustumCulled = false; P.renderOrder = additive ? 6 : 5; landG.add(P);
    return { P, g, N, pos: g.attributes.position.array, s: g.attributes.aS.array, c: g.attributes.aC.array };
  }
  const FL = pts(192, flashTex, true, 11), SM = pts(480, smokeTex, false, 3);
  const fl = []; for (let i = 0; i < FL.N; i++) fl.push({ t: 99, life: 0.5, x: 0, z: 0, s: 1 });
  const sm = []; for (let i = 0; i < SM.N; i++) sm.push({ t: 99, life: 25, x: 0, y: 0, z: 0, vx: 0, vz: 0, s0: 1, s1: 1, c: 1 });
  let fi = 0, si = 0;
  const stats = { batteries: batteries.length, guns: batteries.reduce((a, b) => a + b.guns.length, 0), salvos: 0, flashes: 0, live: 0, smoke: 0 };
  const _v = new THREE.Vector3();
  let _salvoT = -1, _now = 0, _cur = null;
  function pickBattery() {
    landG.updateWorldMatrix(true, false);
    const box = landG.worldToLocal(_v.set(camera.position.x, camera.position.y, camera.position.z)); // only x/z used
    const toTown = Math.hypot(ctr[0] - box.x, ctr[1] - box.z);
    let tot = 0; const W = [];
    for (const b of batteries) {
      const d = Math.hypot(b.x - box.x, b.z - box.z) * LGU_M / 1000;
      if (d < 3.2 || d > 13) { W.push(0); continue; }
      const ahead = Math.hypot(ctr[0] - b.x, ctr[1] - b.z) < toTown + km(1) ? 2.5 : 1; // batteries ahead (round the target) fire more
      const w = ahead * (1 - Math.abs(d - 8) / 6) * (b.last > _now - 2 ? 0.3 : 1); W.push(Math.max(0, w)); tot += Math.max(0, w);
    }
    if (tot <= 0) { let best = null, bd = 1e9; for (const b of batteries) { const d = Math.hypot(b.x - box.x, b.z - box.z); if (d < bd && d > km(3)) { bd = d; best = b; } } return best; }
    let r = R() * tot; for (let i = 0; i < batteries.length; i++) { r -= W[i]; if (r <= 0) return batteries[i]; }
    return batteries[batteries.length - 1];
  }
  function fireGun(b, g, delay) {
    const f = fl[fi]; fi = (fi + 1) % FL.N; f.t = -delay; f.life = RR(0.35, 0.55); f.x = g[0]; f.z = g[1]; f.s = RR(0.9, 1.2); stats.flashes++;
    const p = sm[si]; si = (si + 1) % SM.N; p.t = -delay - 0.05; p.life = RR(20, 30); p.x = g[0]; p.y = 1.5; p.z = g[1]; p.vx = RR(0.25, 0.45); p.vz = RR(-0.1, 0.15); p.s0 = RR(25, 35) / LGU_M; p.s1 = RR(120, 170) / LGU_M; p.c = RR(0.85, 1.1);
  }
  // one call per sky shell (game.js spawnFlakBurst): shells fired in the same frame belong to one salvo from one battery;
  // a new salvo fires the whole battery (4–6 guns within ~0.25 s)
  function muzzle() {
    _now = clock();
    if (Math.abs(_now - _salvoT) > 0.004 || !_cur) { // the rest of this step's shells came out of the same salvo
      _cur = pickBattery(); if (!_cur) return; lastSalvo.b = _cur; lastSalvo.n++; _salvoT = _now; _cur.last = _now; stats.salvos++;
      for (let i = 0; i < _cur.guns.length; i++) fireGun(_cur, _cur.guns[i], R() * 0.25);
    }
  }
  const lastSalvo = { b: null, n: 0 };
  function worldOf(b) { landG.updateWorldMatrix(true, false); const v = landG.localToWorld(new THREE.Vector3(b.x, 0, b.z)); return { x: v.x, y: v.y, z: v.z }; }
  const _sz = new THREE.Vector2();
  function update(dt) {
    renderer.getDrawingBufferSize(_sz); uVH.value = _sz.y;
    let nl = 0, ns = 0;
    for (let i = 0; i < FL.N; i++) {
      const f = fl[i]; const o = i * 3, c = i * 4;
      if (f.t < f.life) f.t += dt;
      if (f.t < 0 || f.t >= f.life) { FL.c[c + 3] = 0; FL.s[i] = 0; continue; }
      nl++;
      const k = f.t / f.life, pop = k < 0.12 ? 1 : Math.pow(1 - (k - 0.12) / 0.88, 1.6);
      FL.pos[o] = f.x; FL.pos[o + 1] = 2; FL.pos[o + 2] = f.z;
      FL.s[i] = (k < 0.12 ? 60 + 600 * k : 130 - 60 * k) / LGU_M * f.s; // ~60–130 m bloom (+ clamp ≥ 7 px)
      FL.c[c] = 1.6; FL.c[c + 1] = 1.25; FL.c[c + 2] = 0.8; FL.c[c + 3] = pop;
    }
    for (let i = 0; i < SM.N; i++) {
      const p = sm[i]; const o = i * 3, c = i * 4;
      if (p.t < p.life) p.t += dt;
      if (p.t < 0 || p.t >= p.life) { SM.c[c + 3] = 0; SM.s[i] = 0; continue; }
      ns++;
      const k = p.t / p.life;
      p.x += p.vx * dt; p.z += p.vz * dt; p.y += 0.6 * dt * (1 - k);
      SM.pos[o] = p.x; SM.pos[o + 1] = p.y; SM.pos[o + 2] = p.z;
      SM.s[i] = p.s0 + (p.s1 - p.s0) * Math.sqrt(k);
      const g = 0.42 * p.c; SM.c[c] = g * 1.08; SM.c[c + 1] = g; SM.c[c + 2] = g * 0.88; SM.c[c + 3] = 0.62 * Math.min(1, p.t / 0.3) * Math.pow(1 - k, 1.3);
    }
    stats.live = nl; stats.smoke = ns;
    for (const X of [FL, SM]) { X.g.attributes.position.needsUpdate = true; X.g.attributes.aS.needsUpdate = true; X.g.attributes.aC.needsUpdate = true; }
  }
  function reset() { for (const f of fl) f.t = 99; for (const p of sm) p.t = 99; }
  return { muzzle, update, reset, stats, batteries, lastSalvo, worldOf };
}
