// 1.6.9 FLAK POV — stand at a heavy flak battery by the airfield outside the town and watch the raid come over.
// Everything here lives in landG (1 landG unit ≈ 10.5 m; world = landG.localToWorld), so it sits on the real 25,000 ft-below Earth:
// the camera goes to the true ground and looks up through the same sky, flak, contrails and bombers as the gunners.
// Built lazily on first use; hidden (and not updated) otherwise.
import * as THREE from "three";

export function createFlakPov(env) {
  const { landG, TOWN_X, TOWN_Z, TOWN_S, AF, camera, flakG, fireTex, smokeTex, audio, ground } = env;
  const M = 1 / 10.5; // metres → landG units
  const tl = (u, v) => [TOWN_X + TOWN_S * u, TOWN_Z + TOWN_S * v];
  let built = false, root = null, on = false;
  let seed = 4242; const R = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }; const RR = (a, b) => a + (b - a) * R();
  const BAT = []; // { x, z, guns:[{g, barrel, cradle, x, z}], mine }
  const men = []; const flashes = []; const puffs = []; const blasts = [];
  const stats = { on: false, salvos: 0, impacts: { farm: 0, airfield: 0, town: 0, target: 0 }, lastImpact: null, batteries: 0, near: 0 };
  let me = null, myGun = null; // my battery (landG coords); 1.7.1: the gun the player crews
  const mat = (c, o) => new THREE.MeshLambertMaterial(Object.assign({ color: c }, o || {}));
  const olive = mat(0x5a5e3e), dark = mat(0x2c2e26), sand = mat(0x8c7b58), conc = mat(0x8a877c), crate = mat(0x6a5634), grey = mat(0x6d726c), glass = mat(0x8fb0c0, { transparent: true, opacity: 0.55 });
  const uniG = mat(0x4f5a48), skin = mat(0xc49a78), helm = mat(0x3c4232);

  function gun88(parent, x, z, yaw) { // Flak 36: cruciform platform, pedestal, cradle + 4.9 m barrel, shield
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = yaw; parent.add(g);
    for (const a of [0, Math.PI / 2]) { const arm = new THREE.Mesh(new THREE.BoxGeometry(6.6 * M, 0.35 * M, 0.5 * M), olive); arm.rotation.y = a; arm.position.y = 0.2 * M; g.add(arm); }
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.45 * M, 0.6 * M, 1.4 * M, 10), olive); ped.position.y = 1.0 * M; g.add(ped);
    const cr = new THREE.Group(); cr.position.y = 1.8 * M; g.add(cr);
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.1 * M, 0.8 * M, 1.6 * M), olive); cr.add(body);
    const sh = new THREE.Mesh(new THREE.BoxGeometry(2.2 * M, 1.5 * M, 0.08 * M), olive); sh.position.set(0, 0.5 * M, 0.9 * M); cr.add(sh);
    const br = new THREE.Group(); cr.add(br);
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.075 * M, 0.11 * M, 4.9 * M, 8), dark); tube.rotation.x = Math.PI / 2; tube.position.z = 2.1 * M; br.add(tube);
    const rec = new THREE.Mesh(new THREE.CylinderGeometry(0.16 * M, 0.16 * M, 1.6 * M, 8), olive); rec.rotation.x = Math.PI / 2; rec.position.set(0, 0.18 * M, 0.2 * M); br.add(rec);
    const tip = new THREE.Object3D(); tip.position.z = 4.6 * M; br.add(tip);
    // sandbag ring (low torus) and a few ready-round crates
    for (let i = 0; i < 18; i++) { if (i === 4 || i === 5) continue; const a = i / 18 * 6.283, bag = new THREE.Mesh(new THREE.BoxGeometry(1.9 * M, 0.9 * M, 0.7 * M), sand); bag.position.set(Math.cos(a) * 5.4 * M, 0.45 * M, Math.sin(a) * 5.4 * M); bag.rotation.y = -a + Math.PI / 2; g.add(bag); } // sandbag wall, a gap for the ammo run
    for (let i = 0; i < 4; i++) { const c = new THREE.Mesh(new THREE.BoxGeometry(0.9 * M, 0.35 * M, 0.45 * M), crate); const a = RR(0, 6.28); c.position.set(Math.cos(a) * 3.6 * M, 0.18 * M, Math.sin(a) * 3.6 * M); c.rotation.y = a; g.add(c); }
    return { g, cr, br, tip, sh, x, z, el: RR(0.9, 1.1), az: 0, rec: 0 };
  }
  function bomber(parent, x, z, yaw, kind) { // parked Ju 88 / Do 217 — glazed nose, two nacelles, single (88) or twin (217) fins
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = yaw; parent.add(g);
    const L = kind === "217" ? 17.2 : 14.4, S = kind === "217" ? 19 : 20;
    const fus = new THREE.Mesh(new THREE.CylinderGeometry(0.7 * M, 0.35 * M, L * M, 10), grey); fus.rotation.x = Math.PI / 2; fus.position.y = 1.9 * M; g.add(fus);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.85 * M, 10, 8), glass); nose.position.set(0, 2.0 * M, L * 0.5 * M); nose.scale.z = 1.3; g.add(nose);
    const wing = new THREE.Mesh(new THREE.BoxGeometry(S * M, 0.3 * M, 3.2 * M), grey); wing.position.set(0, 1.6 * M, L * 0.12 * M); g.add(wing);
    for (const s of [-1, 1]) {
      const n = new THREE.Mesh(new THREE.CylinderGeometry(0.62 * M, 0.5 * M, 3.4 * M, 10), dark); n.rotation.x = Math.PI / 2; n.position.set(s * 2.9 * M, 1.55 * M, L * 0.2 * M); g.add(n);
      const gear = new THREE.Mesh(new THREE.BoxGeometry(0.2 * M, 1.4 * M, 0.2 * M), dark); gear.position.set(s * 2.9 * M, 0.7 * M, L * 0.2 * M); g.add(gear);
      const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.55 * M, 0.55 * M, 0.35 * M, 12), dark); wh.rotation.z = Math.PI / 2; wh.position.set(s * 2.9 * M, 0.55 * M, L * 0.2 * M); g.add(wh);
    }
    const tp = new THREE.Mesh(new THREE.BoxGeometry(7 * M, 0.2 * M, 1.8 * M), grey); tp.position.set(0, 2.2 * M, -L * 0.46 * M); g.add(tp);
    if (kind === "217") for (const s of [-1, 1]) { const f = new THREE.Mesh(new THREE.BoxGeometry(0.15 * M, 2.2 * M, 1.6 * M), grey); f.position.set(s * 3.4 * M, 2.9 * M, -L * 0.46 * M); g.add(f); }
    else { const f = new THREE.Mesh(new THREE.BoxGeometry(0.15 * M, 2.6 * M, 2 * M), grey); f.position.set(0, 3.2 * M, -L * 0.45 * M); g.add(f); }
    // a tail-wheel stance: nose up ~10°
    g.rotation.x = -0.09;
    return g;
  }
  function man(parent, x, z) {
    const g = new THREE.Group(); g.position.set(x, 0, z); parent.add(g);
    // 1.7.1: rounded crewmen — tapered limbs, a torso with shoulders, arms, boots (were boxes)
    const legs = []; for (const s of [-1, 1]) { const l = new THREE.Mesh(new THREE.CylinderGeometry(0.085 * M, 0.07 * M, 0.85 * M, 7), uniG); l.position.set(s * 0.11 * M, 0.43 * M, 0); g.add(l); legs.push(l); const b = new THREE.Mesh(new THREE.BoxGeometry(0.13 * M, 0.1 * M, 0.26 * M), dark); b.position.set(0, -0.4 * M, 0.04 * M); l.add(b); }
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.22 * M, 0.17 * M, 0.72 * M, 9), uniG); body.position.y = 1.2 * M; body.scale.z = 0.62; g.add(body);
    for (const s of [-1, 1]) { const a = new THREE.Mesh(new THREE.CylinderGeometry(0.06 * M, 0.05 * M, 0.66 * M, 6), uniG); a.position.set(s * 0.27 * M, 1.22 * M, 0.04 * M); a.rotation.z = s * 0.18; a.rotation.x = -0.35; g.add(a); }
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.12 * M, 8, 6), skin); head.position.y = 1.68 * M; g.add(head);
    const h = new THREE.Mesh(new THREE.SphereGeometry(0.15 * M, 8, 5, 0, 6.29, 0, 1.4), helm); h.position.y = 1.72 * M; g.add(h);
    return { g, legs, x, z, tx: x, tz: z, sp: RR(2.4, 4.2) * M, ph: R() * 6, wait: RR(0, 2) };
  }
  function groundPatch(cx, cz) { // close-range farmland detail round the battery (the Earth bake is ~10 m a texel): fields, furrows, tracks, fading out at 1.6 km
    const N = 2048, c = document.createElement("canvas"); c.width = c.height = N; const x = c.getContext("2d"), Rm = 4200, k = N / (2 * Rm);
    x.fillStyle = "#5d6b3a"; x.fillRect(0, 0, N, N);
    const cols = ["#64733d", "#6f7a43", "#7c7a48", "#8a7f52", "#56663a", "#7a6a45", "#6a7a40", "#93895a"];
    for (let i = 0; i < 520; i++) { const w = RR(110, 380) * k, h = RR(60, 260) * k, px = R() * N, pz = R() * N, a = RR(-0.25, 0.25) + (R() < 0.5 ? 0 : 1.57); x.save(); x.translate(px, pz); x.rotate(a); x.fillStyle = cols[(R() * cols.length) | 0]; x.fillRect(-w / 2, -h / 2, w, h);
      x.strokeStyle = "rgba(40,36,20,0.18)"; x.lineWidth = 1; for (let f = -w / 2; f < w / 2; f += 3.2 * k) { x.beginPath(); x.moveTo(f, -h / 2); x.lineTo(f, h / 2); x.stroke(); } x.restore(); }
    x.strokeStyle = "rgba(120,104,72,0.9)"; x.lineWidth = 4 * k; for (let i = 0; i < 6; i++) { x.beginPath(); x.moveTo(R() * N, 0); x.bezierCurveTo(R() * N, N * 0.3, R() * N, N * 0.6, R() * N, N); x.stroke(); }
    x.fillStyle = "rgba(110,96,64,0.55)"; x.beginPath(); x.arc(N / 2, N / 2, 42 * k, 0, 6.29); x.fill(); // the trodden battery ground
    const g2 = x.createRadialGradient(N / 2, N / 2, N * 0.25, N / 2, N / 2, N / 2); g2.addColorStop(0, "rgba(0,0,0,1)"); g2.addColorStop(1, "rgba(0,0,0,0)");
    x.globalCompositeOperation = "destination-in"; x.fillStyle = g2; x.fillRect(0, 0, N, N);
    const tex = new THREE.CanvasTexture(c); tex.anisotropy = 8; if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.CircleGeometry(Rm * M, 64), new THREE.MeshLambertMaterial({ map: tex, transparent: true, depthWrite: false })); m.rotation.x = -Math.PI / 2; m.position.set(cx, 0.05 * M, cz); m.renderOrder = 30; m.material.polygonOffset = true; m.material.polygonOffsetFactor = -4; m.material.polygonOffsetUnits = -4; root.add(m);
  }
  function farFields(cx, cz) { // 1.6.9d: seen from the ground the Earth bake reads as a flat grey sheet at grazing angles — a tiled field ring to 30 km under the near patch
    const N = 512, c = document.createElement("canvas"); c.width = c.height = N; const x = c.getContext("2d");
    const cols = ["#5f6e3b", "#6c7842", "#7a7847", "#86804f", "#55653a", "#74673f", "#667640", "#8c8556"];
    x.fillStyle = "#5f6c3a"; x.fillRect(0, 0, N, N);
    for (let i = 0; i < 70; i++) { x.fillStyle = cols[(R() * cols.length) | 0]; x.fillRect(R() * N, R() * N, RR(30, 140), RR(20, 110)); }
    x.strokeStyle = "rgba(60,70,40,0.6)"; x.lineWidth = 3; for (let i = 0; i < 5; i++) { x.beginPath(); x.moveTo(R() * N, 0); x.lineTo(R() * N, N); x.stroke(); }
    const tex = new THREE.CanvasTexture(c); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(70, 70); tex.anisotropy = 8; if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.CircleGeometry(30000 * M, 96), new THREE.MeshLambertMaterial({ map: tex })); m.rotation.x = -Math.PI / 2; m.position.set(cx, 0.03 * M, cz); m.renderOrder = 29;
    m.material.polygonOffset = true; m.material.polygonOffsetFactor = -2; m.material.polygonOffsetUnits = -2; root.add(m); return m;
  }
  function grassNear(cx, cz) { // 1.7.2: a real grass texture up close (blades + tufts + clover), tiled ~every 6 m, fading out by ~450 m
    const N = 512, c = document.createElement("canvas"); c.width = c.height = N; const x = c.getContext("2d");
    x.fillStyle = "#4f6a2c"; x.fillRect(0, 0, N, N);
    for (let i = 0; i < 2600; i++) { const px = R() * N, py = R() * N, l = RR(3, 11), a = RR(-0.6, 0.6) - 1.57, g = (R() * 60) | 0;
      x.strokeStyle = "rgba(" + (60 + g * 0.6 | 0) + "," + (95 + g) + "," + (35 + g * 0.3 | 0) + ",0.8)"; x.lineWidth = RR(0.8, 1.8); x.beginPath(); x.moveTo(px, py); x.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l); x.stroke(); }
    for (let i = 0; i < 90; i++) { x.fillStyle = R() < 0.5 ? "rgba(40,58,22,0.35)" : "rgba(120,130,60,0.25)"; x.beginPath(); x.arc(R() * N, R() * N, RR(6, 22), 0, 6.29); x.fill(); }
    const tex = new THREE.CanvasTexture(c); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(150, 150); tex.anisotropy = 8; if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    const ac = document.createElement("canvas"); ac.width = ac.height = 256; const y = ac.getContext("2d"); const gr = y.createRadialGradient(128, 128, 30, 128, 128, 128); gr.addColorStop(0, "#fff"); gr.addColorStop(0.55, "#bbb"); gr.addColorStop(1, "#000"); y.fillStyle = gr; y.fillRect(0, 0, 256, 256);
    const m = new THREE.Mesh(new THREE.CircleGeometry(900 * M, 64), new THREE.MeshLambertMaterial({ map: tex, alphaMap: new THREE.CanvasTexture(ac), transparent: true, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.set(cx, 0.07 * M, cz); m.renderOrder = 31; m.material.polygonOffset = true; m.material.polygonOffsetFactor = -4; m.material.polygonOffsetUnits = -4; root.add(m);
  }
  function bocage(cx, cz, af) { // 1.7.2: Normandy bocage — dark 3D hedgerows (2.5-4 m, on banks) along an irregular field grid round the battery, out to ~3 km
    const segs = [], cell = 190, Rm = 3000, keep = (x, z) => Math.hypot(x - cx, z - cz) > 140 * M && Math.hypot((x - af[0]) / (AF.rx * TOWN_S * 1.15), (z - af[1]) / (AF.rz * TOWN_S * 1.15)) > 1;
    const rot = 0.21, cr = Math.cos(rot), sr = Math.sin(rot), P = (u, v) => [cx + (u * cr - v * sr) * M, cz + (u * sr + v * cr) * M];
    for (let u = -Rm; u < Rm; u += cell) for (let v = -Rm; v < Rm; v += cell) {
      if (Math.hypot(u, v) > Rm) continue; const ju = RR(-40, 40), jv = RR(-40, 40);
      if (R() < 0.82) segs.push([P(u + ju, v + jv), P(u + cell + RR(-40, 40), v + jv + RR(-25, 25))]);
      if (R() < 0.82) segs.push([P(u + ju, v + jv), P(u + ju + RR(-25, 25), v + cell + RR(-40, 40))]);
    }
    const ok = segs.filter((sg) => keep((sg[0][0] + sg[1][0]) / 2, (sg[0][1] + sg[1][1]) / 2));
    const geo = new THREE.BoxGeometry(1, 1, 1); geo.translate(0, 0.5, 0);
    const mat = new THREE.MeshLambertMaterial({ color: 0x2c3f1c }), im = new THREE.InstancedMesh(geo, mat, ok.length * 2), q = new THREE.Object3D(); let n = 0;
    const tm = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ color: 0x26381a, flatShading: true }), ok.length * 3); let nt = 0;
    for (const [a, b] of ok) {
      const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz), ang = Math.atan2(dx, dz), mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      q.position.set(mx, 0, mz); q.rotation.set(0, ang, 0); q.scale.set(RR(1.6, 2.4) * M, RR(2.4, 3.8) * M, L); q.updateMatrix(); im.setMatrixAt(n++, q.matrix); // hedge
      q.scale.set(3.2 * M, 0.8 * M, L); q.updateMatrix(); im.setMatrixAt(n++, q.matrix); // earth bank
      for (let k = 0; k < 3; k++) if (R() < 0.6) { const f = R(); q.position.set(a[0] + dx * f, RR(4, 7) * M, a[1] + dz * f); q.rotation.set(R(), R(), R()); const sc = RR(2.6, 4.2) * M; q.scale.set(sc, sc * 1.2, sc); q.updateMatrix(); tm.setMatrixAt(nt++, q.matrix); } // hedgerow trees
    }
    im.count = n; tm.count = nt; im.frustumCulled = tm.frustumCulled = false; root.add(im); root.add(tm); stats.hedges = ok.length;
  }
  function build() {
    built = true; root = new THREE.Group(); root.visible = false; landG.add(root);
    // my battery: on the farmland just outside the airfield's far edge, ~1.2 km from the target complex
    const af = tl(AF.x, AF.z), myC = [af[0] + 0.3 * TOWN_S, af[1] + (AF.rz + 3.2) * TOWN_S];
    me = { x: myC[0], z: myC[1] }; farFields(myC[0], myC[1]); groundPatch(myC[0], myC[1]); grassNear(myC[0], myC[1]); bocage(myC[0], myC[1], tl(AF.x, AF.z));
    const add = (cx, cz, n, mine) => { const B = { x: cx, z: cz, guns: [], mine, next: RR(0, 3) }; const rot = R() * 6.28, rad = (mine ? 30 : RR(25, 40)) * M; for (let i = 0; i < n; i++) { const a = rot + i / n * 6.28; B.guns.push(gun88(root, cx + Math.cos(a) * rad, cz + Math.sin(a) * rad, RR(0, 6.28))); } BAT.push(B); return B; };
    add(myC[0], myC[1], 4, true); myGun = BAT[0].guns[0]; myGun.sh.visible = false; // 1.7.1: the player's gun (shield off: the layer's eye is right behind it)
    // command post + range-finder pit at the centre, an ammo bunker
    { for (let i = 0; i < 12; i++) { const a = i / 12 * 6.283, bag = new THREE.Mesh(new THREE.BoxGeometry(1.7 * M, 1.0 * M, 0.7 * M), sand); bag.position.set(myC[0] + Math.cos(a) * 3.4 * M, 0.5 * M, myC[1] + Math.sin(a) * 3.4 * M); bag.rotation.y = -a + Math.PI / 2; root.add(bag); } const rf = new THREE.Mesh(new THREE.CylinderGeometry(0.12 * M, 0.12 * M, 4 * M, 8), dark); rf.rotation.z = Math.PI / 2; rf.position.set(myC[0], 1.7 * M, myC[1]); root.add(rf); const rfp = new THREE.Mesh(new THREE.CylinderGeometry(0.1 * M, 0.15 * M, 1.4 * M, 6), dark); rfp.position.set(myC[0], 1.0 * M, myC[1]); root.add(rfp); const bk = new THREE.Mesh(new THREE.BoxGeometry(6 * M, 2 * M, 4 * M), conc); bk.material = mat(0x6f6a4c); bk.position.set(myC[0] + 22 * M, 0.35 * M, myC[1] - 62 * M); bk.scale.y = 0.5; root.add(bk); /* 1.7.0: sod-covered, dug in, 16 m behind the eye (was 4 m: its grey roof filled the view toward the town) */ }
    // nearby batteries (the airfield ring) and several more along the approach (box comes in from −z)
    for (let i = 0; i < 3; i++) { const a = -1.9 + i * 1.3, r = RR(650, 1100) * M; add(myC[0] + Math.cos(a) * r, myC[1] + Math.sin(a) * r, 4, false); }
    for (let i = 0; i < 6; i++) { const d = RR(2500, 9000) * M; add(myC[0] + RR(-1800, 1800) * M, myC[1] - d, 4 + (i & 1) * 2, false); }
    stats.batteries = BAT.length;
    // parked bombers on the airfield dispersal nearest us
    for (let i = 0; i < 6; i++) { const a = 0.28 + i * 0.22, p = [af[0] + Math.cos(a + 1.2) * AF.rx * 0.75 * TOWN_S * 0.55 + (i - 2.5) * 40 * M, af[1] + AF.rz * 0.8 * TOWN_S]; bomber(root, p[0], p[1], RR(2.6, 3.6), i % 3 === 2 ? "217" : "88"); }
    for (let i = 0; i < 3; i++) bomber(root, myC[0] + (-75 + i * 70) * M, myC[1] - (150 + (i & 1) * 25) * M, RR(-0.5, 0.5) + (i === 1 ? 0.6 : 0), i === 1 ? "217" : "88"); // 1.7.0: a dispersal 150 m off, readable from the battery
    // men: gun crews round my guns, runners between the guns, bunker and the field
    for (let i = 0; i < 26; i++) { const G = BAT[0].guns[i % 4]; men.push(man(root, G.x + RR(-4, 4) * M, G.z + RR(-4, 4) * M)); }
    // muzzle flash + smoke sprites
    for (let i = 0; i < 24; i++) { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: fireTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })); s.visible = false; root.add(s); flashes.push({ s, t: 9 }); }
    for (let i = 0; i < 60; i++) { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, color: 0x9a9488, transparent: true, depthWrite: false })); s.visible = false; root.add(s); puffs.push({ s, t: 99, life: 1 }); }
    // bomb blasts seen from close: fireball + dirt column + smoke
    for (let i = 0; i < 30; i++) { const f = new THREE.Sprite(new THREE.SpriteMaterial({ map: fireTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })); const d = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, color: 0x5a4a38, transparent: true, depthWrite: false })); f.visible = d.visible = false; root.add(f); root.add(d); blasts.push({ f, d, t: 99, x: 0, z: 0, k: 1 }); }
  }
  function eyeLocal() { return { x: me.x + 22 * M, y: 2.4 * M, z: me.z - 46 * M }; } // standing on the ammo-bunker berm, just outside the gun ring
  const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _pj = new THREE.Vector3();
  function pose(P) { // place the camera at the battery, looking yaw / pitch (world frame)
    if (!built) build();
    on = true; root.visible = true; stats.on = true; if (ground) ground.visible = false; // 1.7.0: at 2 m the Earth plane z-fights the field ring (grey sheet toward the town) — the ring + near patch are the ground here
    landG.updateWorldMatrix(true, false);
    // 1.7.1: the view direction in landG (landG turns with the box heading) lays my gun; the eye sits at the sight, 1.4 m behind and 0.5 m above the trunnions
    const cp = Math.cos(P.pitch), wd = _w.set(Math.sin(P.yaw) * cp, Math.sin(P.pitch), Math.cos(P.yaw) * cp);
    landG.getWorldQuaternion(_q); _q.invert(); wd.applyQuaternion(_q); const hl = Math.hypot(wd.x, wd.z) || 1, az = Math.atan2(wd.x, wd.z), el = Math.atan2(wd.y, hl);
    const G = myGun; G.cr.rotation.y = az - G.g.rotation.y; G.br.rotation.x = -Math.max(-0.05, Math.min(1.5, el)); G.lay = true;
    const E = { x: G.x - wd.x / hl * 1.4 * M, y: 2.35 * M, z: G.z - wd.z / hl * 1.4 * M }; landG.localToWorld(_v.set(E.x, E.y, E.z));
    camera.position.copy(_v);
    camera.rotation.order = "YXZ"; camera.rotation.set(P.pitch, P.yaw + Math.PI, 0);
    const FOVW = window.__FG_FPOVFOV || 52; if (camera.fov !== FOVW) { camera.fov = FOVW; camera.updateProjectionMatrix(); } // a gunner's eye, a touch narrower than the turret view so a box at 7.6 km reads
    camera.updateMatrixWorld();
  }
  function off() { on = false; stats.on = false; if (root) root.visible = false; if (ground) ground.visible = true; }
  let _bomb = 0;
  function impact(lx, lz, big) { // every bomb impact (landG coords) — classify against the airfield / town and draw a close-up blast if near us
    if (!built) build();
    const af = tl(AF.x, AF.z); const du = (lx - af[0]) / TOWN_S, dv = (lz - af[1]) / TOWN_S, c = Math.cos(AF.rot), s = Math.sin(AF.rot), uu = (du * c - dv * s) / AF.rx, vv = (du * s + dv * c) / AF.rz;
    const tu = (lx - TOWN_X) / TOWN_S, tv = (lz - TOWN_Z) / TOWN_S;
    const inR = (x0, x1, z0, z1) => tu > x0 && tu < x1 && tv > z0 && tv < z1;
    const kind = uu * uu + vv * vv < 1 ? "airfield" : (inR(-2.75, 9.3, -11.4, 8.6) ? "target" : Math.hypot(tu + 13.9, tv - 0.8) < 11 ? "town" : "farm"); // target complex / old town / fields
    (stats.where || (stats.where = [])).length < 400 && stats.where.push([+tu.toFixed(1), +tv.toFixed(1), kind[0]]);
    stats.impacts[kind]++; stats.lastImpact = { kind, dM: Math.round(Math.hypot(lx - me.x, lz - me.z) / M), az: (() => { landG.updateWorldMatrix(true, false); const I = landG.localToWorld(new THREE.Vector3(lx, 0, lz)), E = eyeLocal(), C = landG.localToWorld(new THREE.Vector3(E.x, E.y, E.z)); return +(Math.atan2(I.x - C.x, I.z - C.z) * 57.3).toFixed(1); })(), t: +(performance.now() / 1000).toFixed(1) };
    const B = blasts[_bomb++ % blasts.length]; B.t = 0; B.x = lx; B.z = lz; B.k = big ? 1.3 : 1; B.kind = kind;
    const AU = audio || window.FGAudio; if (on && AU && AU.boom) { const d = Math.hypot(lx - me.x, lz - me.z) / M; if (d < 6000) setTimeout(() => AU.boomAt ? AU.boomAt(d / 1.5, true) : AU.boom(0, 0, 0, d < 1500), Math.min(6000, d / 0.34)); }
  }
  function salvo(B, boxL, t) {
    stats.salvos++;
    for (const G of B.guns) {
      if (G === myGun) continue; // 1.7.1: the player's gun fires only on the player's trigger
      G.rec = 1;
      const F = flashes.find((f) => f.t > 0.4) || flashes[0]; F.t = -Math.random() * 0.25; F.g = G;
      const P = puffs.find((p) => p.t > p.life) || puffs[0]; P.t = F.t - 0.05; P.life = RR(8, 12); P.g = G; P.vx = RR(1.5, 3) * M; P.vz = RR(-0.5, 0.5) * M;
    }
    const A = audio || window.FGAudio; if (on && A && A.gun88) { const d = Math.hypot(B.x - me.x, B.z - me.z) / M; for (let i = 0; i < B.guns.length; i++) setTimeout(() => A.gun88((B.mine ? 30 + i * 8 : d) / 1.5), (B.mine ? 0 : d / 0.34) + i * 70 + Math.random() * 80); }
    void boxL; void t;
  }
  function update(dt, boxW, t) { // boxW: the formation centre in world coords
    if (!on || !built) return;
    landG.updateWorldMatrix(true, false);
    { const dx = boxW.x - camera.position.x, dy = boxW.y - camera.position.y, dz = boxW.z - camera.position.z; stats.boxAz = +(Math.atan2(dx, dz) * 57.3).toFixed(1); stats.boxEl = +(Math.atan2(dy, Math.hypot(dx, dz)) * 57.3).toFixed(1); stats.boxR = Math.round(Math.hypot(dx, dy, dz)); }
    const bl = landG.worldToLocal(_w.copy(boxW)); // box in landG coords (y = height above the ground in landG units)
    for (const B of BAT) {
      const dx = bl.x - B.x, dz = bl.z - B.z, dh = Math.hypot(dx, dz), az = Math.atan2(dx, dz), el = Math.atan2(bl.y, dh);
      const lead = Math.atan2(dz < 0 ? 1 : -1, 6) * 0.0; void lead;
      for (const G of B.guns) { if (G === myGun) { G.rec = Math.max(0, G.rec - dt * 2.2); G.br.position.z = -G.rec * 0.9 * M; continue; } G.az += Math.atan2(Math.sin(az - G.az - G.g.rotation.y), Math.cos(az - G.az - G.g.rotation.y)) * Math.min(1, dt * 0.8); G.cr.rotation.y = G.az; G.br.rotation.x = -Math.min(1.45, Math.max(0.2, el * G.el + 0.08)); G.rec = Math.max(0, G.rec - dt * 2.2); G.br.position.z = -G.rec * 0.9 * M; }
      const slant = Math.hypot(dh, bl.y) / M; // metres
      B.next -= dt; if (slant < 11500 && B.next <= 0) { B.next = RR(3.6, 4.8) * (B.mine ? 1 : 1.15); salvo(B, bl, t); }
    }
    { const T = landG.localToWorld(_w.set(TOWN_X, 0, TOWN_Z)); stats.townAz = +(Math.atan2(T.x - camera.position.x, T.z - camera.position.z) * 57.3).toFixed(1); stats.townKm = +(Math.hypot(TOWN_X - me.x, TOWN_Z - me.z) / M / 1000).toFixed(1); }
    stats.near = Math.round(Math.hypot(bl.x - me.x, bl.z - me.z) / M);
    for (const F of flashes) { if (F.t > 0.4 || !F.g) { F.s.visible = false; if (F.t <= 0.4) F.t += dt; continue; } F.t += dt; if (F.t < 0) { F.s.visible = false; continue; } F.g.tip.getWorldPosition(_v); root.worldToLocal(_v); F.s.position.copy(_v); const k = F.t / 0.4; F.s.scale.setScalar((3 + 9 * Math.sin(Math.min(1, k * 3) * 1.57)) * (1 - k) * M + 0.01); F.s.material.opacity = 1 - k; F.s.visible = true; }
    for (const P of puffs) { if (!P.g || P.t > P.life) { P.s.visible = false; continue; } P.t += dt; if (P.t < 0) { P.s.visible = false; continue; } if (P.t < dt * 1.5) { P.g.tip.getWorldPosition(_v); root.worldToLocal(_v); P.s.position.copy(_v); } const k = P.t / P.life; P.s.position.x += P.vx * dt; P.s.position.z += P.vz * dt; P.s.position.y += 0.6 * M * dt; P.s.scale.setScalar((2 + 14 * Math.sqrt(k)) * M); P.s.material.opacity = 0.55 * (1 - k); P.s.visible = true; }
    for (const B of blasts) { if (B.t > 9) { B.f.visible = B.d.visible = false; continue; } B.t += dt; const k = B.t; B.f.visible = k < 1.2; B.f.position.set(B.x, (6 + 20 * k) * M, B.z); B.f.scale.setScalar((18 + 50 * Math.min(1, k * 3)) * B.k * M); B.f.material.opacity = Math.max(0, 1 - k / 1.2); B.d.visible = true; B.d.position.set(B.x, (10 + 25 * Math.sqrt(k)) * M, B.z); B.d.scale.setScalar((20 + 70 * Math.sqrt(k / 9)) * B.k * M); B.d.material.opacity = 0.85 * Math.max(0, 1 - k / 9); }
    // men: the crews hop about their guns; every so often one sprints to the bunker / the next gun
    const mh = 0.85 * M;
    for (const P of men) {
      const dx = P.tx - P.x, dz = P.tz - P.z, d = Math.hypot(dx, dz);
      if (d < 0.3 * M) { P.wait -= dt; if (P.wait <= 0) { const G = BAT[0].guns[(R() * 4) | 0]; if (R() < 0.25) { P.tx = me.x + 22 * M + RR(-4, 4) * M; P.tz = me.z - 59 * M + RR(-1, 1) * M; } else { P.tx = G.x + RR(-3.5, 3.5) * M; P.tz = G.z + RR(-3.5, 3.5) * M; } P.wait = RR(0.3, 2.5); } }
      else { const st = Math.min(d, P.sp * dt); P.x += dx / d * st; P.z += dz / d * st; P.g.rotation.y = Math.atan2(dx, dz); P.ph += dt * 11; }
      P.g.position.set(P.x, 0, P.z);
      const sw = d < 0.3 * M ? 0 : Math.sin(P.ph) * 0.6; P.legs[0].rotation.x = sw; P.legs[1].rotation.x = -sw; P.legs[0].position.y = P.legs[1].position.y = mh / 2 + 0.02 * M;
    }
    void flakG;
  }
  function fireMine() { if (!myGun) return; const G = myGun; G.rec = 1; const F = flashes.find((f) => f.t > 0.4) || flashes[0]; F.t = 0; F.g = G; const P = puffs.find((p) => p.t > p.life) || puffs[0]; P.t = -0.05; P.life = RR(8, 12); P.g = G; P.vx = RR(1.5, 3) * M; P.vz = RR(-0.5, 0.5) * M; stats.mine = (stats.mine || 0) + 1; const A = audio || window.FGAudio; if (A && A.gun88) A.gun88(4); }
  function project(x, y, z) { _pj.set(x, y, z).project(camera); return { x: _pj.x, y: _pj.y, ok: _pj.z < 1 && Math.abs(_pj.x) < 1.2 && Math.abs(_pj.y) < 1.2 }; }
  return { pose, off, update, impact, stats, fireMine, project, get on() { return on; }, get me() { return me; }, get _root() { return root; }, get _camera() { return camera; } };
}
