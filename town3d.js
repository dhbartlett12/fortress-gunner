// 1.6.8 TOWN — a procedural German market town (Fortress Gunner).
// ONE layout (streets, houses, trees, rail, factory, airfield, fields) feeds BOTH:
//   • the high-res ground bake (canvas → ground shader, post-fog, used from altitude), and
//   • the instanced 3D town (walls / roofs / trees, a few draw calls, shown below ~15k ft AGL).
// Town-local units: 1 u = 61 m (landG unit × TOWN_S). Rotation convention matches game.js rectDist:
// an object with yaw `rot` has its local +x along world (cos rot, −sin rot) and local +z along (sin rot, cos rot).
import * as THREE from "three";

export function createTown3D(env) {
  const { landG, earthFog, TOWN_X, TOWN_Z, TOWN_S } = env;
  const KC = 0.4, VS = 0.7, YARD_A = 0; // target complex (depot / factory) scale + yard axis — unchanged gameplay anchors
  let seed = 1944;
  const R = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const RR = (a, b) => a + (b - a) * R();
  const pick = (a) => a[(R() * a.length) | 0];
  const t0 = (typeof performance !== "undefined" ? performance.now() : 0);

  // ---------------------------------------------------------------- root + shading
  const root = new THREE.Group(); root.name = "town3d";
  root.position.set(TOWN_X, 0.0, TOWN_Z); root.scale.setScalar(TOWN_S); // ON the ground (walls dip below it): bake shadows line up with the 3D
  landG.add(root);
  // one fixed sun in TOWN space shared by bake + 3D, so lit / shaded roof sides and ground shadows always agree
  const SUN_L = new THREE.Vector3(-0.50, 0.58, -0.64).normalize();
  const sunU = { value: SUN_L.clone() };
  const SH_AMB = 0.40, SH_SKY = 0.10, SH_DIF = 0.74;
  const shadeOf = (nx, ny, nz) => SH_AMB + SH_SKY * (0.5 + 0.5 * ny) + SH_DIF * Math.max(0, nx * SUN_L.x + ny * SUN_L.y + nz * SUN_L.z);
  const mats = [];
  function shadedMat(color, extra) {
    const m = new THREE.MeshBasicMaterial(Object.assign({ color, fog: true }, extra || {}));
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uSunW = sunU;
      sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nuniform vec3 uSunW;\nvarying float vShade;")
        .replace("#include <begin_vertex>", `#include <begin_vertex>
  vec3 nO = normal;
#ifdef USE_INSTANCING
  mat3 im3 = mat3(instanceMatrix);
  nO = im3 * (normal / max(vec3(dot(im3[0], im3[0]), dot(im3[1], im3[1]), dot(im3[2], im3[2])), vec3(1e-8)));
#endif
  vec3 nW = normalize(mat3(modelMatrix) * nO);
  vShade = ${SH_AMB.toFixed(3)} + ${SH_SKY.toFixed(3)} * (0.5 + 0.5 * nW.y) + ${SH_DIF.toFixed(3)} * max(dot(nW, uSunW), 0.0);`);
      sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nvarying float vShade;")
        .replace("#include <color_fragment>", "#include <color_fragment>\n  diffuseColor.rgb *= vShade;");
      earthFog(sh);
    };
    m._earthFog = true; mats.push(m); return m;
  }

  // ---------------------------------------------------------------- occupancy grid (town-local)
  const G_H = 40, G_C = 0.04, GN = Math.ceil(2 * G_H / G_C);
  const occ = new Uint8Array(GN * GN); // 0 free, 1 street, 2 building, 3 reserved, 4 tree
  const gi = (v) => Math.floor((v + G_H) / G_C);
  function rectCells(cx, cz, hx, hz, rot, fn) {
    const c = Math.cos(rot), s = Math.sin(rot);
    const ex = Math.abs(c) * hx + Math.abs(s) * hz, ez = Math.abs(s) * hx + Math.abs(c) * hz;
    const ix0 = Math.max(0, gi(cx - ex)), ix1 = Math.min(GN - 1, gi(cx + ex)), iz0 = Math.max(0, gi(cz - ez)), iz1 = Math.min(GN - 1, gi(cz + ez));
    for (let iz = iz0; iz <= iz1; iz++) {
      const pz = (iz + 0.5) * G_C - G_H - cz;
      for (let ix = ix0; ix <= ix1; ix++) {
        const px = (ix + 0.5) * G_C - G_H - cx;
        const lx = px * c - pz * s, lz = px * s + pz * c;
        if (Math.abs(lx) <= hx && Math.abs(lz) <= hz) { if (fn(iz * GN + ix) === false) return false; }
      }
    }
    return true;
  }
  const stampRect = (cx, cz, hx, hz, rot, v) => rectCells(cx, cz, hx, hz, rot, (k) => { occ[k] = v; });
  const freeRect = (cx, cz, hx, hz, rot) => rectCells(cx, cz, hx, hz, rot, (k) => occ[k] === 0);
  function stampSeg(ax, az, bx, bz, hw, v, onlyFree) {
    const ix0 = Math.max(0, gi(Math.min(ax, bx) - hw)), ix1 = Math.min(GN - 1, gi(Math.max(ax, bx) + hw));
    const iz0 = Math.max(0, gi(Math.min(az, bz) - hw)), iz1 = Math.min(GN - 1, gi(Math.max(az, bz) + hw));
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9;
    for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
      const px = (ix + 0.5) * G_C - G_H, pz = (iz + 0.5) * G_C - G_H;
      let t = ((px - ax) * dx + (pz - az) * dz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + dx * t - px, qz = az + dz * t - pz;
      if (qx * qx + qz * qz <= hw * hw) { const k = iz * GN + ix; if (!onlyFree || occ[k] === 0) occ[k] = v; }
    }
  }
  const stampDisk = (x, z, r, v) => stampSeg(x, z, x + 1e-4, z, r, v, true);
  const occAt = (x, z) => { const ix = gi(x), iz = gi(z); return (ix < 0 || iz < 0 || ix >= GN || iz >= GN) ? 3 : occ[iz * GN + ix]; };
  const freeDisk = (x, z, r) => { for (let a = 0; a < 6; a++) if (occAt(x + Math.cos(a) * r, z + Math.sin(a) * r)) return false; return occAt(x, z) === 0; };

  // ---------------------------------------------------------------- plan anchors
  const PK = 1.36;                            // plan scale: big enough to read from 25,000 ft (core ≈ 1.25 km across, built-up ≈ 3.5 km)
  const C = [-13.9, 0.8];                    // church / market (old-town centre)
  const B = [-5.6, 1.0], BH = 35;            // bake centre + half-size (town-local)
  const YARD = { x0: -1.5, x1: 1.4, z0: -7.6, z1: 7.6 };
  const CXG_ZONE = { x0: -2.75, x1: 9.3, z0: -11.4, z1: 8.6 };
  const inCXG = (x, z, m) => x > CXG_ZONE.x0 - (m || 0) && x < CXG_ZONE.x1 + (m || 0) && z > CXG_ZONE.z0 - (m || 0) && z < CXG_ZONE.z1 + (m || 0);
  const AF = { x: 15.6, z: 4.4, rx: 6.3, rz: 5.0, rot: 0.28 };
  const inAF = (x, z, m) => { const dx = x - AF.x, dz = z - AF.z, c = Math.cos(AF.rot), s = Math.sin(AF.rot); const u = (dx * c - dz * s) / (AF.rx + (m || 0)), v = (dx * s + dz * c) / (AF.rz + (m || 0)); return u * u + v * v < 1; };
  const ringR = (th) => {
    let r = PK * (7.5 + 0.75 * Math.sin(3 * th + 0.7) + 0.45 * Math.sin(5 * th + 2.1) + 0.22 * Math.sin(8 * th + 0.4) + 0.5 * Math.sin(2 * th + 4.0));
    const cx = Math.cos(th); if (cx > 0.05) r = Math.min(r, (-3.05 - C[0]) / cx); // old wall runs along the railway on the east side
    return r;
  };
  const subR = (th) => PK * (12.4 + 2.4 * Math.sin(2 * th + 1.3) + 1.5 * Math.sin(5 * th + 0.2) + 0.9 * Math.sin(9 * th + 2.0) + 0.6 * Math.sin(13 * th));
  const polar = (r, th) => [C[0] + r * Math.cos(th), C[1] + r * Math.sin(th)];
  const thOf = (x, z) => Math.atan2(z - C[1], x - C[0]);
  const rOf = (x, z) => Math.hypot(x - C[0], z - C[1]);

  // ---------------------------------------------------------------- target complex (gameplay: keys / wagons / tracks / stalls)
  const TL = { houses: [], keys: [], stalls: [], wagons: [], tracks: [] };
  const TS = { houseM: [], roofM: [], wallC: [], wagonM: [], walls: null, roofs: null, wagons: null, keyMesh: [], stallMesh: [], craters: null, nCr: 0, rubble: null, hit: new Set(), trees: null, big: null };
  const bigRects = []; // for the bake: [x, z, hx, hz, rot, h, colour, kind]
  const CXG = new THREE.Group(); CXG.scale.setScalar(KC); root.add(CXG); TS.cxg = CXG;
  const ax = (u, v) => { const c = Math.cos(YARD_A), s = Math.sin(YARD_A); v *= VS; return [u * c + v * s, -u * s + v * c]; };
  const roofDark = shadedMat(0x55504a), brick = shadedMat(0x7a5e50), stone = shadedMat(0xa49c8e), shedM = shadedMat(0x5a5854), hallRoof = shadedMat(0x3e3c3a);
  {
    const wagonGeo = new THREE.BoxGeometry(0.2, 0.2, 0.85);
    const wagons = new THREE.InstancedMesh(wagonGeo, shadedMat(0xffffff), 140);
    const m4 = new THREE.Matrix4(), sc = new THREE.Vector3(1, 1, 1), pv = new THREE.Vector3();
    const yq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), YARD_A);
    const wcol = [0x5a4638, 0x4c4a46, 0x6a5a48, 0x584238];
    for (let i = 0; i < 140; i++) {
      const tr = (R() * 12) | 0, u = -3.1 + 0.25 + tr * (5.7 / 11), v = -26 + R() * 52;
      const [px, pz] = ax(u, v);
      pv.set(px, 0.1, pz); m4.compose(pv, yq, sc); wagons.setMatrixAt(i, m4); TL.wagons.push([px, pz, 0.1, 0.425, YARD_A]); TS.wagonM.push(m4.clone());
      wagons.setColorAt(i, new THREE.Color(pick(wcol)).multiplyScalar(0.8 + R() * 0.4));
    }
    CXG.add(wagons); TS.wagons = wagons;
    for (let tr = 0; tr < 12; tr++) for (let j = 0; j < 13; j++) { const [tx, tz] = ax(-3.1 + 0.25 + tr * (5.7 / 11), -24 + 4 * j); TL.tracks.push([tx, tz, 0.15, 2.0 * VS, YARD_A]); }
    const box = (w, h, d, u, v, mat, col, kind) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      const [px, pz] = ax(u, v); m.position.set(px, h / 2, pz); m.rotation.y = YARD_A; CXG.add(m);
      bigRects.push([px * KC, pz * KC, w / 2 * KC, d / 2 * KC, YARD_A, h * KC, col, kind || "flat"]);
      return m;
    };
    const keyB = (name, w, d, u, v, m, kind) => { const [px, pz] = ax(u, v); TL.keys.push([px, pz, w / 2, d / 2, YARD_A, name, kind || "d"]); TS.keyMesh.push(m); return m; };
    keyB("engine shed", 2.2, 9, 4.6, 12, box(2.2, 0.7, 9, 4.6, 12, roofDark, [85, 80, 74]));
    keyB("station", 1.6, 5.5, -4.8, -2, box(1.6, 0.9, 5.5, -4.8, -2, stone, [120, 92, 80]));
    keyB("goods shed", 1.0, 1.4, -4.8, -6.2, box(1.0, 0.6, 1.4, -4.8, -6.2, brick, [112, 90, 76]));
    keyB("works", 3.2, 1.8, 5.2, -14, box(3.2, 0.9, 1.8, 5.2, -14, brick, [96, 84, 74]), "d");
    keyB("goods hall", 2.4, 3.2, -6.2, 16, box(2.4, 1.1, 3.2, -6.2, 16, brick, [100, 86, 76]), "d");
    { // roundhouse: a 3/4 ring of stalls around a turntable
      for (let k = 0; k < 14; k++) { // 1.6.8: two long rows of engine stalls (the 3/4 ring read as a stadium)
        const row = k < 7 ? 0 : 1, [px, pz] = ax(3.9 + row * 1.62, 17.6 + (k % 7) * 0.64);
        const st = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.45, 0.62), roofDark);
        st.position.set(px, 0.22, pz);
        st.rotation.y = YARD_A; CXG.add(st); TL.stalls.push([st.position.x, st.position.z, 0.75, 0.31, st.rotation.y]); TS.stallMesh.push(st);
        bigRects.push([st.position.x * KC, st.position.z * KC, 0.75 * KC, 0.31 * KC, st.rotation.y, 0.45 * KC, [82, 78, 72], "flat"]);
      }
      TS.turntable = null;
    }
    const sawG = (() => { const g = new THREE.BufferGeometry(); const v = [
        -0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 1, -0.5,   -0.5, 0, 0.5, 0.5, 1, 0.5, 0.5, 0, 0.5, // end triangles
        -0.5, 0, -0.5, 0.5, 1, -0.5, 0.5, 1, 0.5,  -0.5, 0, -0.5, 0.5, 1, 0.5, -0.5, 0, 0.5, // sloped roof (faces −x / up)
        0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 1, 0.5,  0.5, 0, -0.5, 0.5, 1, 0.5, 0.5, 1, -0.5 ]; // vertical glazing (faces +x)
        g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3)); g.computeVertexNormals(); return g; })();
    { // TRAIN DEPOT (target): long sawtooth train shed over the yard throat + station hall + clock tower (1.6.8: was an arched shed that read as a hangar)
      const hallM = stone, roofM = hallRoof;
      const shed = box(5.8, 1.0, 11, 6.2, -24, shedM, [66, 64, 62], "saw"); keyB("train depot shed", 5.8, 11, 6.2, -24, shed, "d");
      { const sawD = shadedMat(0x3c3a38); for (let k = 0; k < 7; k++) { const [px, pz] = ax(6.2 - 2.9 + 0.41 + k * 0.83, -24); const t = new THREE.Mesh(sawG, sawD); t.position.set(px, 1.0, pz); t.rotation.y = YARD_A; t.scale.set(0.83, 0.5, 10.8); CXG.add(t); } }
      const hall = box(7.2, 1.4, 2.6, 6.2, -35.1, hallM, [112, 86, 74]); keyB("train depot hall", 7.2, 2.6, 6.2, -35.1, hall, "d");
      { const [px, pz] = ax(8.6, -35.1); const clock = new THREE.Mesh(new THREE.BoxGeometry(0.7, 2.3, 0.7), hallM); clock.position.set(px, 1.15, pz); CXG.add(clock); const cap = new THREE.Mesh(new THREE.ConeGeometry(0.55, 0.9, 4), roofM); cap.position.set(px, 2.75, pz); cap.rotation.y = YARD_A + Math.PI / 4; CXG.add(cap); bigRects.push([px * KC, pz * KC, 0.35 * KC, 0.35 * KC, 0, 3.2 * KC, [70, 68, 66], "flat"]); }
      const [ex, ez] = ax(6.2, -35.1); TS.depotC = [ex * KC, ez * KC];
    }
    { // FACTORY (target): long dark sawtooth halls, power house, 4 tall brick stacks, storage tanks
      const FX = 10, hallM = shadedMat(0x5c5650), sawM = shadedMat(0x4a4642), glassM = shadedMat(0x8a8c88), chim = shadedMat(0x6e5044), tankM = shadedMat(0x9a968c);
      const keyD = (name, w, d, x, z, m, kind) => { TL.keys.push([x, z, w / 2, d / 2, 0, name, kind || "f"]); TS.keyMesh.push(m); return m; };
      const put = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); CXG.add(m); return m; };
      // sawtooth: north-light teeth across the hall (one prism each)

      for (let i = 0; i < 3; i++) {
        const z = -8 + i * 4.6, m = put(new THREE.BoxGeometry(11, 1.05, 3.8), hallM, FX, 0.525, z); keyD("factory hall " + "ABC"[i], 11, 3.8, FX, z, m);
        for (let k = 0; k < 7; k++) { const t = put(sawG, k % 1 ? glassM : sawM, FX - 4.7 + k * 1.57, 1.05, z); t.scale.set(1.57, 0.55, 3.7); }
        bigRects.push([FX * KC, z * KC, 5.5 * KC, 1.9 * KC, 0, 1.6 * KC, [72, 68, 64], "saw"]);
      }
      keyD("power house", 3.4, 3.4, 19.5, -6, put(new THREE.BoxGeometry(3.4, 1.5, 3.4), hallM, 19.5, 0.75, -6)); bigRects.push([19.5 * KC, -6 * KC, 1.7 * KC, 1.7 * KC, 0, 1.5 * KC, [80, 70, 64], "flat"]);
      keyD("chimney", 0.7, 0.7, 18, 1, put(new THREE.CylinderGeometry(0.22, 0.36, 7.2, 8), chim, 18, 3.6, 1));
      keyD("chimney", 0.7, 0.7, 20, 5, put(new THREE.CylinderGeometry(0.2, 0.32, 6.6, 8), chim, 20, 3.3, 5));
      TS.stacks = [[18 * KC, 1 * KC, 7.2 * KC], [20 * KC, 5 * KC, 6.6 * KC]];
      for (const [sx, sz, sh] of [[16.2, -9.6, 6.9], [21.6, -2.2, 6.2]]) { put(new THREE.CylinderGeometry(0.2, 0.32, sh, 8), chim, sx, sh / 2, sz); TS.stacks.push([sx * KC, sz * KC, sh * KC]); } // 1.6.8: 4 stacks
      { const z = -8 + 3 * 4.6 - 0.4; put(new THREE.BoxGeometry(9, 1.0, 3.2), hallM, FX - 1, 0.5, z); for (let k = 0; k < 6; k++) { const t = put(sawG, sawM, FX - 1 - 3.7 + k * 1.5, 1.0, z); t.scale.set(1.5, 0.55, 3.1); } bigRects.push([(FX - 1) * KC, z * KC, 4.5 * KC, 1.6 * KC, 0, 1.5 * KC, [72, 68, 64], "saw"]); }
      { // a little smoke drifting off each stack (sprites; only with the near 3D)
        const c = document.createElement("canvas"); c.width = c.height = 64; const g = c.getContext("2d"); const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, "rgba(200,198,194,0.9)"); gr.addColorStop(0.5, "rgba(180,178,174,0.45)"); gr.addColorStop(1, "rgba(170,168,164,0)"); g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
        const smT = new THREE.CanvasTexture(c);
        for (const [sx, sz, sh] of TS.stacks) for (let k = 0; k < 6; k++) { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: smT, transparent: true, depthWrite: false, fog: false, opacity: 0.55 * (1 - k / 7) })); const s2 = 0.7 + k * 0.55; sp.scale.set(s2, s2, 1); sp.position.set(sx / KC + k * 0.55, sh / KC + 0.3 + k * 0.32, sz / KC - k * 0.2); CXG.add(sp); }
      }
      for (let k = 0; k < 3; k++) { put(new THREE.CylinderGeometry(0.9, 0.9, 0.9, 12), tankM, 17 + k * 2.2, 0.45, 12); bigRects.push([(17 + k * 2.2) * KC, 12 * KC, 0.9 * KC, 0.9 * KC, 0, 0.9 * KC, [150, 146, 136], "tank"]); }
      // a few low works buildings round the halls
      for (const [x, z, w, d, h] of [[4.8, -12.4, 4.4, 2.0, 0.8], [15.8, 8.4, 3.2, 2.2, 0.7], [22.8, 2.6, 2.0, 3.6, 0.9], [3.6, 7.6, 2.6, 1.6, 0.6]]) { put(new THREE.BoxGeometry(w, h, d), roofDark, x, h / 2, z); bigRects.push([x * KC, z * KC, w / 2 * KC, d / 2 * KC, 0, h * KC, [88, 82, 76], "flat"]); }
    }
    for (const A of [TL.wagons, TL.tracks, TL.stalls, TL.keys]) for (const e of A) { e[0] *= KC; e[1] *= KC; e[2] *= KC; e[3] *= KC; } // complex coordinates → town-local
  }

  // ---------------------------------------------------------------- reserve: target complex, airfield, rail, church + square
  stampRect((CXG_ZONE.x0 + CXG_ZONE.x1) / 2, (CXG_ZONE.z0 + CXG_ZONE.z1) / 2, (CXG_ZONE.x1 - CXG_ZONE.x0) / 2, (CXG_ZONE.z1 - CXG_ZONE.z0) / 2, 0, 3);
  for (let iz = gi(AF.z - 8); iz <= gi(AF.z + 8); iz++) for (let ix = gi(AF.x - 8); ix <= gi(AF.x + 8); ix++) { const x = (ix + 0.5) * G_C - G_H, z = (iz + 0.5) * G_C - G_H; if (inAF(x, z, 0.3)) occ[iz * GN + ix] = 3; }
  // rail: main double line west of the yard, curving away north-west and south-east
  const railX = (z) => { const a = Math.abs(z); if (a <= 7.6) return -1.4; const d = a - 7.6; return z < 0 ? -1.4 - 0.0105 * d * d - 0.02 * d : -1.4 + 0.009 * d * d + 0.02 * d; };
  const railPts = []; for (let z = -46; z <= 46; z += 0.4) railPts.push([railX(z), z]);
  for (let i = 0; i < railPts.length - 1; i++) stampSeg(railPts[i][0], railPts[i][1], railPts[i + 1][0], railPts[i + 1][1], 0.3, 3);
  const CH = { x: C[0], z: C[1], len: 1.18, wid: 0.36, rot: 0.08 };            // church (nave along x, tower at the west end)
  const SQ = { x: C[0] + 1.45, z: C[1] + 0.35, hx: 0.85, hz: 0.62, rot: -0.12 }; // market square east of the church
  stampRect(CH.x, CH.z, CH.len / 2 + 0.12, CH.wid / 2 + 0.22, CH.rot, 3);
  stampRect(SQ.x, SQ.z, SQ.hx, SQ.hz, SQ.rot, 1);
  // public buildings round the square (town hall, guild halls, school) — [x, z, hx, hz, rot, wall h, roof]
  const PUB = [[SQ.x + 0.05, SQ.z - SQ.hz - 0.21, 0.5, 0.18, SQ.rot, 0.34, [92, 90, 92]], [SQ.x + SQ.hx + 0.21, SQ.z + 0.05, 0.17, 0.44, SQ.rot, 0.3, [150, 100, 82]],
    [SQ.x - 0.1, SQ.z + SQ.hz + 0.21, 0.42, 0.17, SQ.rot, 0.3, [138, 96, 80]], [C[0] - 1.35, C[1] - 1.15, 0.44, 0.2, 0.5, 0.28, [96, 94, 96]], [C[0] + 0.4, C[1] - 2.3, 0.36, 0.22, -0.3, 0.26, [146, 104, 86]]];
  for (const p of PUB) stampRect(p[0], p[1], p[2] + 0.04, p[3] + 0.04, p[4], 3);

  // ---------------------------------------------------------------- streets
  const streets = []; // {pts, w, kind}
  const DC = 0.25, DN = Math.ceil(2 * G_H / DC); const dirA = new Float32Array(DN * DN), dirD = new Float32Array(DN * DN).fill(1e9);
  function addStreet(pts, w, kind) {
    if (pts.length < 2) return;
    streets.push({ pts, w, kind });
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax0, az0] = pts[i], [bx0, bz0] = pts[i + 1];
      stampSeg(ax0, az0, bx0, bz0, w / 2, 1, kind === "country");
      const ang = Math.atan2(-(bz0 - az0), bx0 - ax0), mx = (ax0 + bx0) / 2, mz = (az0 + bz0) / 2;
      const j0 = Math.floor((mx + G_H) / DC), k0 = Math.floor((mz + G_H) / DC);
      for (let k = k0 - 4; k <= k0 + 4; k++) for (let j = j0 - 4; j <= j0 + 4; j++) {
        if (j < 0 || k < 0 || j >= DN || k >= DN) continue;
        const d = Math.hypot((j + 0.5) * DC - G_H - mx, (k + 0.5) * DC - G_H - mz) + (kind === "country" ? 0.6 : 0);
        if (d < dirD[k * DN + j]) { dirD[k * DN + j] = d; dirA[k * DN + j] = ang; }
      }
    }
  }
  const dirAt = (x, z) => { const j = Math.floor((x + G_H) / DC), k = Math.floor((z + G_H) / DC); return (j < 0 || k < 0 || j >= DN || k >= DN || dirD[k * DN + j] > 5) ? null : dirA[k * DN + j]; };
  const blocked = (x, z) => inCXG(x, z, 0.1) || inAF(x, z, 0.1);
  // radial streets out of the market (curving), on to suburbs / country roads
  const RAD = [0.1, 0.62, 1.12, 1.66, 2.15, 2.7, 3.18, 3.68, 4.2, 4.72, 5.2, 5.74];
  const radEnd = [];
  RAD.forEach((th0, k) => {
    const curl = RR(-0.1, 0.1), ph = R() * 6, Rend = (k % 3 === 0) ? 40 : RR(15, 23);
    const pts = []; const r0 = (k % 2 === 0) ? 1.05 : RR(2.1, 3.7);
    for (let r = r0; r <= Rend; r += 0.2) {
      const th = th0 + 0.07 * Math.sin(r * 0.5 + ph) + curl * (r / 8) * (r / 8) * (r < 9 ? 1 : 0.6);
      const p = polar(r, th);
      if (blocked(p[0], p[1]) || Math.abs(p[0] - B[0]) > BH || Math.abs(p[1] - B[1]) > BH) break;
      pts.push(p);
    }
    radEnd.push(pts.length);
    const nCore = pts.findIndex((p) => rOf(p[0], p[1]) > ringR(thOf(p[0], p[1])) + 0.1);
    const coreN = nCore < 0 ? pts.length : nCore;
    addStreet(pts.slice(0, coreN + 1), k % 4 === 0 ? 0.36 : k % 2 ? 0.16 : 0.2, "main"); // 1.6.8: three wide main streets cross the old town
    if (coreN < pts.length - 1) {
      const out = pts.slice(coreN);
      const subN = out.findIndex((p) => rOf(p[0], p[1]) > subR(thOf(p[0], p[1])) + 1.5);
      addStreet(out.slice(0, subN < 0 ? out.length : subN + 1), 0.17, "sub");
      if (subN >= 0) addStreet(out.slice(subN), 0.14, "country");
    }
  });
  // ring road (old wall line) — closed loop
  { const pts = []; for (let i = 0; i <= 180; i++) { const th = i / 180 * Math.PI * 2; pts.push(polar(ringR(th) + 0.18, th)); } addStreet(pts, 0.28, "ring"); }
  // inner curving lanes between radials
  for (const [rA, cover] of [[2.2, 0.9], [3.6, 0.88], [5.0, 0.85], [6.4, 0.8], [7.8, 0.7], [9.0, 0.5]]) {
    for (let k = 0; k < RAD.length; k++) {
      if (R() > cover) continue;
      const a0 = RAD[k] + 0.02, span = (RAD[(k + 1) % RAD.length] - RAD[k] + Math.PI * 2) % (Math.PI * 2) * (R() < 0.3 ? 2 : 1) - 0.04;
      const ph = R() * 6, pts = [];
      const steps = Math.max(3, Math.round(span * rA / 0.2));
      for (let i = 0; i <= steps; i++) { const th = a0 + span * i / steps; const r = Math.min(ringR(th) - 0.15, rA + 0.28 * Math.sin(th * 3.3 + ph) + RR(-0.03, 0.03)); pts.push(polar(r, th)); }
      addStreet(pts, 0.12, "lane");
    }
  }
  // short cross alleys
  for (let i = 0; i < 110; i++) {
    const th = R() * Math.PI * 2, r = RR(1.6, ringR(th) - 0.8), a = th + Math.PI / 2 + RR(-0.5, 0.5), L = RR(0.6, 1.3);
    const p = polar(r, th); const q = [p[0] + Math.cos(a) * L, p[1] + Math.sin(a) * L];
    if (rOf(q[0], q[1]) > ringR(thOf(q[0], q[1])) - 0.2 || rOf(q[0], q[1]) < 1.3) continue;
    addStreet([p, [(p[0] + q[0]) / 2 + RR(-0.08, 0.08), (p[1] + q[1]) / 2 + RR(-0.08, 0.08)], q], 0.09, "lane");
  }
  // suburbs: concentric-ish streets + a few straight newer estates
  for (const rA of [11.6, 13.0, 14.5, 16.0, 17.6, 19.2]) {
    for (let k = 0; k < RAD.length; k++) {
      if (R() > 0.66) continue;
      const a0 = RAD[k] + 0.03, span = (RAD[(k + 1) % RAD.length] - RAD[k] + Math.PI * 2) % (Math.PI * 2) - 0.06;
      const ph = R() * 6, pts = []; const steps = Math.max(3, Math.round(span * rA / 0.25));
      for (let i = 0; i <= steps; i++) { const th = a0 + span * i / steps; const r = rA + 0.5 * Math.sin(th * 2.1 + ph); if (r > subR(th) + 0.6) break; const p = polar(r, th); if (blocked(p[0], p[1])) break; pts.push(p); }
      addStreet(pts, 0.13, "sub");
    }
  }
  for (const [th, r, n, sp, L] of [[2.85, 14.6, 6, 0.75, 4.2], [4.2, 14.2, 5, 0.8, 3.8], [1.55, 15.2, 5, 0.78, 3.4], [3.55, 16.8, 4, 0.85, 3.2], [5.0, 15.0, 4, 0.8, 3.0], [0.95, 13.6, 4, 0.8, 2.8]]) {
    const c = polar(r, th), ta = th + Math.PI / 2 + RR(-0.2, 0.2), tx = Math.cos(ta), tz = Math.sin(ta), nx = Math.cos(th), nz = Math.sin(th);
    for (let i = 0; i < n; i++) { const o = (i - (n - 1) / 2) * sp; const pts = []; for (let s = -L / 2; s <= L / 2 + 1e-6; s += 0.25) { const p = [c[0] + nx * o + tx * s, c[1] + nz * o + tz * s]; if (blocked(p[0], p[1])) break; pts.push(p); } addStreet(pts, 0.12, "sub"); }
    const pts = []; for (let s = -((n - 1) / 2) * sp - 0.3; s <= ((n - 1) / 2) * sp + 0.3; s += 0.25) pts.push([c[0] + nx * s, c[1] + nz * s]); addStreet(pts, 0.12, "sub");
  }
  // roads: station approach, town → factory / airfield (level crossing) and a farm track net
  addStreet([[SQ.x + 0.5, SQ.z], ...Array.from({ length: 14 }, (_, i) => { const t = (i + 1) / 14; return [SQ.x + 0.5 + t * (-2.25 - SQ.x - 0.5), SQ.z + Math.sin(t * 3.0) * 0.25 - t * 1.6]; })], 0.18, "main");
  { const pts = []; for (let x = -3.2; x <= 9.8; x += 0.3) pts.push([x, 9.3 + 0.18 * Math.sin(x * 0.4)]); addStreet(pts, 0.15, "country"); }
  { const pts = []; for (let z = 9.3; z <= 30; z += 0.3) pts.push([9.8 + 0.4 * Math.sin(z * 0.15), z]); addStreet(pts, 0.13, "country"); }

  // ---------------------------------------------------------------- houses
  const H = []; // {x,z,rot,len,span,h,rh,roof:[r,g,b],wall:[r,g,b],core}
  // 1.6.8b: weathered, desaturated roofs like the photos — grey-brown and dark slate, muted terracotta only in patches
  const ROOF_SLATE = [[94, 91, 90], [104, 99, 95], [84, 83, 85], [112, 106, 100], [98, 93, 88], [118, 112, 104], [108, 101, 93]];
  const ROOF_TILE = [[122, 101, 90], [114, 95, 86], [130, 107, 94], [108, 91, 84], [136, 112, 98], [118, 100, 91]];
  const ROOF_DARK = ROOF_SLATE.map((c) => c.map((v) => v * 0.72)), ROOF_RED = ROOF_TILE.map((c) => [Math.min(255, c[0] * 1.06), c[1] * 0.95, c[2] * 0.9]); // patches like ref3
  const WALLS = [[192, 182, 166], [180, 170, 154], [168, 158, 144], [200, 190, 174], [178, 164, 146]];
  const tooNearC = (x, z, m) => Math.abs(x - SQ.x) < SQ.hx + m && Math.abs(z - SQ.z) < SQ.hz + m;
  function tryHouse(x, z, rot, len, span, h, roofSet, core) {
    if (blocked(x, z) || tooNearC(x, z, 0.02)) return false;
    if (core) { const n = Math.sin(x * 0.85 + 1.3) * Math.cos(z * 0.7 - 0.4) + 0.5 * Math.sin((x - z) * 1.6 + 0.7); roofSet = n > 0.32 ? ROOF_DARK : n < -0.32 ? ROOF_RED : roofSet; }
    if (!freeRect(x, z, len / 2 + 0.006, span / 2 + 0.006, rot)) return false;
    stampRect(x, z, len / 2 + 0.008, span / 2 + 0.008, rot, 2);
    const pitch = core ? RR(0.95, 1.25) : RR(0.7, 1.05); // roof height / half-span (≈45–52° core, ≈35–45° suburbs)
    let roof = pick(roofSet).map((c) => c * RR(0.9, 1.08));
    { const bx = Math.floor(x / 0.85), bz = Math.floor(z / 0.85), hsh = Math.abs(Math.sin(bx * 12.9898 + bz * 78.233) * 43758.5453) % 1; const f = core ? 0.84 + 0.28 * hsh : 0.95 + 0.1 * hsh; const l = (roof[0] + roof[1] + roof[2]) / 3; roof = roof.map((c) => (c * 0.72 + l * 0.28) * f); } // block-to-block darkness, −28 % saturation
    H.push({ x, z, rot, len, span, h, rh: span / 2 * pitch, roof, wall: pick(WALLS).map((c) => c * RR(0.92, 1.04)), core });
    return true;
  }
  function frontage(st, opt) {
    const { pts, w } = st;
    for (const side of [-1, 1]) {
      let i = 0, acc = 0; // walk arclength
      let segL = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
      let t = RR(0, 0.1);
      while (true) {
        while (i < pts.length - 1 && t > acc + segL) { acc += segL; i++; if (i < pts.length - 1) segL = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); }
        if (i >= pts.length - 1) break;
        const f = (t - acc) / (segL || 1e-6), p = [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f];
        const tx = (pts[i + 1][0] - pts[i][0]) / (segL || 1), tz = (pts[i + 1][1] - pts[i][1]) / (segL || 1), nx = -tz * side, nz = tx * side;
        const r = rOf(p[0], p[1]), th = thOf(p[0], p[1]);
        const zone = r < ringR(th) - 0.05 ? "core" : r < subR(th) ? "sub" : r < subR(th) + 3.5 ? "edge" : "country";
        const P = opt(zone, r);
        if (!P) { t += 0.25; continue; }
        const along = RR(P.f[0], P.f[1]), deep = RR(P.d[0], P.d[1]);
        const gable = R() < P.gable; // ridge perpendicular to the street (gable end to the street)
        const len = gable ? deep : along, span = gable ? along : deep;
        const rotT = Math.atan2(-tz, tx), rot = gable ? rotT + Math.PI / 2 : rotT;
        const set = w / 2 + P.set + deep / 2;
        let ok = false;
        if (R() < P.p) ok = tryHouse(p[0] + nx * set, p[1] + nz * set, rot + RR(-P.jit, P.jit), len, span, RR(P.h[0], P.h[1]), P.roofs, zone === "core");
        if (ok && P.rear && R() < P.rear) { // rear wing / back house
          const d2 = RR(P.d[0], P.d[1]) * 0.8, set2 = set + deep / 2 + 0.02 + d2 / 2;
          tryHouse(p[0] + nx * set2, p[1] + nz * set2, rot + (R() < 0.5 ? Math.PI / 2 : 0), d2, along * RR(0.8, 1.0), RR(P.h[0], P.h[1]) * 0.85, P.roofs, zone === "core");
        }
        if (P.garden && ok && R() < P.garden) { const gb = set + deep / 2 + RR(0.12, 0.35); garden.push([p[0] + nx * gb + RR(-0.06, 0.06), p[1] + nz * gb + RR(-0.06, 0.06)]); }
        t += ok ? along + RR(P.gap[0], P.gap[1]) : 0.05;
      }
    }
  }
  const garden = [];
  const ROOF_MIX_CORE = [...ROOF_SLATE, ...ROOF_SLATE, ...ROOF_SLATE, ...ROOF_TILE];
  const ROOF_MIX_SUB = [...ROOF_TILE, ...ROOF_TILE, ...ROOF_SLATE];
  const coreOpt = (zone, r) => zone === "core" ? { f: [0.13, 0.23], d: [0.19, 0.3], gable: 0.5, set: 0.004, gap: [0, 0.006], p: 0.97, h: [0.14, 0.21], jit: 0.03, rear: 0.65, roofs: ROOF_MIX_CORE }
    : zone === "sub" ? { f: [0.16, 0.26], d: [0.15, 0.22], gable: 0.3, set: RR(0.04, 0.1), gap: [0.03, 0.14], p: 0.9, h: [0.11, 0.15], jit: 0.05, rear: 0.3, garden: 0.8, roofs: ROOF_MIX_SUB }
    : zone === "edge" ? { f: [0.16, 0.26], d: [0.15, 0.22], gable: 0.25, set: RR(0.06, 0.14), gap: [0.1, 0.45], p: 0.55, h: [0.1, 0.14], jit: 0.08, rear: 0.12, garden: 0.9, roofs: ROOF_MIX_SUB } : null;
  // core first (main → lanes), then the ring, then suburbs
  for (const k of ["main", "ring", "lane", "sub"]) for (const st of streets) if (st.kind === k) frontage(st, coreOpt);
  // 1.6.8b: courtyard gardens inside the blocks (reserved before the infill) and some larger roofs (inns, warehouses, convents)
  const yards = [];
  for (let i = 0; i < 1400 && yards.length < 150; i++) { const th = R() * Math.PI * 2, r = RR(1.3, ringR(th) - 0.35), p = polar(r, th); const rr = RR(0.1, 0.19); if (tooNearC(p[0], p[1], 0.1) || !freeDisk(p[0], p[1], rr + 0.03)) continue; stampDisk(p[0], p[1], rr, 4); yards.push([p[0], p[1], rr]); }
  for (let i = 0; i < 700; i++) { const th = R() * Math.PI * 2, r = RR(0.9, ringR(th) - 0.3), p = polar(r, th); const a = dirAt(p[0], p[1]); if (a == null) continue; tryHouse(p[0], p[1], a + (R() < 0.5 ? 0 : Math.PI / 2), RR(0.36, 0.58), RR(0.24, 0.34), RR(0.17, 0.25), ROOF_MIX_CORE, true); }
  // core infill: back-houses and courtyards, oriented to the nearest street
  for (let pass = 0; pass < 2; pass++) for (let z = C[1] - 13; z < C[1] + 13; z += 0.14) for (let x = C[0] - 13; x < C[0] + 13; x += 0.14) {
    const px = x + RR(-0.04, 0.04), pz = z + RR(-0.04, 0.04), r = rOf(px, pz);
    if (r > ringR(thOf(px, pz)) - 0.12 || R() > (r < 4 ? 0.7 : 0.5)) continue;
    const a = dirAt(px, pz); if (a == null) continue;
    const rot = a + (R() < 0.5 ? 0 : Math.PI / 2) + RR(-0.05, 0.05);
    tryHouse(px, pz, rot, RR(0.14, 0.27), RR(0.13, 0.22), RR(0.11, 0.18), ROOF_MIX_CORE, true);
  }
  // farmsteads along country roads
  for (const st of streets) if (st.kind === "country") for (let i = 4; i < st.pts.length; i += 6) {
    const p = st.pts[i], r = rOf(p[0], p[1]); if (r < subR(thOf(p[0], p[1])) + 2 || R() > 0.13) continue;
    const a = Math.atan2(-(st.pts[Math.min(i + 1, st.pts.length - 1)][1] - p[1]), st.pts[Math.min(i + 1, st.pts.length - 1)][0] - p[0]), s = R() < 0.5 ? -1 : 1;
    const cx = p[0] + Math.sin(a) * s * 0.45, cz = p[1] + Math.cos(a) * s * 0.45;
    tryHouse(cx, cz, a, RR(0.3, 0.45), RR(0.16, 0.22), 0.11, ROOF_TILE, false);
    tryHouse(cx + Math.sin(a) * s * 0.3, cz + Math.cos(a) * s * 0.3, a + Math.PI / 2, RR(0.25, 0.4), RR(0.15, 0.2), 0.12, ROOF_MIX_SUB, false);
    tryHouse(cx + Math.cos(a) * 0.36, cz - Math.sin(a) * 0.36, a + Math.PI / 2, RR(0.2, 0.3), RR(0.13, 0.17), 0.1, ROOF_SLATE, false);
    for (let k = 0; k < 5; k++) garden.push([cx + RR(-0.5, 0.5), cz + RR(-0.5, 0.5)]);
  }

  // ---------------------------------------------------------------- trees (gardens, courtyards, ring promenade, orchards, road + rail lines)
  const T = []; // [x, z, r, shadeVar]
  const addTree = (x, z, r) => { if (blocked(x, z)) return false; if (!freeDisk(x, z, r * 0.7)) return false; stampDisk(x, z, r * 0.8, 4); T.push([x, z, r, R()]); return true; };
  for (const [x, z] of garden) { const n = 1 + (R() * 3 | 0); for (let k = 0; k < n; k++) addTree(x + RR(-0.12, 0.12), z + RR(-0.12, 0.12), RR(0.06, 0.1)); }
  for (let i = 0; i < 420; i++) { const th = R() * Math.PI * 2, r = RR(1.5, ringR(th) - 0.3), p = polar(r, th); addTree(p[0], p[1], RR(0.05, 0.08)); } // courtyard trees
  for (const [yx, yz, yr] of yards) { const n = 2 + ((yr * 30) | 0); for (let k = 0; k < n; k++) { const a = R() * 6.283, d = Math.sqrt(R()) * yr * 0.75; T.push([yx + Math.cos(a) * d, yz + Math.sin(a) * d, RR(0.045, 0.075), R()]); } } // yard gardens
  { const n = 420; for (let i = 0; i < n; i++) { const th = i / n * Math.PI * 2; for (const o of [0.36, 0.52]) { if (R() < 0.25) continue; const p = polar(ringR(th) + 0.18 + o, th); addTree(p[0] + RR(-0.02, 0.02), p[1] + RR(-0.02, 0.02), RR(0.07, 0.1)); } } } // promenade on the old wall line
  const orchards = [];
  for (let i = 0; i < 26; i++) { // orchards just beyond the built-up edge
    const th = R() * Math.PI * 2, r = subR(th) + RR(-1.0, 2.6), p = polar(r, th); if (blocked(p[0], p[1]) || inCXG(p[0], p[1], 1)) continue;
    const a = th + RR(-0.3, 0.3), L = RR(0.9, 1.8), Wd = RR(0.6, 1.2), sp = RR(0.1, 0.13); orchards.push([p[0], p[1], L / 2, Wd / 2, a]);
    for (let u = -L / 2; u <= L / 2; u += sp) for (let v = -Wd / 2; v <= Wd / 2; v += sp) { if (R() < 0.12) continue; const x = p[0] + u * Math.cos(a) + v * Math.sin(a), z = p[1] - u * Math.sin(a) + v * Math.cos(a); addTree(x, z, RR(0.045, 0.06)); }
  }
  for (const st of streets) if (st.kind === "country" || (st.kind === "sub" && R() < 0.4)) { // avenue trees
    for (let i = 0; i < st.pts.length - 1; i++) { if (R() < 0.35) continue; const [x0, z0] = st.pts[i], [x1, z1] = st.pts[i + 1], L = Math.hypot(x1 - x0, z1 - z0) || 1, nx = -(z1 - z0) / L, nz = (x1 - x0) / L; for (const s of [-1, 1]) if (R() < 0.7) addTree(x0 + nx * s * (st.w / 2 + 0.07), z0 + nz * s * (st.w / 2 + 0.07), RR(0.055, 0.08)); }
  }
  for (let i = 0; i < railPts.length - 1; i += 1) { const [x0, z0] = railPts[i]; if (Math.abs(z0) < 12 || R() < 0.45) continue; for (const s of [-1, 1]) if (R() < 0.6) addTree(x0 + s * 0.42 + RR(-0.04, 0.04), z0 + RR(-0.1, 0.1), RR(0.06, 0.09)); }

  // ---------------------------------------------------------------- airfield furniture
  const AFX = { hangars: [[11.5, -1.0, 0.64, 0.44, 0.28 + Math.PI / 2], [11.1, 1.6, 0.64, 0.44, 0.28 + Math.PI / 2]], planes: [] };
  for (let i = 0; i < 7; i++) AFX.planes.push([12.5 + (i % 4) * 0.36 + RR(-0.05, 0.05), -1.2 + (i >> 2) * 2.4 + (i % 4) * 0.42, RR(0, 6.28), i % 3 === 0 ? 2.0 : 1.5]);
  for (let i = 0; i < 5; i++) { const a = RR(0, 6.28), p = [AF.x + Math.cos(a) * AF.rx * 0.82, AF.z + Math.sin(a) * AF.rz * 0.82]; AFX.planes.push([p[0], p[1], RR(0, 6.28), 1.5]); }

  // ---------------------------------------------------------------- BAKE
  const N = 2048, kpx = N / (2 * BH);
  const bake = document.createElement("canvas"); bake.width = bake.height = N;
  const x = bake.getContext("2d");
  x.setTransform(kpx, 0, 0, kpx, (BH - B[0]) * kpx, (BH - B[1]) * kpx); // draw in TOWN units
  const rgb = (c, a) => "rgba(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + "," + (a == null ? 1 : a) + ")";
  const mul = (c, k) => [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k)];
  const poly = (P) => { x.beginPath(); x.moveTo(P[0][0], P[0][1]); for (let i = 1; i < P.length; i++) x.lineTo(P[i][0], P[i][1]); x.closePath(); };
  const rectPts = (cx, cz, hx, hz, rot) => { const c = Math.cos(rot), s = Math.sin(rot); const X = [c, -s], Z = [s, c]; return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [cx + X[0] * a * hx + Z[0] * b * hz, cz + X[1] * a * hx + Z[1] * b * hz]); };
  const sunH = Math.hypot(SUN_L.x, SUN_L.z), tanE = SUN_L.y / sunH, shX = -SUN_L.x / sunH, shZ = -SUN_L.z / sunH; // ground-shadow direction
  const hull = (P) => { P = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]); const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); const lo = [], up = []; for (const p of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); } for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); } return lo.slice(0, -1).concat(up.slice(0, -1)); };
  const shadowOf = (pts, h) => { const L = h / tanE; return hull(pts.concat(pts.map(([a, b]) => [a + shX * L, b + shZ * L]))); };
  // fields (1.6.8): blocks of long rectangular strips on a gently rotated grid, each block its own orientation (no radial wedges), + woods
  const FIELD = [[194, 182, 148], [182, 170, 136], [170, 160, 126], [126, 142, 96], [140, 150, 104], [112, 130, 86], [150, 132, 106], [160, 146, 114], [132, 146, 100], [176, 168, 132]];
  const WOOD = [62, 78, 50];
  {
    const GA = 0.33, ca = Math.cos(GA), sa = Math.sin(GA), BS = 5.0;
    for (let j = -9; j <= 9; j++) for (let i = -9; i <= 9; i++) {
      const bu = i * BS + RR(-0.5, 0.5), bv = j * BS + RR(-0.5, 0.5);
      const cx = B[0] + bu * ca - bv * sa, cz = B[1] + bu * sa + bv * ca;
      if (Math.abs(cx - B[0]) > BH + BS || Math.abs(cz - B[1]) > BH + BS) continue;
      const r0 = rOf(cx, cz), hw = BS / 2 + 0.3;
      x.save(); x.translate(cx, cz); x.rotate(GA + RR(-0.1, 0.1)); x.beginPath(); x.rect(-hw, -hw, 2 * hw, 2 * hw); x.clip();
      if (r0 > 12 && R() < (r0 > 24 ? 0.16 : 0.1)) { // woodland block
        x.fillStyle = rgb(WOOD); x.fillRect(-hw, -hw, 2 * hw, 2 * hw);
        for (let k = 0; k < 700; k++) { x.fillStyle = rgb(mul(WOOD, RR(0.72, 1.2)), 0.85); x.beginPath(); x.arc(RR(-hw, hw), RR(-hw, hw), RR(0.06, 0.13), 0, 7); x.fill(); }
      } else {
        if (R() < 0.5) x.rotate(Math.PI / 2);
        const base = pick(FIELD); let v = -hw;
        while (v < hw) {
          const wv = RR(0.35, 1.25); let u = -hw;
          while (u < hw) {
            const lu = R() < 0.5 ? 2 * hw : RR(1.4, 3.6), col = R() < 0.5 ? pick(FIELD) : mul(base, RR(0.92, 1.07));
            x.fillStyle = rgb(col); x.fillRect(u, v, lu, wv);
            if (R() < 0.5) { x.fillStyle = rgb(mul(col, 0.93), 0.35); for (let q = v + 0.05; q < v + wv; q += 0.07) x.fillRect(u, q, lu, 0.02); } // furrows / mowing lines
            x.fillStyle = rgb(mul(col, 0.84), 0.55); x.fillRect(u, v, lu, 0.02); x.fillRect(u, v, 0.02, wv); // parcel boundaries
            u += lu;
          }
          v += wv;
        }
      }
      x.restore();
      // hedgerows / tree lines on some block edges
      for (const [e0, e1] of [[[-1, -1], [1, -1]], [[1, -1], [1, 1]]]) { if (R() < 0.55) continue; for (let t = 0; t <= 1; t += 0.018) { if (R() < 0.3) continue; const lu = (e0[0] + (e1[0] - e0[0]) * t) * BS / 2, lv = (e0[1] + (e1[1] - e0[1]) * t) * BS / 2; x.fillStyle = rgb(mul(WOOD, RR(0.8, 1.2)), 0.85); x.beginPath(); x.arc(cx + lu * ca - lv * sa, cz + lu * sa + lv * ca, RR(0.05, 0.08), 0, 7); x.fill(); } }
    }
    // the fringe round the town: allotments, kitchen gardens, small orchards, meadow — green, never bare tan
    const GP = [[96, 120, 74], [110, 132, 80], [124, 138, 90], [104, 116, 72], [132, 128, 92], [118, 128, 84]];
    for (let z = B[1] - 24; z < B[1] + 24; z += 0.3) for (let xx = B[0] - 24; xx < B[0] + 24; xx += 0.3) {
      const r = rOf(xx, z), th = thOf(xx, z), rr = ringR(th), sr = subR(th);
      if (r < rr + 0.2 || r > sr + 2.6 || inCXG(xx, z, 0.2) || inAF(xx, z, 0.4)) continue;
      const fade = r > sr + 1.2 ? 1 - (r - sr - 1.2) / 1.4 : 1; if (R() > fade) continue;
      const a = dirAt(xx, z); const rot = a == null ? GA : a;
      x.fillStyle = rgb(pick(GP), 0.9); poly(rectPts(xx + RR(-0.04, 0.04), z + RR(-0.04, 0.04), RR(0.12, 0.2), RR(0.08, 0.15), rot)); x.fill();
      if (R() < 0.18) for (let k = 0; k < 3; k++) { x.fillStyle = rgb(mul(WOOD, RR(0.9, 1.3)), 0.9); x.beginPath(); x.arc(xx + RR(-0.12, 0.12), z + RR(-0.12, 0.12), RR(0.04, 0.06), 0, 7); x.fill(); } // fruit trees
    }
  }
  // town ground: soft union round every building (yards / back gardens) — no hard outline
  for (const h of H) { const r = h.core ? 0.42 : 0.38; x.fillStyle = h.core ? "rgba(150,144,132,0.6)" : "rgba(120,128,94,0.5)"; x.beginPath(); x.arc(h.x, h.z, r, 0, 7); x.fill(); }
  for (const h of H) if (h.core) { x.fillStyle = "rgba(158,150,138,0.75)"; x.beginPath(); x.arc(h.x, h.z, 0.22, 0, 7); x.fill(); }
  for (const [yx, yz, yr] of yards) { x.fillStyle = rgb(pick([[98, 114, 74], [108, 120, 80], [116, 124, 86]]), 0.95); x.beginPath(); x.arc(yx, yz, yr, 0, 7); x.fill(); }
  for (const h of H) if (!h.core) { // kitchen-garden strips behind suburban houses
    const c = Math.cos(h.rot), s = Math.sin(h.rot);
    for (let k = 0; k < 3; k++) { x.fillStyle = rgb(pick([[110, 122, 82], [128, 118, 88], [100, 112, 76], [138, 132, 96]]), 0.6); const o = (k - 1) * 0.07; poly(rectPts(h.x + s * (0.2 + o), h.z + c * (0.2 + o), h.len / 2, 0.03, h.rot)); x.fill(); }
  }
  // industrial ground (target complex) and rail ballast
  { x.save(); try { x.filter = "blur(" + Math.round(0.5 * kpx) + "px)"; } catch (e) {} for (let k = 0; k < 46; k++) { const cx = RR(CXG_ZONE.x0 + 0.6, CXG_ZONE.x1 - 0.6), cz = RR(CXG_ZONE.z0 + 0.8, CXG_ZONE.z1 - 0.8); x.fillStyle = R() < 0.7 ? "rgba(112,108,98,0.5)" : "rgba(104,118,84,0.45)"; poly(rectPts(cx, cz, RR(0.6, 1.8), RR(0.5, 1.6), RR(-0.15, 0.15))); x.fill(); } x.restore(); }
  // airfield: mown grass with stripes, concrete runway, grass cross strip, apron
  {
    x.save(); x.translate(AF.x, AF.z); x.rotate(-AF.rot);
    x.fillStyle = "rgb(128,140,98)"; x.beginPath(); x.ellipse(0, 0, AF.rx, AF.rz, 0, 0, 7); x.fill();
    x.save(); x.beginPath(); x.ellipse(0, 0, AF.rx, AF.rz, 0, 0, 7); x.clip();
    for (let v = -AF.rz; v < AF.rz; v += 0.5) { x.fillStyle = ((v / 0.5) | 0) % 2 ? "rgba(146,156,112,0.55)" : "rgba(118,130,90,0.45)"; x.fillRect(-AF.rx, v, 2 * AF.rx, 0.5); }
    x.fillStyle = "rgba(170,172,146,0.75)"; x.fillRect(-0.3, -AF.rz, 0.6, 2 * AF.rz); // grass cross strip
    x.restore();
    x.rotate(-0.28 + AF.rot); x.fillStyle = "rgb(178,176,166)"; x.fillRect(-5.4, -0.32, 10.8, 0.64); x.fillStyle = "rgba(150,148,140,0.8)"; x.fillRect(-5.4, -0.02, 10.8, 0.04); // runway
    x.restore();
    x.fillStyle = "rgb(166,164,154)"; poly(rectPts(12.2, 0.5, 0.9, 2.2, 0.28)); x.fill(); // apron
    { x.strokeStyle = "rgb(160,158,148)"; x.lineWidth = 0.18; x.beginPath(); x.moveTo(12.6, 1.8); x.lineTo(14.2, 3.4); x.stroke(); }
  }
  // streets (edge darker, then light surface)
  const SC = { main: [200, 194, 182], ring: [194, 188, 176], lane: [178, 172, 162], sub: [188, 182, 170], country: [184, 178, 160] };
  x.lineCap = "round"; x.lineJoin = "round";
  for (const pass of [0, 1]) for (const st of streets) { x.strokeStyle = pass ? rgb(SC[st.kind]) : "rgba(110,106,98,0.35)"; x.lineWidth = st.w * (pass ? 0.8 : 1.15); x.beginPath(); x.moveTo(st.pts[0][0], st.pts[0][1]); for (const p of st.pts) x.lineTo(p[0], p[1]); x.stroke(); }
  x.fillStyle = "rgb(184,176,160)"; poly(rectPts(SQ.x, SQ.z, SQ.hx, SQ.hz, SQ.rot)); x.fill(); // market square
  // railway: ballast, fans, yard tracks, sidings
  {
    const line = (P, w, col) => { x.strokeStyle = col; x.lineWidth = w; x.beginPath(); x.moveTo(P[0][0], P[0][1]); for (const p of P) x.lineTo(p[0], p[1]); x.stroke(); };
    line(railPts, 0.3, "rgb(124,118,108)"); for (const o of [-0.07, 0.07]) line(railPts.map(([a, b]) => [a + o, b]), 0.035, "rgb(70,66,62)");
    x.fillStyle = "rgb(112,106,98)"; poly(rectPts(-0.05, 0, 1.45, 7.4, 0)); x.fill(); // yard bed
    const trackX = []; for (let tr = 0; tr < 12; tr++) trackX.push((-3.1 + 0.25 + tr * (5.7 / 11)) * KC);
    for (const tx of trackX) {
      line([[tx, -7.3], [tx, 7.3]], 0.04, "rgb(58,54,50)");
      for (const sgn of [-1, 1]) { const P = []; for (let k = 0; k <= 12; k++) { const t = k / 12, z = sgn * (7.3 + t * 3.0); const s = t * t * (3 - 2 * t); P.push([tx + (railX(z) + (tx < -0.6 ? -0.07 : 0.07) - tx) * s, z]); } line(P, 0.035, "rgb(66,62,58)"); }
    }
    line([[1.1, 2.2], [1.8, 1.7], [2.6, 1.55], [6.4, 1.55]], 0.035, "rgb(70,66,60)"); line([[1.1, -4.6], [1.9, -4.9], [6.4, -4.9]], 0.035, "rgb(70,66,60)"); // factory sidings
    for (const w of TL.wagons) { x.fillStyle = rgb(pick([[84, 64, 52], [72, 72, 70], [100, 86, 70]])); poly(rectPts(w[0], w[1], w[2] * 0.9, w[3] * 0.94, w[4])); x.fill(); }
    if (TS.turntable) { x.fillStyle = "rgb(84,80,74)"; x.beginPath(); x.arc(TS.turntable[0], TS.turntable[1], 0.33, 0, 7); x.fill(); }
  }
  // ground shadows: drawn opaque into their own layer, then laid on ONCE at 38 % so overlapping shadows in the dense core do not stack to black
  const shL = document.createElement("canvas"); shL.width = shL.height = bake.width; const L = shL.getContext("2d");
  L.setTransform(kpx, 0, 0, kpx, (BH - B[0]) * kpx, (BH - B[1]) * kpx);
  const polyL = (P) => { L.beginPath(); L.moveTo(P[0][0], P[0][1]); for (let i = 1; i < P.length; i++) L.lineTo(P[i][0], P[i][1]); L.closePath(); };
  L.fillStyle = "rgb(34,36,40)";
  for (const h of H) { polyL(shadowOf(rectPts(h.x, h.z, h.len / 2, h.span / 2, h.rot), h.h + h.rh * 0.55)); L.fill(); }
  for (const b of bigRects) { polyL(shadowOf(rectPts(b[0], b[1], b[2], b[3], b[4]), b[5])); L.fill(); }
  for (const [sx, sz, sh] of TS.stacks) { polyL(shadowOf(rectPts(sx, sz, 0.05, 0.05, 0), sh)); L.fill(); }
  for (const t of T) { L.beginPath(); L.ellipse(t[0] + shX * t[2] * 1.4, t[1] + shZ * t[2] * 1.4, t[2] * 1.1, t[2] * 0.9, Math.atan2(shZ, shX), 0, 7); L.fill(); }
  // church + square, airfield hangars and parked aircraft (their shadows first)
  const churchTowerH = 0.95, spireH = 1.55;
  polyL(shadowOf(rectPts(CH.x, CH.z, CH.len / 2, CH.wid / 2, CH.rot), 0.42)); L.fill();
  { const tx = CH.x - Math.cos(CH.rot) * (CH.len / 2 + 0.06), tz = CH.z + Math.sin(CH.rot) * (CH.len / 2 + 0.06); polyL(shadowOf(rectPts(tx, tz, 0.08, 0.08, CH.rot), churchTowerH + spireH * 0.7)); L.fill(); CH.tx = tx; CH.tz = tz; }
  for (const p of PUB) { polyL(shadowOf(rectPts(p[0], p[1], p[2], p[3], p[4]), p[5] + p[3] * 0.6)); L.fill(); }
  for (const hg of AFX.hangars) { polyL(shadowOf(rectPts(hg[0], hg[1], hg[2], hg[3], hg[4]), 0.3)); L.fill(); }
  x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 0.38; x.drawImage(shL, 0, 0); x.restore();
  // roofs: two pitches each (lit / shaded by the fixed town sun) + ridge
  const roofHalf = (h, sgn) => { // sgn −1: half toward local −z
    const c = Math.cos(h.rot), s = Math.sin(h.rot), Zx = s, Zz = c;
    const ny = h.span / 2, nh = h.rh, L = Math.hypot(ny, nh); const nx = sgn * nh * Zx / L, nz = sgn * nh * Zz / L;
    const sh = shadeOf(nx, ny / L, nz);
    const e = h.span / 2 + 0.012, l = h.len / 2 + 0.006;
    const P = [[-l, 0], [l, 0], [l, sgn * e], [-l, sgn * e]].map(([a, b]) => [h.x + c * a + Zx * b, h.z - s * a + Zz * b]);
    return [P, sh];
  };
  for (const h of H) {
    for (const sgn of [-1, 1]) { const [P, sh] = roofHalf(h, sgn); x.fillStyle = rgb(mul(h.roof, sh)); poly(P); x.fill(); }
  }
  for (const b of bigRects) {
    const sh = shadeOf(0, 1, 0);
    x.fillStyle = rgb(mul(b[6], sh * 1.05)); poly(rectPts(b[0], b[1], b[2], b[3], b[4])); x.fill();
    if (b[7] === "saw") { const c = Math.cos(b[4]), s = Math.sin(b[4]); for (let k = 0; k < 7; k++) { const u = -b[2] + (k + 0.82) * (2 * b[2] / 7); x.fillStyle = "rgba(150,152,146,0.85)"; poly(rectPts(b[0] + c * u, b[1] - s * u, 0.035, b[3] * 0.96, b[4])); x.fill(); } }
    if (b[7] === "tank") { x.fillStyle = rgb(mul(b[6], 1.1)); x.beginPath(); x.arc(b[0], b[1], b[2], 0, 7); x.fill(); }
  }
  for (const [sx, sz] of TS.stacks) { x.fillStyle = "rgb(96,72,62)"; x.beginPath(); x.arc(sx, sz, 0.09, 0, 7); x.fill(); x.fillStyle = "rgb(30,26,24)"; x.beginPath(); x.arc(sx, sz, 0.045, 0, 7); x.fill(); }
  { // church: steep slate nave + transept, tower + spire
    const nave = { x: CH.x, z: CH.z, rot: CH.rot, len: CH.len, span: CH.wid, rh: 0.32, roof: [78, 82, 84] };
    for (const sgn of [-1, 1]) { const [P, sh] = roofHalf(nave, sgn); x.fillStyle = rgb(mul(nave.roof, sh)); poly(P); x.fill(); }
    const tr = { x: CH.x + Math.cos(CH.rot) * 0.18, z: CH.z - Math.sin(CH.rot) * 0.18, rot: CH.rot + Math.PI / 2, len: 0.72, span: 0.3, rh: 0.27, roof: [78, 82, 84] };
    for (const sgn of [-1, 1]) { const [P, sh] = roofHalf(tr, sgn); x.fillStyle = rgb(mul(tr.roof, sh)); poly(P); x.fill(); }
    x.fillStyle = "rgb(150,146,138)"; poly(rectPts(CH.tx, CH.tz, 0.115, 0.115, CH.rot)); x.fill();
    x.fillStyle = "rgb(60,66,70)"; poly(rectPts(CH.tx, CH.tz, 0.07, 0.07, CH.rot + 0.785)); x.fill();
    for (const p of PUB) { const b = { x: p[0], z: p[1], rot: p[4], len: p[2] * 2, span: p[3] * 2, rh: p[3] * 1.1, roof: p[6] }; for (const sgn of [-1, 1]) { const [P, sh] = roofHalf(b, sgn); x.fillStyle = rgb(mul(b.roof, sh)); poly(P); x.fill(); } }
  }
  for (const hg of AFX.hangars) { const hh = { x: hg[0], z: hg[1], rot: hg[4], len: hg[2] * 2, span: hg[3] * 2, rh: 0.13, roof: [100, 102, 96] }; for (const sgn of [-1, 1]) { const [P, sh] = roofHalf(hh, sgn); x.fillStyle = rgb(mul(hh.roof, sh)); poly(P); x.fill(); } }
  for (const [px, pz, a, s] of AFX.planes) { x.fillStyle = "rgb(58,62,56)"; poly(rectPts(px, pz, 0.075 * s, 0.014 * s, a)); x.fill(); poly(rectPts(px + Math.cos(a) * 0.02 * s, pz - Math.sin(a) * 0.02 * s, 0.016 * s, 0.09 * s, a)); x.fill(); poly(rectPts(px - Math.cos(a) * 0.065 * s, pz + Math.sin(a) * 0.065 * s, 0.01 * s, 0.035 * s, a)); x.fill(); }
  // trees on top: dark crown + sunlit cap
  for (const t of T) { const c = [52 + t[3] * 18, 64 + t[3] * 18, 42 + t[3] * 10]; x.fillStyle = rgb(c); x.beginPath(); x.arc(t[0], t[1], t[2], 0, 7); x.fill(); x.fillStyle = rgb(mul(c, 1.35), 0.8); x.beginPath(); x.arc(t[0] - shX * t[2] * 0.3, t[1] - shZ * t[2] * 0.3, t[2] * 0.55, 0, 7); x.fill(); }
  // soft outer fade into the farmland (noisy, no circle)
  {
    x.setTransform(1, 0, 0, 1, 0, 0);
    const m = document.createElement("canvas"); m.width = m.height = 512; const mx = m.getContext("2d");
    const k = 512 / (2 * BH), toM = (vx, vz) => [(vx - B[0] + BH) * k, (vz - B[1] + BH) * k];
    const [cx, cz] = toM(B[0], B[1]);
    const g = mx.createRadialGradient(cx, cz, 25 * k, cx, cz, 33 * k); g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(1, "rgba(255,255,255,0)");
    mx.fillStyle = g; mx.fillRect(0, 0, 512, 512);
    mx.globalCompositeOperation = "destination-out";
    for (let i = 0; i < 70; i++) { const a = R() * 6.283, r = RR(22, 32), [px, pz] = toM(B[0] + Math.cos(a) * r, B[1] + Math.sin(a) * r); const gg = mx.createRadialGradient(px, pz, 0, px, pz, RR(2, 5) * k); gg.addColorStop(0, "rgba(0,0,0,0.75)"); gg.addColorStop(1, "rgba(0,0,0,0)"); mx.fillStyle = gg; mx.fillRect(px - 6 * k, pz - 6 * k, 12 * k, 12 * k); }
    mx.globalCompositeOperation = "source-over";
    // keep the town + airfield fully opaque
    for (const h of H) { if (rOf(h.x, h.z) > subR(thOf(h.x, h.z)) + 1.5) continue; const [px, pz] = toM(h.x, h.z); mx.fillStyle = "#fff"; mx.beginPath(); mx.arc(px, pz, 1.2 * k, 0, 7); mx.fill(); }
    { const [px, pz] = toM(AF.x, AF.z); mx.beginPath(); mx.ellipse(px, pz, (AF.rx + 1.2) * k, (AF.rz + 1.2) * k, -AF.rot, 0, 7); mx.fill(); }
    x.globalCompositeOperation = "destination-in"; x.imageSmoothingEnabled = true; x.drawImage(m, 0, 0, N, N); x.globalCompositeOperation = "source-over";
  }
  const bakeTex = new THREE.CanvasTexture(bake); bakeTex.colorSpace = THREE.SRGBColorSpace; bakeTex.anisotropy = 8;
  bakeTex.premultiplyAlpha = true; // filtered edges fade to the farmland instead of to black
  bakeTex.wrapS = bakeTex.wrapT = THREE.ClampToEdgeWrapping; bakeTex.generateMipmaps = true; bakeTex.minFilter = THREE.LinearMipmapLinearFilter;

  // ---------------------------------------------------------------- 3D: houses (walls + roofs instanced)
  const NH = H.length;
  const wallG = new THREE.BoxGeometry(1, 1.06, 1); wallG.translate(0, 0.47, 0); // dips 6 % below the ground
  const roofG = (() => { // gable prism, ridge along local x, base y=0, apex y=1; slight eave + verge overhang
    const e = 0.56, l = 0.52, v = [];
    const A = [-l, 0, -e], Bq = [l, 0, -e], Cq = [l, 1, 0], D = [-l, 1, 0], E = [-l, 0, e], F = [l, 0, e];
    const tri = (...p) => p.forEach((q) => v.push(...q));
    tri(A, Cq, Bq); tri(A, D, Cq); tri(E, F, Cq); tri(E, Cq, D); tri(A, E, D); tri(Bq, Cq, F);
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3)); g.computeVertexNormals(); return g;
  })();
  const walls = new THREE.InstancedMesh(wallG, shadedMat(0xffffff), NH);
  const roofs = new THREE.InstancedMesh(roofG, shadedMat(0xffffff, { side: THREE.DoubleSide }), NH);
  {
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
    H.forEach((h, i) => {
      q.setFromAxisAngle(up, h.rot);
      m4.compose(p.set(h.x, 0, h.z), q, s.set(h.len, h.h, h.span)); walls.setMatrixAt(i, m4); TS.houseM.push(m4.clone());
      m4.compose(p.set(h.x, h.h, h.z), q, s.set(h.len, h.rh, h.span)); roofs.setMatrixAt(i, m4); TS.roofM.push(m4.clone());
      col.setRGB(h.wall[0] / 255, h.wall[1] / 255, h.wall[2] / 255, THREE.SRGBColorSpace); walls.setColorAt(i, col); TS.wallC.push(col.clone());
      col.setRGB(h.roof[0] / 255, h.roof[1] / 255, h.roof[2] / 255, THREE.SRGBColorSpace); roofs.setColorAt(i, col);
      TL.houses.push([h.x, h.z, h.len / 2, h.span / 2, h.rot]);
    });
    walls.instanceMatrix.needsUpdate = roofs.instanceMatrix.needsUpdate = true;
    root.add(walls); root.add(roofs); TS.walls = walls; TS.roofs = roofs;
  }
  // trees (one instanced low-poly crown)
  {
    const g = new THREE.IcosahedronGeometry(0.5, 0);
    const trees = new THREE.InstancedMesh(g, shadedMat(0xffffff), T.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
    T.forEach((t, i) => { const r = t[2]; q.setFromAxisAngle(up, t[3] * 6.28); m4.compose(p.set(t[0], r * 1.2, t[1]), q, s.set(r * 2, r * 2.0, r * 2)); trees.setMatrixAt(i, m4); col.setRGB((54 + t[3] * 16) / 255, (68 + t[3] * 16) / 255, (44 + t[3] * 8) / 255, THREE.SRGBColorSpace); trees.setColorAt(i, col); });
    root.add(trees); TS.trees = trees;
  }
  // church, hangars, parked aircraft
  const bigG = new THREE.Group(); root.add(bigG); TS.big = bigG;
  {
    const stoneM = shadedMat(0xb4ac9c), slateM = shadedMat(0x50565a, { side: THREE.DoubleSide });
    const add = (geo, mat, px, py, pz, ry, sx, sy, sz) => { const m = new THREE.Mesh(geo, mat); m.position.set(px, py, pz); m.rotation.y = ry || 0; if (sx) m.scale.set(sx, sy, sz); bigG.add(m); return m; };
    add(new THREE.BoxGeometry(CH.len, 0.36, CH.wid), stoneM, CH.x, 0.18, CH.z, CH.rot);
    add(roofG, slateM, CH.x, 0.36, CH.z, CH.rot, CH.len, 0.32, CH.wid);
    const trx = CH.x + Math.cos(CH.rot) * 0.18, trz = CH.z - Math.sin(CH.rot) * 0.18;
    add(new THREE.BoxGeometry(0.3, 0.3, 0.72), stoneM, trx, 0.15, trz, CH.rot); add(roofG, slateM, trx, 0.3, trz, CH.rot + Math.PI / 2, 0.72, 0.27, 0.3);
    add(new THREE.BoxGeometry(0.23, churchTowerH, 0.23), stoneM, CH.tx, churchTowerH / 2, CH.tz, CH.rot);
    add(new THREE.ConeGeometry(0.15, spireH, 8), slateM, CH.tx, churchTowerH + spireH / 2, CH.tz, CH.rot);
    for (const p of PUB) { add(new THREE.BoxGeometry(p[2] * 2, p[5], p[3] * 2), stoneM, p[0], p[5] / 2, p[1], p[4]); add(roofG, shadedMat((p[6][0] << 16) | (p[6][1] << 8) | p[6][2], { side: THREE.DoubleSide }), p[0], p[5], p[1], p[4], p[2] * 2, p[3] * 1.1, p[3] * 2); }
    const hangW = shadedMat(0x8a8a82), hangR = shadedMat(0x6a6c66, { side: THREE.DoubleSide });
    for (const hg of AFX.hangars) { add(new THREE.BoxGeometry(hg[2] * 2, 0.2, hg[3] * 2), hangW, hg[0], 0.1, hg[1], hg[4]); add(roofG, hangR, hg[0], 0.2, hg[1], hg[4], hg[2] * 2, 0.13, hg[3] * 2); }
    const fus = new THREE.BoxGeometry(0.15, 0.025, 0.026), wing = new THREE.BoxGeometry(0.034, 0.01, 0.18), tail = new THREE.BoxGeometry(0.02, 0.008, 0.07);
    const pm = shadedMat(0x4a5048);
    for (const [px, pz, a, s] of AFX.planes) { const g = new THREE.Group(); g.position.set(px, 0.02, pz); g.rotation.y = a; g.scale.setScalar(s); g.add(new THREE.Mesh(fus, pm)); const w = new THREE.Mesh(wing, pm); w.position.x = 0.02; g.add(w); const t = new THREE.Mesh(tail, pm); t.position.x = -0.065; g.add(t); bigG.add(g); }
  }
  root.traverse((o) => { if (o.isMesh || o.isInstancedMesh) { o.frustumCulled = false; o.visible = o.visible; } });

  // ---------------------------------------------------------------- LOD + per-frame
  const _w = new THREE.Vector3(), _c = new THREE.Vector3();
  let lodState = null;
  function update(camera, groundY) {
    root.updateWorldMatrix(true, false);
    sunU.value.copy(SUN_L).transformDirection(root.matrixWorld);
    _c.set(C[0], 0, C[1]); root.localToWorld(_w.copy(_c));
    const agl = camera.position.y - groundY, dH = Math.hypot(camera.position.x - _w.x, camera.position.z - _w.z);
    const near3D = agl < 3048 && dH < 9000;      // ≤ ~15,000 ft AGL: full 3D town (bake stays underneath as streets / yards / shadows)
    const nearTrees = near3D && agl < 2300;      // ≤ ~11,000 ft
    const s = (near3D ? 1 : 0) + (nearTrees ? 2 : 0);
    if (s !== lodState) { lodState = s; walls.visible = roofs.visible = bigG.visible = CXG.visible = near3D; TS.wagons.visible = near3D; TS.trees.visible = nearTrees; }
    return s;
  }
  function toWorld(u, v) { root.updateWorldMatrix(true, false); const p = root.localToWorld(new THREE.Vector3(u, 0, v)); return { x: p.x, y: p.y, z: p.z, gy: p.y }; }
  const stats = { houses: NH, trees: T.length, streets: streets.length, buildMs: Math.round((typeof performance !== "undefined" ? performance.now() : 0) - t0), bakeN: N, bakeHalf: BH };
  try { console.log("[TOWN3D] " + JSON.stringify(stats)); } catch (e) {}
  return {
    root, TL, TS, bakeTex, stats, update, toWorld,
    bakeCenter: B, bakeHalf: BH, church: [C[0], C[1]], airfield: [AF.x, AF.z],
    resetHouses() { for (let i = 0; i < NH; i++) { walls.setMatrixAt(i, TS.houseM[i]); roofs.setMatrixAt(i, TS.roofM[i]); walls.setColorAt(i, TS.wallC[i]); } walls.instanceMatrix.needsUpdate = roofs.instanceMatrix.needsUpdate = true; if (walls.instanceColor) walls.instanceColor.needsUpdate = true; },
  };
}
