import * as THREE from "three";
import { GLTFLoader } from "./vendor/GLTFLoader.js";

const CAM = { x: 0, y: 10.2, z: 6.5 };
// 1.4.1: capture clock — offline clip harnesses set window.__FG_CAPCLK (ms) so effects run at sim speed
const pnow = () => (window.__FG_CAPCLK != null ? window.__FG_CAPCLK : performance.now());

export function createWorld3D(canvas) {
  function failStub(reason) {
    console.error("[World3D] FAIL:", reason);
    try {
      const ctx2d = canvas.getContext("2d");
      if (ctx2d) {
        const w = canvas.width = window.innerWidth || 800;
        const h = canvas.height = window.innerHeight || 480;
        ctx2d.fillStyle = "#0b121c";
        ctx2d.fillRect(0, 0, w, h);
        ctx2d.fillStyle = "#ffcc66";
        ctx2d.font = "bold 22px monospace";
        ctx2d.fillText("3D/WebGL unavailable", 24, 64);
        ctx2d.fillStyle = "#e8eef4";
        ctx2d.font = "16px monospace";
        const msg = String(reason || "unknown");
        const lines = [];
        let line = "";
        for (const ch of msg) {
          line += ch;
          if (line.length > 48) { lines.push(line); line = ""; }
        }
        if (line) lines.push(line);
        lines.forEach((ln, i) => ctx2d.fillText(ln, 24, 100 + i * 22));
        ctx2d.fillText("Showing 2D fallback — screenshot this.", 24, 140 + lines.length * 22);
      }
    } catch (_) {}
    const noop = () => {};
    return {
      ready: false,
      modelsReady: false,
      failReason: String(reason || "unknown"),
      resize: noop,
      sync: noop,
      render: noop,
      applySkyTexture: noop,
      loading: Promise.resolve(),
      renderer: null,
      scene: null,
      camera: null,
    };
  }

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    const gl = renderer.getContext();
    if (!gl) return failStub("WebGL context null");
  } catch (e) {
    return failStub((e && e.message) || String(e));
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12; // 1.5.1: crisper, more saturated

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / Math.max(1, window.innerHeight),
    0.05,
    70000
  );
  scene.add(camera);

  // Lighting — sun + strong backlight rim so fighters don't dissolve into clouds
  // 1.3.2: one real sun (high, starboard-forward) + sky/ground hemisphere bounce + weak sky fill.
  // Planes get a lit top / shadowed belly instead of the old flat camera-attached floodlights.
  const hemi = new THREE.HemisphereLight(0xc4d4e6, 0x4a4434, 0.75);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1dc, 3.0);
  sun.position.set(45, 90, 30);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x8aa6cc, 0.35);
  fill.position.set(-60, 20, -50);
  scene.add(fill);
  const key2 = new THREE.DirectionalLight(0xffd8a8, 0.0);
  key2.position.set(30, 50, -20);
  scene.fog = new THREE.Fog(0x7fa9da, 3500, 52000); // 1.5.1: no milky air — a faint blue aerial perspective only

  // 1.3.6: procedural high-altitude sky — deep blue zenith, paler band, milky haze at the horizon,
  // hard sun with a tight glow. Rotates with the box's heading (the sun stays put in the world).
  const SKY_HORIZON = new THREE.Color(0x7fa9da);
  const sunDir0 = new THREE.Vector3(45, 90, 30).normalize();
  const skyU = { uSun: { value: sunDir0.clone() } };
  const skyMat = new THREE.ShaderMaterial({
    uniforms: skyU, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    vertexShader: "varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `uniform vec3 uSun; varying vec3 vDir;
      void main(){
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 zen = vec3(0.006, 0.05, 0.30), mid = vec3(0.03, 0.17, 0.56), hor = vec3(0.20, 0.42, 0.74), low = vec3(0.16, 0.34, 0.62); // 1.5.1 crisp deep blue
        vec3 c = mix(hor, mid, smoothstep(0.0, 0.12, h));
        c = mix(c, zen, smoothstep(0.18, 0.9, h));
        c = mix(c, low, smoothstep(0.0, -0.08, h));
        float sd = max(dot(d, uSun), 0.0);
        c += vec3(1.0, 0.93, 0.8) * (pow(sd, 6.0) * 0.12 + pow(sd, 90.0) * 0.35);
        c += vec3(1.6, 1.5, 1.35) * smoothstep(0.99955, 0.99975, sd) * 6.0;
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(2600, 48, 24), skyMat);
  skyMesh.frustumCulled = false;
  skyMesh.renderOrder = -10;
  scene.add(skyMesh);

  // Horizon gradient band — matches pale sky, hides equirect nadir/seam
  const hzC = document.createElement("canvas");
  hzC.width = 4; hzC.height = 128;
  const hzX = hzC.getContext("2d");
  const hzG = hzX.createLinearGradient(0, 0, 0, 128);
  hzG.addColorStop(0, "rgba(196,212,222,0)");
  hzG.addColorStop(0.50, "rgba(196,212,222,0.08)");
  hzG.addColorStop(0.78, "rgba(200,214,222,0.28)");
  hzG.addColorStop(1, "rgba(186,200,210,0.48)");
  hzX.fillStyle = hzG;
  hzX.fillRect(0, 0, 4, 128);
  const hzTex = new THREE.CanvasTexture(hzC);
  hzTex.colorSpace = THREE.SRGBColorSpace;
  const haze = new THREE.Mesh(
    new THREE.CylinderGeometry(900, 900, 280, 48, 1, true),
    new THREE.MeshBasicMaterial({
      map: hzTex, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
    })
  );
  haze.position.y = -40;
  haze.visible = false;
  scene.add(haze);

  // Turret (camera-locked) — 1.3.1: guns sit low in frame, never cover upper/center sky
  // 1.4.0: guns rebuilt from the real top-turret photos — the twin .50s sit either side of the gunner's head, near
  // eye height; the jackets frame the view left and right at mid height, receivers beside/behind the eye (out of view).
  const GUN_INSET = -0.43;  // push each gun OUT to x ≈ ±0.73 (1.3.9 pulled them in by +0.085)
  const GUN_Y = -0.08;      // bore at y ≈ −0.03 in camera space (1.3.9: −0.35, well below centre)
  const GUN_Z = -0.05;      // whole mount 1.0u further back → receivers beside the head, only the jackets in view
  const OVL = 1;            // 1.4.0: render layer for the turret (guns, sill, dome frame) — drawn in its own pass on top
  const turretAnchor = new THREE.Group();
  turretAnchor.position.set(0, -0.08, -0.02);
  camera.add(turretAnchor);
  // Cycle 136: darker interior base; muzzle strobe floods orange
  const turretFill = new THREE.PointLight(0xffe8c8, 0.55, 5, 1.4);
  turretFill.position.set(0, 0.35, 0.4);
  camera.add(turretFill);
  const muzzleStrobe = new THREE.PointLight(0xff8a30, 0, 3.5, 2);
  muzzleStrobe.position.set(0, -0.2, -0.6);
  camera.add(muzzleStrobe);
  const turretKey = new THREE.DirectionalLight(0xfff6e8, 0.45);
  turretKey.position.set(0.6, 1.6, 0.4);
  camera.add(turretKey);
  const gunSpec = new THREE.DirectionalLight(0xe8f0ff, 0.55);
  gunSpec.position.set(-0.8, 0.9, 0.6);
  camera.add(gunSpec);
  // Backlight rim parented to camera — rims anything in front of the sight
  const viewRim = new THREE.DirectionalLight(0xffe8c0, 0.3);
  viewRim.position.set(-0.35, 0.55, 1.2);
  camera.add(viewRim);
  const viewRimT = new THREE.Object3D();
  viewRimT.position.set(0, 0, -20);
  camera.add(viewRimT);
  viewRim.target = viewRimT;
  const viewRim2 = new THREE.DirectionalLight(0xb8d0e8, 0.15);
  viewRim2.position.set(0.5, -0.2, 1.0);
  camera.add(viewRim2);
  const viewRim2T = new THREE.Object3D();
  viewRim2T.position.set(0, 0, -20);
  camera.add(viewRim2T);
  viewRim2.target = viewRim2T;

  // Fighter pool
  const fighterPool = [];
  const prototypes = { "109": null, "190": null, "110": null, "p51": null };

  function makeTrail() {
    const geo = new THREE.BufferGeometry();
    const n = 22;
    const pos = new Float32Array(n * 3);
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({
      color: 0xf2f5f8,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      fog: true,
    });
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    line.visible = false;
    scene.add(line);
    return { line, pos, n };
  }

  // ===== 1.3.1: opaque low-poly B-17 combat box + engine fire/smoke + farmland/clouds/target =====
  function radialTex(inner, outer, size) {
    const c = document.createElement("canvas");
    c.width = c.height = size || 64;
    const x = c.getContext("2d");
    const h = c.width / 2;
    const g = x.createRadialGradient(h, h, 0, h, h, h);
    g.addColorStop(0, inner);
    g.addColorStop(1, outer);
    x.fillStyle = g;
    x.fillRect(0, 0, c.width, c.height);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  const fireTex = radialTex("rgba(255,236,170,1)", "rgba(255,90,10,0)");
  // 1.3.3: licking flame (teardrop, hot core) for engine fires
  const flameTex = (() => {
    const c = document.createElement("canvas"); c.width = 64; c.height = 128;
    const x = c.getContext("2d");
    for (let k = 0; k < 3; k++) {
      const g = x.createRadialGradient(32, 92 - k * 14, 2, 32, 86 - k * 14, 30 - k * 6);
      g.addColorStop(0, k === 2 ? "rgba(255,250,220,0.95)" : "rgba(255,200,90,0.8)");
      g.addColorStop(0.5, "rgba(255,120,20,0.55)");
      g.addColorStop(1, "rgba(200,40,0,0)");
      x.fillStyle = g;
      x.beginPath(); x.ellipse(32, 80 - k * 10, 26 - k * 7, 46 - k * 8, 0, 0, Math.PI * 2); x.fill();
    }
    const tx = new THREE.CanvasTexture(c); tx.colorSpace = THREE.SRGBColorSpace; return tx;
  })();
  const smokeTex = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const x = c.getContext("2d");
    // 1.6.1: softer, more irregular puff (no hard disc edge when seen from above)
    for (let i = 0; i < 5; i++) {
      const cx = 64 + (i - 2) * 8, cy = 64 + ((i % 3) - 1) * 6, rr = 48 - i * 4;
      const g = x.createRadialGradient(cx, cy, 2, cx, cy, rr);
      g.addColorStop(0, "rgba(255,255,255," + (0.55 - i * 0.06) + ")");
      g.addColorStop(0.45, "rgba(255,255,255," + (0.28 - i * 0.03) + ")");
      g.addColorStop(1, "rgba(255,255,255,0)");
      x.fillStyle = g; x.fillRect(0, 0, 128, 128);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();

  // B-17 dims in world units (1u = 100 ft) × visual scale so the box reads on a phone.
  const B17_VIS = 16;               // 1.3.3: 103 ft span → 16u (closer to own-ship scale)
  const NACELLE_X = [-0.35, -0.19, 0.19, 0.35]; // fraction of half-span*2 → engine #1..#4 (port→stbd)
  // 1.3.6: weathered, sun-faded olive drab (mottled, chalky patches, panel seams) with a little sheen
  const weatherTex = (() => {
    const c = document.createElement("canvas"); c.width = c.height = 256;
    const x = c.getContext("2d");
    x.fillStyle = "#c8c8c8"; x.fillRect(0, 0, 256, 256);
    let sd = 5; const r = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
    for (let i = 0; i < 90; i++) { const g = x.createRadialGradient(0, 0, 0, 0, 0, 1); const v = r() < 0.5 ? "235,232,215" : "150,150,140"; g.addColorStop(0, "rgba(" + v + ",0.35)"); g.addColorStop(1, "rgba(" + v + ",0)"); x.save(); x.translate(r() * 256, r() * 256); x.scale(10 + r() * 40, 6 + r() * 20); x.fillStyle = g; x.beginPath(); x.arc(0, 0, 1, 0, 6.3); x.fill(); x.restore(); }
    x.strokeStyle = "rgba(60,60,55,0.35)"; x.lineWidth = 1;
    for (let y = 0; y < 256; y += 32) { x.beginPath(); x.moveTo(0, y + 0.5); x.lineTo(256, y + 0.5); x.stroke(); }
    for (let k = 0; k < 24; k++) { const xx = (r() * 256) | 0, yy = ((r() * 8) | 0) * 32; x.beginPath(); x.moveTo(xx + 0.5, yy); x.lineTo(xx + 0.5, yy + 32); x.stroke(); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; return t;
  })();
  const stainTex = (() => { // sooty exhaust streak, dense at the cowl, fading aft
    const c = document.createElement("canvas"); c.width = 32; c.height = 128;
    const x = c.getContext("2d"); const img = x.createImageData(32, 128);
    for (let v = 0; v < 128; v++) for (let u = 0; u < 32; u++) {
      const w = (u - 15.5) / 15.5, t = v / 127, o = (v * 32 + u) * 4;
      img.data[o] = 22; img.data[o + 1] = 20; img.data[o + 2] = 18;
      img.data[o + 3] = 255 * 0.8 * Math.exp(-w * w * 3) * (1 - t) * (0.75 + 0.25 * Math.sin(u * 1.7 + v * 0.05));
    }
    x.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const stainMat = new THREE.MeshBasicMaterial({ map: stainTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, fog: true });
  const b17OD = new THREE.MeshStandardMaterial({ color: 0x4d5534, map: weatherTex, roughness: 0.52, metalness: 0.18, envMapIntensity: 0.45 });
  const b17Dark = new THREE.MeshStandardMaterial({ color: 0x23271a, roughness: 0.7, metalness: 0.2 });
  const b17Glass = new THREE.MeshStandardMaterial({ color: 0x33485a, roughness: 0.25, metalness: 0.3 });
  const b17Star = new THREE.MeshBasicMaterial({ color: 0xd8d8d0 });

  const b17Metal = new THREE.MeshStandardMaterial({ color: 0xa4aab0, map: weatherTex, roughness: 0.3, metalness: 0.82, envMapIntensity: 1.0 });
  // 1.3.3: spinning-prop blur disc (translucent grey, darker blade arcs, yellow tip ring)
  const propTex = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const x = c.getContext("2d");
    x.translate(64, 64);
    const g = x.createRadialGradient(0, 0, 6, 0, 0, 62);
    g.addColorStop(0, "rgba(40,40,40,0.35)");
    g.addColorStop(0.5, "rgba(70,70,70,0.16)");
    g.addColorStop(0.92, "rgba(80,80,80,0.12)");
    g.addColorStop(1, "rgba(80,80,80,0)");
    x.fillStyle = g;
    x.beginPath(); x.arc(0, 0, 62, 0, Math.PI * 2); x.fill();
    for (let k = 0; k < 3; k++) { // motion-blurred blades
      const a0 = (k / 3) * Math.PI * 2;
      for (let s = 0; s < 10; s++) {
        x.fillStyle = "rgba(20,20,20," + (0.05 * (1 - s / 10)).toFixed(3) + ")";
        x.beginPath(); x.moveTo(0, 0); x.arc(0, 0, 60, a0 - s * 0.07, a0 - s * 0.07 + 0.12); x.closePath(); x.fill();
      }
    }
    x.strokeStyle = "rgba(230,190,40,0.16)"; x.lineWidth = 2;
    x.beginPath(); x.arc(0, 0, 58, 0, Math.PI * 2); x.stroke();
    const tx = new THREE.CanvasTexture(c);
    tx.colorSpace = THREE.SRGBColorSpace;
    return tx;
  })();
  const propDiscMat = new THREE.MeshBasicMaterial({ map: propTex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const propBladeMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.7, metalness: 0.3 });
  function makeBlades(R, w) {
    const grp = new THREE.Group();
    const bg = new THREE.BoxGeometry(w, R * 0.93, w * 0.22);
    bg.translate(0, R * 0.5, 0);
    for (let k = 0; k < 3; k++) {
      const piv = new THREE.Group();
      piv.rotation.z = (k / 3) * Math.PI * 2;
      const b = new THREE.Mesh(bg, propBladeMat);
      b.rotation.y = 1.35; // feathered (edge-on to the airflow)
      piv.add(b);
      grp.add(piv);
    }
    const hub = new THREE.Mesh(new THREE.SphereGeometry(w * 0.7, 8, 6), propBladeMat);
    grp.add(hub);
    grp.visible = false;
    return grp;
  }
  let _b17n = 0;
  // ===== 1.4.1: the box's Fortresses are individual aeroplanes, not 18 identical toys =====
  // Lathed fuselage with a real taper, tapered wings with rounded tips + dihedral, framed cockpit, chin/top/ball
  // turrets, waist windows, tail-gun position, cowl rings. Every ship gets its own weathering texture, paint shade
  // (fresh / faded / chalky / greener), tail markings (group letter in a triangle or square + serial) and fuselage
  // codes; four are bare metal with an olive anti-glare panel. Haze thickens with distance (per-ship), and each
  // ship wobbles and bobs on its own rhythm (game.js moves the slot, world3d adds a little yaw/pitch shimmer).
  const B17_SHADES = [0x4d5534, 0x585a3b, 0x48553a, 0x5d6147, 0x434b31, 0x535838];
  const B17_METAL = new Set([3, 12]); // 1.5.3: AI ships — 2 of 18 (11 %) are bare natural-metal replacements (light, low-metalness silver like the P-51); the player's ship is uniform olive drab
  const B17_PATCH = { 5: "tail", 9: "wing", 14: "tail" }; // 1.5.3: 3 olive-drab ships fly a replaced tail / a lighter wing panel (deterministic per ship)
  const B17_TAIL = Array.from({ length: 18 }, () => ["sq", "D"]); // 1.5.6: every ship wears the 100th Bomb Group "Square D" on the fin (white square, black D)
  const B17_ACL = "EXTAKRMBHNPCLGDFJS"; // aircraft letters (yellow, under the serial on the fin / right of the roundel)
  const B17_SQN = ["XR", "LN", "XR", "EP", "LD", "XR", "MW", "LN", "XR", "EP", "XR", "LD", "MW", "XR", "LN", "EP", "XR", "LD"]; // 351st / 349th / 351st / 418th ... squadron codes of the 100th BG
  const B17_CODES = B17_SQN.map((q, i) => q + "-" + "EXTAKRMBHNPCLGDFJS"[i]);
  function b17Weather(k, metal) {
    const c = document.createElement("canvas"); c.width = c.height = 256; const x = c.getContext("2d");
    let sd = 101 + k * 7919; const r = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
    x.fillStyle = "#c8c8c8"; x.fillRect(0, 0, 256, 256);
    const chalk = r(), grime = r();
    for (let i = 0; i < 70 + ((r() * 60) | 0); i++) { const g = x.createRadialGradient(0, 0, 0, 0, 0, 1); const v = r() < 0.35 + chalk * 0.4 ? "240,236,220" : (metal ? "120,122,125" : "140,138,125"); g.addColorStop(0, "rgba(" + v + "," + (0.2 + chalk * 0.3).toFixed(2) + ")"); g.addColorStop(1, "rgba(" + v + ",0)"); x.save(); x.translate(r() * 256, r() * 256); x.scale(10 + r() * 50, 5 + r() * 22); x.fillStyle = g; x.beginPath(); x.arc(0, 0, 1, 0, 6.3); x.fill(); x.restore(); }
    for (let i = 0; i < 18 + grime * 40; i++) { x.fillStyle = "rgba(40,36,30," + (0.05 + grime * 0.12).toFixed(2) + ")"; x.fillRect(r() * 256, r() * 256, 20 + r() * 70, 1 + r() * 3); } // oil / exhaust grime smeared aft
    if (metal) for (let i = 0; i < 40; i++) { x.fillStyle = "rgba(255,255,255," + (0.04 + r() * 0.08).toFixed(2) + ")"; x.fillRect(((r() * 8) | 0) * 32, ((r() * 8) | 0) * 32, 32, 32); } // panel-to-panel sheen differences
    x.strokeStyle = "rgba(55,55,50," + (0.25 + r() * 0.2).toFixed(2) + ")"; x.lineWidth = 1;
    for (let y = 0; y < 256; y += 32) { x.beginPath(); x.moveTo(0, y + 0.5); x.lineTo(256, y + 0.5); x.stroke(); }
    for (let q = 0; q < 24; q++) { const xx = (r() * 256) | 0, yy = ((r() * 8) | 0) * 32; x.beginPath(); x.moveTo(xx + 0.5, yy); x.lineTo(xx + 0.5, yy + 32); x.stroke(); }
    if (!metal && r() < 0.5) for (let i = 0; i < 6; i++) { x.fillStyle = "rgba(95,100,70,0.35)"; x.fillRect(r() * 256, r() * 256, 20 + r() * 40, 14 + r() * 30); } // replacement panels in fresher paint
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; return t;
  }
  function b17TailTex(k, metal) {
    const c = document.createElement("canvas"); c.width = 128; c.height = 160; const x = c.getContext("2d");
    const [shape, letter] = B17_TAIL[k % B17_TAIL.length];
    const ink = metal ? "#16181a" : "#e8e4d6", fg = metal ? "#d8dcde" : "#15171a";
    x.fillStyle = ink; x.beginPath();
    if (shape === "tri") { x.moveTo(64, 8); x.lineTo(118, 96); x.lineTo(10, 96); } else x.rect(20, 14, 88, 82);
    x.closePath(); x.fill();
    x.fillStyle = fg; x.font = "bold 58px sans-serif"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(letter, 64, shape === "tri" ? 66 : 57);
    const serial = String(230088 + k * 137 - (k ? 0 : 0)); // 1.5.6: 2-30088 style serial, yellow (black on bare metal)
    x.fillStyle = metal ? "#15171a" : "#e7c43a"; x.font = "bold 21px monospace"; x.fillText(serial, 64, 126);
    x.font = "bold 24px sans-serif"; x.fillText(B17_ACL[k % B17_ACL.length], 64, 146);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
  }
  function b17CodeTex(k, metal) {
    const c = document.createElement("canvas"); c.width = 256; c.height = 64; const x = c.getContext("2d");
    const code = B17_CODES[k % B17_CODES.length];
    x.fillStyle = metal ? "#15171a" : "#b7b8ae"; x.font = "bold 44px sans-serif"; x.textBaseline = "middle";
    x.fillText(code.slice(0, 2), 8, 34); x.fillText(code.slice(3), 214, 34);
    x.fillStyle = metal ? "#1f2f5e" : "#2a3552"; x.beginPath(); x.arc(150, 32, 24, 0, Math.PI * 2); x.fill();
    x.fillStyle = "#e8e6dc"; x.beginPath(); for (let q = 0; q < 10; q++) { const rr = q % 2 ? 9 : 22, a = -Math.PI / 2 + q * Math.PI / 5; x.lineTo(150 + Math.cos(a) * rr, 32 + Math.sin(a) * rr); } x.closePath(); x.fill();
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
  }

  // ===== 1.5.3 B-17 model detail helpers: merged detail meshes (one draw per material per part), belly-grey tint, nose art =====
  const _mpM = new THREE.Matrix4(), _mpQ = new THREE.Quaternion(), _mpE = new THREE.Euler(), _mpV = new THREE.Vector3(), _mpS = new THREE.Vector3(), _mpN = new THREE.Matrix3(), _mpW = new THREE.Vector3();
  // items: [geometry, x, y, z, rx|Quaternion, ry, rz, sx, sy, sz] → one non-indexed BufferGeometry (position/normal/uv/color)
  function mergeParts(items) {
    const gs = items.map((it) => (it[0].index ? it[0].toNonIndexed() : it[0]));
    let n = 0; for (const g of gs) n += g.attributes.position.count;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2), col = new Float32Array(n * 3).fill(1);
    let o = 0;
    items.forEach((it, i) => {
      const g = gs[i];
      if (it[4] && it[4].isQuaternion) _mpQ.copy(it[4]); else _mpQ.setFromEuler(_mpE.set(it[4] || 0, it[5] || 0, it[6] || 0));
      _mpM.compose(_mpV.set(it[1], it[2], it[3]), _mpQ, _mpS.set(it[7] || 1, it[8] || 1, it[9] || 1)); _mpN.getNormalMatrix(_mpM);
      const P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv, C = g.attributes.color;
      for (let j = 0; j < P.count; j++) {
        _mpW.fromBufferAttribute(P, j).applyMatrix4(_mpM); pos[(o + j) * 3] = _mpW.x; pos[(o + j) * 3 + 1] = _mpW.y; pos[(o + j) * 3 + 2] = _mpW.z;
        _mpW.fromBufferAttribute(N, j).applyMatrix3(_mpN).normalize(); nor[(o + j) * 3] = _mpW.x; nor[(o + j) * 3 + 1] = _mpW.y; nor[(o + j) * 3 + 2] = _mpW.z;
        if (U) { uv[(o + j) * 2] = U.getX(j); uv[(o + j) * 2 + 1] = U.getY(j); }
        if (C) { col[(o + j) * 3] = C.getX(j); col[(o + j) * 3 + 1] = C.getY(j); col[(o + j) * 3 + 2] = C.getZ(j); }
      }
      o += P.count;
    });
    const out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.BufferAttribute(pos, 3)); out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    out.setAttribute("uv", new THREE.BufferAttribute(uv, 2)); out.setAttribute("color", new THREE.BufferAttribute(col, 3));
    for (const g of gs) if (g !== undefined) g.dispose && g.dispose();
    return out;
  }
  // paint: top colour on the upper/side surfaces, neutral-grey belly (vertex colours; material colour is white)
  function tintGeo(geo, top, bot) {
    const N = geo.attributes.normal, n = N.count, c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      let t = (N.getY(i) + 0.7) / 0.45; t = t < 0 ? 0 : t > 1 ? 1 : t; t = t * t * (3 - 2 * t);
      c[i * 3] = bot.r + (top.r - bot.r) * t; c[i * 3 + 1] = bot.g + (top.g - bot.g) * t; c[i * 3 + 2] = bot.b + (top.b - bot.b) * t;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(c, 3)); return geo;
  }
  const B17_ART = { 2: 0, 6: 1, 11: 2, 15: 3 }; // a few ships carry nose art (deterministic per ship)
  const B17_ART_NAMES = ["MISS BEHAVIN'", "TEXAS ROSE", "LUCKY LADY", "SAD SACK"];
  function b17ArtTex(ix) {
    const c = document.createElement("canvas"); c.width = 192; c.height = 96; const x = c.getContext("2d");
    const pal = [["#d9363a", "#f2d6a8"], ["#2f6fb5", "#f4e3b8"], ["#e0b22a", "#f3d9b2"], ["#7a3fa0", "#f1d8b0"]][ix % 4];
    x.lineWidth = 3; x.strokeStyle = "#1b1a16";
    x.fillStyle = pal[0]; x.beginPath(); x.moveTo(30, 90); x.bezierCurveTo(20, 60, 40, 45, 62, 40); x.bezierCurveTo(72, 20, 100, 18, 104, 38); x.bezierCurveTo(116, 52, 112, 76, 96, 92); x.closePath(); x.fill(); x.stroke(); // dress / body
    x.fillStyle = pal[1]; x.beginPath(); x.arc(84, 26, 13, 0, Math.PI * 2); x.fill(); x.stroke(); // head
    x.fillStyle = "#2a1c10"; x.beginPath(); x.arc(80, 20, 14, Math.PI, Math.PI * 2.1); x.fill(); // hair
    x.fillStyle = pal[1]; x.beginPath(); x.moveTo(60, 48); x.quadraticCurveTo(42, 44, 38, 30); x.lineTo(46, 28); x.quadraticCurveTo(52, 38, 66, 40); x.closePath(); x.fill(); x.stroke(); // raised arm
    x.fillStyle = "#f4efdc"; x.font = "italic bold 21px serif"; x.textBaseline = "middle"; x.lineWidth = 4; x.strokeStyle = "#1b1a16"; const nm = B17_ART_NAMES[ix % 4];
    x.strokeText(nm, 112, 68); x.fillText(nm, 112, 68);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
  }
  const b17SeamMat = new THREE.MeshBasicMaterial({ color: 0x14150f, transparent: true, opacity: 0.38, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  const _bgBox = (w, h, d) => new THREE.BoxGeometry(w, h, d), _bgCyl = (r0, r1, h, sg) => new THREE.CylinderGeometry(r0, r1, h, sg || 6);
  let _b17ConeG = null;
  // ===== 1.5.4 B-17 LOFTED FUSELAGE — stations in fractions of the span (z along the nose, hw = half beam, top / bot = crown and keel, n = squareness of the section) =====
  // Source: B-17G side-profile reference (deepest at waist/radio room, cockpit raised above a lower glazed nose, top-turret saddle, belly upsweep to a slim tail).
  const b17HullSecs = [
    { z: -0.414, hw: 0.004, top: 0.0135, bot: 0.0045, n: 2.2 }, { z: -0.404, hw: 0.0085, top: 0.0185, bot: 0.0015, n: 2.2 }, { z: -0.37, hw: 0.0135, top: 0.0235, bot: -0.0055, n: 2.2 },
    { z: -0.32, hw: 0.0195, top: 0.0295, bot: -0.0165, n: 2.3 }, { z: -0.26, hw: 0.0285, top: 0.0365, bot: -0.0245, n: 2.3 }, { z: -0.19, hw: 0.0385, top: 0.0435, bot: -0.0365, n: 2.4 },
    { z: -0.12, hw: 0.0455, top: 0.0485, bot: -0.0485, n: 2.5 }, { z: -0.02, hw: 0.0458, top: 0.0495, bot: -0.0495, n: 2.5 }, { z: 0.07, hw: 0.0445, top: 0.0495, bot: -0.0475, n: 2.4 },
    { z: 0.135, hw: 0.0425, top: 0.0505, bot: -0.0415, n: 2.3 }, { z: 0.17, hw: 0.0405, top: 0.0515, bot: -0.0365, n: 2.2 }, { z: 0.205, hw: 0.0385, top: 0.0535, bot: -0.0335, n: 2.1 },
    { z: 0.24, hw: 0.0355, top: 0.0535, bot: -0.0300, n: 2.1 }, { z: 0.262, hw: 0.0335, top: 0.0505, bot: -0.0275, n: 2.1 },
  ];
  function b17HullAt(z) { // interpolated station (hull) — also continues into the nose glazing for z > 0.262
    const A = z > 0.262 ? b17NoseSecs : b17HullSecs;
    if (z <= A[0].z) return A[0]; if (z >= A[A.length - 1].z) return A[A.length - 1];
    for (let i = 0; i < A.length - 1; i++) { const a = A[i], b = A[i + 1]; if (z <= b.z) { const t = (z - a.z) / (b.z - a.z); return { hw: a.hw + (b.hw - a.hw) * t, top: a.top + (b.top - a.top) * t, bot: a.bot + (b.bot - a.bot) * t, n: a.n + (b.n - a.n) * t }; } }
    return A[A.length - 1];
  }
  const b17NoseSecs = [ // 1.5.6: authored in FINAL (post-transform) units; section 0 is identical to the hull's last section so the loft is continuous (no open step behind the cockpit)
    { z: 0.262, hw: 0.0246, top: 0.0305, bot: -0.0292, n: 2.1 }, { z: 0.280, hw: 0.0244, top: 0.0305, bot: -0.0298, n: 2.0 }, { z: 0.300, hw: 0.0236, top: 0.0290, bot: -0.0275, n: 2.0 },
    { z: 0.318, hw: 0.0212, top: 0.0235, bot: -0.0225, n: 2.0 }, { z: 0.332, hw: 0.0165, top: 0.0185, bot: -0.0170, n: 2.0 }, { z: 0.342, hw: 0.0095, top: 0.0120, bot: -0.0120, n: 2.0 }, { z: 0.348, hw: 0.0030, top: 0.0040, bot: -0.0050, n: 2.0 },
  ];
  // 1.5.5: proportions re-measured from the real B-17F side/plan references (beam ≈ 0.033 S, depth ≈ 0.082 S) — the 1.5.4 hull was ~35% too fat and 20% too deep
  for (const A of [b17HullSecs]) for (const q of A) { const yM = (q.top + q.bot) * 0.5, h = (q.top - q.bot) * 0.5 * 0.84; q.top = yM * 0.92 + h; q.bot = yM * 0.92 - h; q.hw *= 0.735; if (q.z > 0) q.bot -= 0.007 * Math.min(1, q.z / 0.15) * (q.z < 0.3 ? 1 : Math.max(0, (0.348 - q.z) / 0.05)); }
  b17HullSecs[b17HullSecs.length - 1].top = b17NoseSecs[0].top; // 1.5.6: the roof drops in a raked windscreen (roof z 0.24 → nose line z 0.262) instead of ending in an open vertical step
  function b17Loft(secs, N, i0, i1, capEnds) {
    const S = B17_VIS, pos = [], uv = [], idx = [], rows = i1 - i0 + 1;
    for (let r = 0; r < rows; r++) {
      const q = secs[i0 + r], yM = (q.top + q.bot) * 0.5, hH = Math.max(1e-4, (q.top - q.bot) * 0.5);
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a), e = 2 / q.n;
        pos.push(Math.sign(c) * Math.pow(Math.abs(c), e) * q.hw * S, (yM + Math.sign(sn) * Math.pow(Math.abs(sn), e) * hH) * S, q.z * S);
        uv.push(i / N, (q.z + 0.42) / 0.78);
      }
    }
    const W = N + 1;
    for (let r = 0; r < rows - 1; r++) for (let i = 0; i < N; i++) { const a = r * W + i, b = a + 1, c = a + W, d = c + 1; idx.push(a, c, b, b, c, d); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); geo.setIndex(idx);
    if (capEnds) { // close the tail end (the front is closed by the nose glazing)
      const base = pos.length / 3, q = secs[i0], yM = (q.top + q.bot) * 0.5; pos.push(0, yM * S, q.z * S); uv.push(0.5, 0);
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      for (let i = 0; i < N; i++) idx.push(base, i + 1, i); geo.setIndex(idx);
    }
    geo.computeVertexNormals(); return geo;
  }
  let _b17NoseMat = null;
  function b17NoseGlass() { // multi-paned bombardier glazing: pale blue-grey Plexiglas with dark frame bars (texture, one material shared by every ship)
    if (_b17NoseMat) return _b17NoseMat;
    const c = document.createElement("canvas"); c.width = 128; c.height = 64; const x = c.getContext("2d");
    const gr = x.createLinearGradient(0, 0, 0, 64); gr.addColorStop(0, "#9eb3bd"); gr.addColorStop(0.5, "#6f8793"); gr.addColorStop(1, "#4e626c"); x.fillStyle = gr; x.fillRect(0, 0, 128, 64);
    x.fillStyle = "#1f2418"; for (let i = 0; i < 8; i++) x.fillRect(i * 16 - 1, 0, 3, 64); for (const yy of [14, 30, 46]) x.fillRect(0, yy - 1, 128, 3);
    x.fillStyle = "rgba(255,255,255,0.25)"; for (let i = 0; i < 8; i++) x.fillRect(i * 16 + 3, 3, 5, 9);
    const tex = new THREE.CanvasTexture(c); tex.wrapS = THREE.RepeatWrapping; if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    _b17NoseMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.2, metalness: 0.35, envMapIntensity: 0.8 });
    return _b17NoseMat;
  }
  // 1.5.8: copy rows r0..r1 (W vertices per row; the optional tail-cap fan vertex at index rows*W) out of a lofted fuselage into its own geometry
  function b17SliceLoft(src, W, r0, r1, withCap) {
    const P = src.attributes.position, N = src.attributes.normal, U = src.attributes.uv, C = src.attributes.color, rows = r1 - r0 + 1;
    const nv = rows * W + (withCap ? 1 : 0), pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), col = new Float32Array(nv * 3), idx = [];
    const copy = (d, sIdx) => { pos.set([P.getX(sIdx), P.getY(sIdx), P.getZ(sIdx)], d * 3); nor.set([N.getX(sIdx), N.getY(sIdx), N.getZ(sIdx)], d * 3); uv.set([U.getX(sIdx), U.getY(sIdx)], d * 2); col.set([C.getX(sIdx), C.getY(sIdx), C.getZ(sIdx)], d * 3); };
    for (let r = 0; r < rows; r++) for (let i = 0; i < W; i++) copy(r * W + i, (r0 + r) * W + i);
    for (let r = 0; r < rows - 1; r++) for (let i = 0; i < W - 1; i++) { const a = r * W + i, b = a + 1, c = a + W, d = c + 1; idx.push(a, c, b, b, c, d); }
    if (withCap) { const cv = src.attributes.position.count - 1; copy(rows * W, cv); for (let i = 0; i < W - 1; i++) idx.push(rows * W, i + 1, i); }
    const g2 = new THREE.BufferGeometry();
    g2.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g2.setAttribute("normal", new THREE.BufferAttribute(nor, 3)); g2.setAttribute("uv", new THREE.BufferAttribute(uv, 2)); g2.setAttribute("color", new THREE.BufferAttribute(col, 3)); g2.setIndex(idx);
    return g2;
  }
  function buildB17() {
    const S = B17_VIS;
    const g = new THREE.Group();
    const k = _b17n++;
    const metal = B17_METAL.has(k);
    const wt = b17Weather(k, metal);
    const cTop = metal ? new THREE.Color(0xd8d8d2).offsetHSL(0, 0, (((k * 37) % 9) - 4) * 0.008) : new THREE.Color(B17_SHADES[(k * 5) % B17_SHADES.length]);
    const cBot = metal ? cTop.clone().multiplyScalar(0.94) : new THREE.Color(0x8f918c).offsetHSL(0, 0, (((k * 13) % 5) - 2) * 0.01); // olive drab above, neutral grey below
    const skin = metal
      ? new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, map: wt, roughness: 0.5, metalness: 0.12, emissive: 0xb4b4ae, emissiveIntensity: 0.42, envMapIntensity: 0.3 })
      : new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, map: wt, roughness: 0.5 + ((k * 3) % 5) * 0.03, metalness: 0.16, envMapIntensity: 0.42 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x23271a, roughness: 0.7, metalness: 0.2 });
    const glassM = new THREE.MeshStandardMaterial({ color: 0x27333d, roughness: 0.16, metalness: 0.5, envMapIntensity: 0.65 });
    const patchKind = B17_PATCH[k];
    const skinPatch = patchKind ? new THREE.MeshStandardMaterial({ color: 0x8c9078, map: wt, roughness: 0.55, metalness: 0.14, envMapIntensity: 0.4 }) : skin; // lighter olive-grey replacement panels
    const mats = [skin, dark, glassM]; if (patchKind) mats.push(skinPatch);
    g.userData.hazeMats = mats.map((m) => ({ m, col: m.color.clone() }));
    // fuselage (1.5.4): a LOFTED profile — separate top line, belly line and beam per station, not a lathe. Deepest at the waist / radio room, raised cockpit hump,
    // top-turret saddle behind it, long taper with belly upsweep to the tail gunner, and a stepped-down glazed bombardier nose (own mesh + pane texture).
    const hull = b17HullSecs, hullAt = b17HullAt;
    const lg = b17Loft(hull, 16, 0, hull.length - 1, true); tintGeo(lg, cTop, cBot);
    // 1.5.8: the fuselage is cut at the aft waist station (z = -0.19): forward hull + a real tail cone (flagged tailPart, so a tail-off death takes the cone with it, not just the fin and stabilizers).
    // Normals and vertex colours were computed on the whole loft first, so the join has no shading seam.
    const fusF = new THREE.Mesh(b17SliceLoft(lg, 17, 5, hull.length - 1, false), skin), fusT = new THREE.Mesh(b17SliceLoft(lg, 17, 0, 5, true), skin);
    fusT.userData.tailPart = true; g.add(fusF); g.add(fusT);
    { // torn-off ends (hidden until the break): a dark ragged cap on the hull stub and one in the tail cone, so neither piece is a hollow tube
      const wallMat = new THREE.MeshBasicMaterial({ color: 0x1a1612, side: THREE.DoubleSide }); mats.push(wallMat); g.userData.hazeMats.push({ m: wallMat, col: wallMat.color.clone() });
      const q = hull[5], yM = (q.top + q.bot) * 0.5;
      const capG = new THREE.CircleGeometry(1, 14); capG.scale(q.hw * S * 0.97, (q.top - q.bot) * 0.5 * S * 0.97, 1);
      const capF = new THREE.Mesh(capG, wallMat); capF.position.set(0, yM * S, -0.19 * S); capF.rotation.y = Math.PI; capF.visible = false; capF.userData.stubCap = true; g.add(capF);
      const capT = new THREE.Mesh(capG, wallMat); capT.position.set(0, yM * S, -0.19 * S + 0.0005 * S); capT.visible = false; capT.userData.tailPart = true; capT.userData.tailCap = true; g.add(capT);
    }
    const sideX = (z, y, k2) => { const q = hullAt(z), yM = (q.top + q.bot) * 0.5, hH = (q.top - q.bot) * 0.5; const r = Math.min(0.999, Math.abs(y - yM) / hH); return Math.sign(k2 || 1) * q.hw * Math.pow(1 - Math.pow(r, q.n), 1 / q.n); };
    // nose glazing (bombardier) + chin turret, cockpit greenhouse, top turret, ball turret, tail gun, waist windows
    const noseM = b17NoseGlass().clone(); mats.push(noseM); g.userData.hazeMats.push({ m: noseM, col: noseM.color.clone() });
    const nose = new THREE.Mesh(b17Loft(b17NoseSecs, 16, 0, b17NoseSecs.length - 1, false), noseM); g.add(nose);
    // 1.5.6: no chin turret (the B-17F reference has a clear frameless glazed nose; the 1.5.5 dark sphere hung below the hull)
    const cock = new THREE.Mesh(new THREE.BoxGeometry(0.036 * S, 0.012 * S, 0.06 * S), glassM); cock.position.set(0, 0.0435 * S, 0.205 * S); cock.rotation.x = -0.02; g.add(cock);
    const cockF = new THREE.Mesh(new THREE.BoxGeometry(0.036 * S, 0.0022 * S, 0.003 * S), dark); cockF.position.set(0, 0.0495 * S, 0.176 * S); g.add(cockF);
    if (metal) { const ag = new THREE.Mesh(new THREE.BoxGeometry(0.04 * S, 0.004 * S, 0.1 * S), new THREE.MeshStandardMaterial({ color: 0x3f4730, roughness: 0.7, metalness: 0.1 })); ag.position.set(0, 0.0315 * S, 0.292 * S); ag.rotation.x = 0.1; g.add(ag); } // anti-glare panel
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.02 * S, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), glassM); top.position.set(0, hullAt(0.15).top * S - 0.002 * S, 0.15 * S); g.add(top);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.019 * S, 10, 7), dark); ball.position.set(0, -0.037 * S, -0.02 * S); g.add(ball);
    const tailG = new THREE.Mesh(new THREE.BoxGeometry(0.014 * S, 0.016 * S, 0.034 * S), glassM); tailG.position.set(0, 0.007 * S, -0.402 * S); tailG.userData.tailPart = true; g.add(tailG);
    for (const sd of [-1, 1]) for (const wz of [-0.075, -0.13]) { const w = new THREE.Mesh(new THREE.PlaneGeometry(0.04 * S, 0.02 * S), dark); w.position.set(sideX(wz, 0.014 * S / S, sd) * S + sd * 0.0006 * S, 0.014 * S, wz * S); w.rotation.y = sd * Math.PI / 2; g.add(w); }
    // fuselage codes + insignia on both sides
    { const ct = b17CodeTex(k, metal), cm = new THREE.MeshStandardMaterial({ map: ct, transparent: true, alphaTest: 0.1, roughness: 0.6, metalness: metal ? 0.6 : 0.1, polygonOffset: true, polygonOffsetFactor: -2 });
      mats.push(cm); g.userData.hazeMats.push({ m: cm, col: cm.color.clone() });
      for (const sd of [-1, 1]) { const d = new THREE.Mesh(new THREE.PlaneGeometry(0.2 * S, 0.05 * S), cm); d.position.set(sideX(-0.02, 0.004, sd) * S + sd * 0.0007 * S, 0.004 * S, -0.02 * S); d.rotation.y = sd * Math.PI / 2; g.add(d); } }
    // wings: tapered planform with rounded tips, 4.5° dihedral, underside grey
    const wingShape = (() => { const sh = new THREE.Shape(); sh.moveTo(0.02 * S, 0.14 * S); sh.lineTo(0.47 * S, 0.075 * S); sh.quadraticCurveTo(0.51 * S, 0.07 * S, 0.51 * S, 0.04 * S); sh.quadraticCurveTo(0.5 * S, 0.01 * S, 0.47 * S, 0.012 * S); sh.lineTo(0.02 * S, -0.06 * S); sh.closePath(); return sh; })();
    const wg = new THREE.ExtrudeGeometry(wingShape, { depth: 0.016 * S, bevelEnabled: true, bevelThickness: 0.003 * S, bevelSize: 0.003 * S, bevelSegments: 1 });
    wg.rotateX(Math.PI / 2); wg.translate(0, 0.0, 0.0); tintGeo(wg, cTop, cBot); // shape (x, y) → (x, z) ; extrude depth → −y
    for (const side of [-1, 1]) {
      const w = new THREE.Mesh(wg, skin); w.scale.x = side; w.position.set(0, -0.018 * S, 0.0); w.rotation.z = side * 0.075; w.userData.wingSide = side; g.add(w);
      if (patchKind === "wing" && side < 0) { const pp = new THREE.Mesh(new THREE.PlaneGeometry(0.15 * S, 0.1 * S), skinPatch); pp.rotation.x = -Math.PI / 2; pp.position.set(side * 0.27 * S, (-0.015 + 0.27 * 0.075 + 0.0016) * S, 0.03 * S); pp.rotation.z = 0; pp.material = new THREE.MeshStandardMaterial({ color: 0x8c9078, map: wt, roughness: 0.55, metalness: 0.14, envMapIntensity: 0.4, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }); mats.push(pp.material); g.userData.hazeMats.push({ m: pp.material, col: pp.material.color.clone() }); g.add(pp); }
      const star = new THREE.Mesh(new THREE.CircleGeometry(0.028 * S, 10), b17Star); star.rotation.x = -Math.PI / 2; star.position.set(side * 0.38 * S, (-0.015 + 0.38 * 0.075 + 0.0015) * S, 0.05 * S); star.rotation.y = 0; if (side > 0) { star.userData.wingSide = 1; g.add(star); }
    }
    // stabilizers: tapered, rounded tips
    { const sh = new THREE.Shape(); sh.moveTo(0, -0.3 * S); sh.lineTo(0.2 * S, -0.365 * S); sh.quadraticCurveTo(0.225 * S, -0.37 * S, 0.22 * S, -0.39 * S); sh.lineTo(0.02 * S, -0.415 * S); sh.lineTo(0, -0.415 * S); sh.closePath();
      const sg = new THREE.ExtrudeGeometry(sh, { depth: 0.009 * S, bevelEnabled: false }); sg.rotateX(Math.PI / 2); tintGeo(sg, cTop, cBot);
      for (const side of [-1, 1]) { const st = new THREE.Mesh(sg, patchKind === "tail" ? skinPatch : skin); st.scale.x = side; st.position.y = 0.012 * S; st.userData.tailPart = true; g.add(st); } }
    { // 1.5.4 fin: a LONG, low dorsal fillet blending out of the spine (no step), then a swept, tapered fin ~10 ft above the hull and a rounded rudder tip
      const sh = new THREE.Shape();
      sh.moveTo(-0.38 * S, 0.012 * S); sh.lineTo(-0.1 * S, 0.042 * S);
      sh.quadraticCurveTo(-0.2 * S, 0.05 * S, -0.245 * S, 0.082 * S);   // long dorsal fillet rising out of the spine
      sh.quadraticCurveTo(-0.258 * S, 0.112 * S, -0.279 * S, 0.146 * S);  // the fin's swept leading edge steepens
      sh.quadraticCurveTo(-0.289 * S, 0.157 * S, -0.318 * S, 0.1575 * S); sh.quadraticCurveTo(-0.344 * S, 0.158 * S, -0.352 * S, 0.14 * S); // rounded tip
      sh.lineTo(-0.372 * S, 0.05 * S); sh.lineTo(-0.376 * S, 0.012 * S); sh.closePath();
      const fg = new THREE.ExtrudeGeometry(sh, { depth: 0.01 * S, bevelEnabled: false });
      fg.translate(0, 0, -0.005 * S); tintGeo(fg, cTop, cBot);
      const fin = new THREE.Mesh(fg, patchKind === "tail" ? skinPatch : skin); fin.rotation.y = -Math.PI / 2; fin.position.set(0, 0, 0); fin.userData.tailPart = true; g.add(fin);
      const tt = b17TailTex(k, metal), tm = new THREE.MeshStandardMaterial({ map: tt, transparent: true, alphaTest: 0.08, roughness: 0.6, metalness: metal ? 0.5 : 0.1, polygonOffset: true, polygonOffsetFactor: -2 });
      g.userData.hazeMats.push({ m: tm, col: tm.color.clone() });
      for (const sd of [-1, 1]) { const d = new THREE.Mesh(new THREE.PlaneGeometry(0.06 * S, 0.075 * S), tm); d.position.set(sd * 0.0056 * S, 0.1 * S, -0.322 * S); d.rotation.y = sd * Math.PI / 2; d.userData.tailPart = true; g.add(d); }
    }
    // ---- 1.5.3 detail pass (all static detail is merged: one draw per material per part; tail/wing pieces carry the break-off flags) ----
    const MB = { skin: [], dark: [], glass: [] }, MT = { dark: [] }, MW = { "-1": { skin: [], dark: [], seam: [], stain: [] }, "1": { skin: [], dark: [], seam: [], stain: [] } };
    const Z90 = Math.PI / 2;
    { // nose glazing frames, cheek windows, framed cockpit, turret guns, waist guns, hatch
      for (const sd of [-1, 1]) {
        MB.glass.push([_bgBox(0.004 * S, 0.014 * S, 0.026 * S), sideX(0.285, -0.004, sd) * S, -0.004 * S, 0.285 * S, 0, 0, 0]); // cheek gun window
        MB.dark.push([_bgBox(0.003 * S, 0.016 * S, 0.0014 * S), sideX(0.271, -0.004, sd) * S, -0.004 * S, 0.271 * S, 0, 0, 0]); MB.dark.push([_bgBox(0.003 * S, 0.016 * S, 0.0014 * S), sideX(0.299, -0.004, sd) * S, -0.004 * S, 0.299 * S, 0, 0, 0]);
        for (const z of [0.18, 0.192, 0.218, 0.236]) MB.dark.push([_bgBox(0.0018 * S, 0.014 * S, 0.0016 * S), sideX(z, 0.0345, sd) * S, 0.0345 * S, z * S, 0, 0, 0]); // cockpit side-window frames (1.5.6: sit on the lowered roof)
        MB.glass.push([_bgBox(0.0018 * S, 0.011 * S, 0.05 * S), sideX(0.208, 0.0345, sd) * S - sd * 0.0004 * S, 0.0345 * S, 0.208 * S, 0, 0, 0]);
        MB.dark.push([_bgCyl(0.0013 * S, 0.0013 * S, 0.034 * S, 5), sd * 0.0055 * S, hullAt(0.15).top * S + 0.003 * S, 0.172 * S, Z90, 0, 0]); // top-turret twin .50s
        MB.dark.push([_bgCyl(0.0013 * S, 0.0013 * S, 0.028 * S, 5), sd * 0.004 * S, -0.058 * S, -0.04 * S, 0.5, 0, 0]); // ball turret
        MB.dark.push([_bgCyl(0.0016 * S, 0.0016 * S, 0.04 * S, 5), sd * 0.044 * S, 0.012 * S, -0.075 * S, 0, 0, Z90]); // waist gun
        MB.dark.push([_bgBox(0.0035 * S, 0.0012 * S, 0.1 * S), sideX(-0.1, 0.0205, sd) * S, 0.0245 * S, -0.103 * S, 0, 0, 0]); // waist window top rail
      }
      { // 1.5.6 raked windscreen on the roof→nose slope (z 0.24→0.262): glass slab + frame bars, all lying ON the hull surface
        const zr0 = 0.24, zr1 = 0.262, yr0 = hullAt(zr0).top, yr1 = hullAt(zr1).top, slope = Math.atan2(yr0 - yr1, zr1 - zr0), len = Math.hypot(yr0 - yr1, zr1 - zr0), zc = (zr0 + zr1) / 2, yc = (yr0 + yr1) / 2 + 0.0009;
        MB.glass.push([_bgBox(0.026 * S, 0.0016 * S, len * S), 0, yc * S, zc * S, slope, 0, 0]);
        for (const x of [-0.0105, 0, 0.0105]) MB.dark.push([_bgBox(0.0014 * S, 0.0018 * S, len * S), x * S, (yc + 0.0004) * S, zc * S, slope, 0, 0]); // windscreen mullions
        MB.dark.push([_bgBox(0.028 * S, 0.002 * S, 0.0022 * S), 0, (yr0 + 0.0011) * S, zr0 * S, slope, 0, 0]); MB.dark.push([_bgBox(0.026 * S, 0.002 * S, 0.0022 * S), 0, (yr1 + 0.0009) * S, zr1 * S, slope, 0, 0]);
      }
      MB.dark.push([_bgCyl(0.0225 * S, 0.0225 * S, 0.004 * S, 12), 0, hullAt(0.15).top * S - 0.001 * S, 0.15 * S, 0, 0, 0]); // top-turret ring
      MB.glass.push([_bgBox(0.012 * S, 0.003 * S, 0.03 * S), 0, 0.0405 * S, -0.03 * S, 0, 0, 0]); // radio-room hatch
    }
    MT.dark.push([_bgCyl(0.0013 * S, 0.0013 * S, 0.03 * S, 5), 0.0035 * S, 0.0045 * S, -0.43 * S, Z90, 0, 0]); MT.dark.push([_bgCyl(0.0013 * S, 0.0013 * S, 0.03 * S, 5), -0.0035 * S, 0.0045 * S, -0.43 * S, Z90, 0, 0]); // tail guns
    for (const sd of [-1, 1]) { MT.dark.push([_bgBox(0.0014 * S, 0.1 * S, 0.0026 * S), sd * 0.0062 * S, 0.095 * S, -0.34 * S, 0, 0, 0]); MT.dark.push([_bgBox(0.2 * S, 0.0012 * S, 0.0022 * S), sd * 0.11 * S, 0.0135 * S, -0.388 * S, 0, 0, 0]); } // rudder hinge, elevator hinge
    { // wing panel lines: ribs + flap/aileron hinge lines (thin dark strips just proud of the upper skin)
      const LE = (x) => 0.14 - 0.065 * (x - 0.02) / 0.45, TE = (x) => -0.06 + 0.072 * (x - 0.02) / 0.45, wy = (x) => (-0.0155 + x * 0.075 + 0.0018) * S;
      const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), ZA = new THREE.Vector3(0, 0, 1), YA = new THREE.Vector3(0, 1, 0);
      const seg = (sd, x0, z0, x1, z1) => { const dx = sd * (x1 - x0), dz = z1 - z0, L = Math.hypot(dx, dz), a = Math.atan2(dz, dx); qa.setFromAxisAngle(YA, -a); qb.setFromAxisAngle(ZA, sd * 0.075); qb.multiply(qa);
        MW[sd].seam.push([_bgBox(L * S, 0.0011 * S, 0.0022 * S), sd * (x0 + x1) / 2 * S, wy((x0 + x1) / 2), (z0 + z1) / 2 * S, qb.clone()]); };
      for (const sd of [-1, 1]) {
        for (const x of [0.1, 0.19, 0.28, 0.37, 0.44]) seg(sd, x, TE(x) + 0.012, x, LE(x) - 0.014);
        seg(sd, 0.07, TE(0.07) + 0.045, 0.27, TE(0.27) + 0.045); seg(sd, 0.28, TE(0.28) + 0.036, 0.465, TE(0.465) + 0.03);
        seg(sd, 0.05, LE(0.05) - 0.018, 0.46, LE(0.46) - 0.018);
      }
    }
    // Four nacelles with cowl rings + engine anchors
    const engines = [];
    const cowlRing = new THREE.TorusGeometry(0.021 * S, 0.004 * S, 6, 14);
    _b17ConeG = _b17ConeG || new THREE.ConeGeometry(0.0125 * S, 0.024 * S, 8);
    for (let i = 0; i < 4; i++) {
      const ex = NACELLE_X[i] * S, sd = ex < 0 ? -1 : 1, W = MW[sd];
      const nacG = tintGeo(new THREE.CylinderGeometry(0.023 * S, 0.016 * S, 0.17 * S, 10), cTop, cBot);
      W.skin.push([nacG, ex, -0.012 * S, 0.13 * S, Z90, 0, 0]);
      W.dark.push([_bgCyl(0.024 * S, 0.024 * S, 0.035 * S, 12), ex, -0.012 * S, 0.2 * S, Z90, 0, 0]);
      W.dark.push([cowlRing, ex, -0.012 * S, 0.218 * S, 0, 0, 0]);
      W.dark.push([_b17ConeG, ex, -0.012 * S, 0.24 * S, Z90, 0, 0]); // spinner
      W.dark.push([_bgBox(0.014 * S, 0.006 * S, 0.06 * S), ex, -0.039 * S, 0.12 * S, 0, 0, 0]); // oil cooler / intercooler
      W.dark.push([_bgBox(0.004 * S, 0.012 * S, 0.05 * S), ex + sd * 0.0245 * S, -0.008 * S, 0.17 * S, 0, 0, 0]); // exhaust collector
      for (const dz of [0.185, 0.197]) W.dark.push([_bgBox(0.05 * S, 0.0013 * S, 0.0016 * S), ex, -0.012 * S + 0.0238 * S, dz * S, 0, 0, 0]); // cowl flaps
      const stn = new THREE.PlaneGeometry(0.05 * S, 0.14 * S);
      W.stain.push([stn, ex, 0.021 * S, 0.02 * S, -Z90, 0, 0]);
      const anchor = new THREE.Object3D(); anchor.position.set(ex, 0.0, 0.1 * S); g.add(anchor);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.056 * S, 20), propDiscMat);
      disc.position.set(ex, -0.012 * S, 0.226 * S); disc.rotation.z = Math.random() * 6; g.add(disc);
      const blades = makeBlades(0.056 * S, 0.012 * S); blades.position.copy(disc.position); g.add(blades);
      const fire = new THREE.Sprite(new THREE.SpriteMaterial({ map: fireTex, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.9 }));
      fire.visible = false; anchor.add(fire);
      engines.push({ anchor, fire, lastEmit: 0, disc, blades });
    }
    { // flush the merged details
      const add = (items, mat, ud) => { if (!items.length) return; const m = new THREE.Mesh(mergeParts(items), mat); Object.assign(m.userData, ud || {}); g.add(m); };
      add(MB.dark, dark); add(MB.glass, glassM); add(MT.dark, dark, { tailPart: true });
      for (const sd of [-1, 1]) { const W = MW[sd]; add(W.skin, skin, { wingSide: sd }); add(W.dark, dark, { wingSide: sd }); add(W.seam, b17SeamMat, { wingSide: sd }); add(W.stain, stainMat, { wingSide: sd }); }
      // belly bomb-bay doors (hinged at the outer edges; only visible while open) + dark bay interior
      const doorG = _bgBox(0.026 * S, 0.0022 * S, 0.17 * S);
      const bay = { L: new THREE.Group(), R: new THREE.Group(), open: -1 };
      for (const sd of [-1, 1]) { const piv = sd < 0 ? bay.L : bay.R; piv.position.set(sd * 0.026 * S, -0.0425 * S, 0.0 * S); const d = new THREE.Mesh(doorG, dark); d.position.x = -sd * 0.013 * S; piv.add(d); piv.visible = false; g.add(piv); }
      bay.dark = new THREE.Mesh(new THREE.PlaneGeometry(0.05 * S, 0.17 * S), new THREE.MeshBasicMaterial({ color: 0x0b0c08 })); bay.dark.rotation.x = Z90; bay.dark.position.set(0, -0.0475 * S, 0); bay.dark.visible = false; g.add(bay.dark);
      bay.set = (o) => { o = o < 0 ? 0 : o > 1 ? 1 : o; if (Math.abs(o - bay.open) < 0.01) return; bay.open = o; const vis = o > 0.01; bay.L.visible = bay.R.visible = bay.dark.visible = vis; bay.L.rotation.z = -o * 1.35; bay.R.rotation.z = o * 1.35; };
      g.userData.bay = bay;
      if (B17_ART[k] != null) { const am = new THREE.MeshStandardMaterial({ map: b17ArtTex(B17_ART[k]), transparent: true, alphaTest: 0.1, roughness: 0.6, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: -2 }); mats.push(am); g.userData.hazeMats.push({ m: am, col: am.color.clone() });
        const art = new THREE.Mesh(new THREE.PlaneGeometry(0.1 * S, 0.05 * S), am); art.position.set(sideX(0.222, 0, -1) * S - 0.0006 * S, 0.0 * S, 0.222 * S); art.rotation.y = -Z90; g.add(art); }
    }
    g.userData.engines = engines;
    g.userData.wob = { ph: k * 2.39 + 0.7, fy: 0.31 + (k % 5) * 0.047, fp: 0.23 + (k % 4) * 0.053 };
    g.visible = false;
    scene.add(g);
    return g;
  }
  // per-ship aerial perspective: blend each Fortress's paint toward the haze colour with distance
  const _hzC = new THREE.Color();
  function b17Haze(g, d) {
    const h = Math.min(0.62, 1 - Math.exp(-Math.max(0, d - 30) / 950));
    if (Math.abs((g.userData._hz || 0) - h) < 0.004) return;
    g.userData._hz = h;
    _hzC.copy(scene.fog ? scene.fog.color : SKY_HORIZON);
    for (const q of g.userData.hazeMats) {
      q.m.color.copy(q.col).multiplyScalar(1 - h);
      if (q.m.emissive) q.m.emissive.copy(_hzC).multiplyScalar(h * 0.62);
      if (q.m.envMapIntensity != null && q.env == null) q.env = q.m.envMapIntensity;
      if (q.env != null) q.m.envMapIntensity = q.env * (1 - h);
    }
  }
  // 1.5.4 debug: pure orthographic render of one AI Fortress (view = side | top | front), shaded or as a black silhouette on white → data URL (for profile comparison sheets)
  function b17Ortho(idx, view, W, H, span, silhouette) {
    const g = friendlyPool[idx]; if (!g) return null;
    const ts = new THREE.Scene(); ts.background = new THREE.Color(0xffffff);
    ts.add(new THREE.AmbientLight(0xffffff, 1.1)); const dl = new THREE.DirectionalLight(0xffffff, 1.6); dl.position.set(40, 80, 60); ts.add(dl);
    const oldParent = g.parent, oldVis = g.visible, oldPos = g.position.clone(), oldQ = g.quaternion.clone(), oldS = g.scale.clone();
    ts.add(g); g.visible = true; g.position.set(0, 0, 0); g.quaternion.identity(); g.scale.set(1, 1, 1); g.updateMatrixWorld(true);
    const hh = span * 0.5, aspect = W / H, cam = new THREE.OrthographicCamera(-hh * aspect * 0, hh, hh / aspect * 0.5, -hh / aspect * 0.5, 0.1, 400);
    const cx = view === "side" ? [60, 0, 0] : view === "top" ? [0, 60, 0] : [0, 0, 60];
    cam.left = -hh; cam.right = hh; cam.top = hh / aspect; cam.bottom = -hh / aspect;
    cam.position.set(cx[0], cx[1], cx[2]); cam.up.set(0, view === "top" ? 0 : 1, view === "top" ? -1 : 0); cam.lookAt(0, 0, 0); cam.updateProjectionMatrix();
    if (silhouette) ts.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
    const rt = new THREE.WebGLRenderTarget(W, H); renderer.setRenderTarget(rt); renderer.render(ts, cam); renderer.setRenderTarget(null);
    const px = new Uint8Array(W * H * 4); renderer.readRenderTargetPixels(rt, 0, 0, W, H, px); rt.dispose();
    if (oldParent) oldParent.add(g); else scene.add(g); g.visible = oldVis; g.position.copy(oldPos); g.quaternion.copy(oldQ); g.scale.copy(oldS); g.updateMatrixWorld(true);
    const c = document.createElement("canvas"); c.width = W; c.height = H; const x = c.getContext("2d"), id = x.createImageData(W, H);
    for (let y = 0; y < H; y++) id.data.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
    if (!silhouette) for (let i = 0; i < id.data.length; i += 4) for (let c3 = 0; c3 < 3; c3++) id.data[i + c3] = Math.round(255 * Math.pow(id.data[i + c3] / 255, 1 / 2.2)); // render target is linear → sRGB
    x.putImageData(id, 0, 0); return c.toDataURL("image/png");
  }
  // ===== 1.5.8 B-17 BREAK-UP (AI Fortresses). A death takes one of these shapes (game.js pickDeath): the TAIL cone (fuselage aft of the waist + fin + stabilizers) tears away; one WING (with its engines) folds off and
  // spirals down; a full BREAK-UP (tail + both wings); or she falls intact and burning (some of those shed the tail on the way). Every piece is its own group that falls (terminal speed) with fire and a smoke
  // trail all the way to the ground and ends in its own explosion + scorch (crashImpact). The fuselage tumbles on game.js's physics and crashes there. =====
  const WRECK_TRAILS = 5; // wrecks (hulls + pieces) that get smoke ribbons / flame tongues at once
  const DET_VT = { tail: 175, wing: 150 };         // terminal fall speeds (u/s) — a flat wing flutters, a tail cone tumbles
  const DET_SIZE = { tail: 0.55, wing: 0.7, hull: 1 }; // crash size scale
  function groundWY() { return CAM.y * (1 - EARTH_K) + EARTH_K * (GROUND_Y + 0.05); }
  function detachPiece(g, f, kind, side) {
    const S = B17_VIS, isWing = kind === "wing";
    g.updateMatrixWorld(true);
    const grp = new THREE.Group(); grp.position.copy(g.position); grp.quaternion.copy(g.quaternion); scene.add(grp);
    const moved = [];
    for (const c of g.children.slice()) {
      if (c.isSprite) continue;
      const u = c.userData;
      if (u.stubCap) { if (!isWing) c.visible = true; continue; }
      const on = isWing ? (u.wingSide === side || (u.wingSide == null && !u.tailPart && c.position.x * side > 0.075 * S && c.position.z > -0.3 * S)) : !!u.tailPart;
      if (!on) continue;
      moved.push({ c, p: c.position.clone(), q: c.quaternion.clone(), sc: c.scale.clone(), vis: c.visible });
      if (u.tailCap) c.visible = true;
      grp.add(c);
    }
    const mk = (x, y, z, sx, sy) => { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: fireTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.9 })); sp.position.set(x, y, z); sp.scale.set(sx, sy, 1); grp.add(sp); return sp; };
    const sprites = isWing ? [mk(side * 1.8, 0.4, 0.0, 3.2, 4.2), mk(side * 5.2, 0.3, 0.1, 2.4, 3.2)] : [mk(0, 0.2, -0.19 * S, 2.6, 3.4)];
    const fvx = f.vx || 0, fvy = f.vy || 0, fvz = f.vz || 0, R = (a) => (Math.random() - 0.5) * a;
    grp.userData = { moved, sprites, kind, side, isWing, t: 0, dead: false, vt: DET_VT[kind], f,
      vx: fvx + (isWing ? side * 9 : R(8)), vy: fvy + (isWing ? 2.5 : 4), vz: fvz + (isWing ? -4 : -10),
      wx: R(isWing ? 0.9 : 3.2), wy: R(isWing ? 1.0 : 2.2), wz: isWing ? side * (1.4 + Math.random() * 1.2) : 1.5 + Math.random() * 2,
      hr: isWing ? 7 + Math.random() * 6 : 0, hw: 0.9 + Math.random() * 0.5, hph: Math.random() * 6.28, key: "pc" + (_detN++) };
    (g.userData.dets || (g.userData.dets = [])).push(grp);
    const P = new THREE.Vector3(isWing ? side * 1.5 : 0, 0, isWing ? 0 : -0.19 * S).applyMatrix4(g.matrixWorld);
    spawnDebris(P.x, P.y, P.z, 70, 0.7); spawnDebris(P.x, P.y, P.z, 25, 1.2);
    emitSmoke(P, true, true);
    if (window.FGAudio && window.FGAudio.boom) window.FGAudio.boom(P.x, P.y, P.z, true);
    detStats.sep[kind]++;
  }
  let _detN = 0; const detStats = { sep: { tail: 0, wing: 0 }, crashed: { tail: 0, wing: 0, hull: 0 }, maxLive: 0, live: 0 };
  function detachB17(g, f) { // from the death kind
    const k = f.deathKind;
    if (k === "tail" || k === "break") detachPiece(g, f, "tail", 0);
    if (k === "wing" || k === "break") detachPiece(g, f, "wing", f.deathSide > 0 ? 1 : -1);
    if (k === "break") detachPiece(g, f, "wing", f.deathSide > 0 ? -1 : 1);
  }
  function restoreB17(g) {
    const ds = g.userData.dets; if (!ds || !ds.length) return;
    for (const grp of ds) { for (const m of grp.userData.moved) { g.add(m.c); m.c.position.copy(m.p); m.c.quaternion.copy(m.q); m.c.scale.copy(m.sc); m.c.visible = m.vis; } scene.remove(grp); }
    for (const c of g.children) if (c.userData && c.userData.stubCap) c.visible = false;
    g.userData.dets = [];
  }
  const _dq = new THREE.Vector3();
  function updateDetB17(g, dt, idx, trail) {
    const ds = g.userData.dets; if (!ds) return 0;
    let live = 0;
    for (const grp of ds) {
      const u = grp.userData; if (u.dead) continue;
      live++;
      for (let left = dt; left > 1e-5 && !u.dead; ) { // the pieces run on the SIM clock (same as the hull in game.js), sub-stepped so a slow frame cannot desync them
        const h = Math.min(0.05, left); left -= h;
        u.t += h; u.vy -= 10 * h; u.vy = Math.max(u.vy, -u.vt); u.vx *= Math.pow(0.85, h); u.vz += (-AIR_DRIFT - u.vz) * Math.min(1, 0.25 * h);
        grp.position.x += u.vx * h; grp.position.y += u.vy * h; grp.position.z += u.vz * h;
        if (u.hr) { const ph0 = u.hph; u.hph += u.hw * h; grp.position.x += (Math.cos(u.hph) - Math.cos(ph0)) * u.hr; grp.position.z += (Math.sin(u.hph) - Math.sin(ph0)) * u.hr; } // a wing spirals as it falls
        grp.rotateX(u.wx * h); grp.rotateY(u.wy * h); grp.rotateZ(u.wz * h);
        if (grp.position.y <= groundWY() + 2) { u.dead = true; grp.visible = false; detStats.crashed[u.kind]++; crashImpact(grp.position, DET_SIZE[u.kind], u.kind); }
      }
      if (u.dead) continue;
      const dcam = grp.position.distanceTo(camera.position);
      for (const sp of u.sprites) { sp.visible = true; const k = 0.8 + Math.random() * 0.3; sp.material.opacity = 0.55 + Math.random() * 0.4; sp.scale.x = sp.scale.x * 0.98 + 0.02 * 3 * k * (1 + dcam / 1500); }
      if (trail) {
        const ws = Math.min(8, 1 + dcam / 800); // far trails are widened so they still read as a line at kilometres
        _v.set(u.isWing ? u.side * 4.5 : 0, 0.2, u.isWing ? 0 : -0.19 * B17_VIS); grp.localToWorld(_v);
        ribbonEmit(u.key, _v, { w0: 1.2 * ws, w1: 11 * ws, life: 3.6 + Math.min(3, dcam / 1500), a: 0.66, col: [0.12, 0.115, 0.11], drift: AIR_DRIFT });
        if (u.isWing) { _v.set(u.side * 1.2, 0.3, 0.0); g.localToWorld(_v); if (g.visible) ribbonEmit(u.key + "s", _v, { w0: 1.2 * ws, w1: 13 * ws, life: 3.6, a: 0.7, col: [0.11, 0.105, 0.1], drift: AIR_DRIFT }); }
      }
    }
    return live;
  }
  const friendlyPool = [];
  for (let i = 0; i < 18; i++) friendlyPool.push(buildB17());

  // ===== 1.3.3: the player's OWN B-17 built around the top-turret camera =====
  // Own-ship frame: origin = gunner's eye (CAM), +Z = nose, +X = port wing, 1u ≈ 4 ft
  // (span 103 ft ≈ 26u, length 75 ft ≈ 19u). Rolls with the airframe (list / turn).
  const ownShip = new THREE.Group();
  ownShip.position.set(CAM.x, CAM.y, CAM.z);
  scene.add(ownShip);
  const ownEngines = [];
  const ownTail = { fire: null, smokeAt: null, emit: 0 };
  const holeTexs = [];
  // 1.5.8 DAMAGE DECALS: no more bright-lipped jagged "starburst" cut-outs. A hit is a soft scorch/soot patch with a small dark irregular puncture, hairline cracks and a few dim smears; a tear is a larger
  // ragged dark opening with dim ribs inside a soot halo. Edges feather to alpha 0 (no outline) and the decal geometry is cut from the skin triangles themselves (buildDecal), so it lies ON the surface.
  const decalMatOpts = { transparent: true, alphaTest: 0.03, depthWrite: false, depthTest: true, polygonOffset: true, side: THREE.DoubleSide };
  function jag(x, rx, ry, n, jit) { x.beginPath(); for (let k = 0; k <= n; k++) { const a = (k / n) * Math.PI * 2, r = 1 - jit + Math.random() * jit * 2; const px = Math.cos(a) * rx * r, py = Math.sin(a) * ry * r; k ? x.lineTo(px, py) : x.moveTo(px, py); } x.closePath(); }
  for (let v = 0; v < 4; v++) {
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const x = c.getContext("2d"); x.translate(32, 32);
    let g = x.createRadialGradient(0, 0, 2, 0, 0, 30); // soot / scorched paint (soft)
    g.addColorStop(0, "rgba(14,12,10,0.7)"); g.addColorStop(0.45, "rgba(24,21,17,0.38)"); g.addColorStop(1, "rgba(0,0,0,0)");
    x.fillStyle = g; x.save(); x.scale(1, 0.85 + v * 0.07); x.beginPath(); x.arc(0, 0, 30, 0, Math.PI * 2); x.fill(); x.restore();
    x.strokeStyle = "rgba(20,18,15,0.32)"; x.lineWidth = 2.2; x.lineCap = "round"; // smudges / streaks
    for (let k = 0; k < 3; k++) { const a = Math.random() * 6.28, l = 12 + Math.random() * 12; x.beginPath(); x.moveTo(Math.cos(a) * 5, Math.sin(a) * 5); x.lineTo(Math.cos(a) * l, Math.sin(a) * l * 0.8); x.stroke(); }
    const rIn = 4.2 + v * 0.8;
    x.fillStyle = "rgba(46,44,40,0.55)"; jag(x, rIn * 1.7, rIn * 1.5, 9 + v, 0.22); x.fill(); // dented / burred rim: dim, not bright
    x.fillStyle = "rgb(7,6,5)"; jag(x, rIn, rIn * 0.9, 8, 0.28); x.fill(); // the puncture
    x.strokeStyle = "rgba(40,38,34,0.55)"; x.lineWidth = 0.7; // hairline cracks
    for (let k = 0; k < 4; k++) { const a = Math.random() * 6.28; x.beginPath(); x.moveTo(Math.cos(a) * rIn * 1.3, Math.sin(a) * rIn * 1.3); x.lineTo(Math.cos(a + 0.2) * (rIn + 7 + Math.random() * 6), Math.sin(a + 0.2) * (rIn + 7 + Math.random() * 6)); x.stroke(); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    holeTexs.push(new THREE.MeshStandardMaterial(Object.assign({ map: t, roughness: 0.7, metalness: 0.15, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }, decalMatOpts)));
  }
  const tearTexs = [];
  for (let v = 0; v < 3; v++) {
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const x = c.getContext("2d"); x.translate(64, 64);
    const g = x.createRadialGradient(0, 0, 8, 0, 0, 62);
    g.addColorStop(0, "rgba(16,13,10,0.7)"); g.addColorStop(0.55, "rgba(24,20,15,0.34)"); g.addColorStop(1, "rgba(0,0,0,0)");
    x.fillStyle = g; x.beginPath(); x.arc(0, 0, 62, 0, Math.PI * 2); x.fill();
    const rx = 27 + v * 3, ry = 17 + v * 4;
    x.fillStyle = "rgba(52,50,45,0.6)"; jag(x, rx * 1.22, ry * 1.25, 14 + v * 2, 0.2); x.fill(); // bent-back skin: dim grey, soft
    x.fillStyle = "rgb(6,5,4)"; jag(x, rx, ry, 13 + v * 2, 0.25); x.fill(); // the opening
    x.save(); x.beginPath(); x.ellipse(0, 0, rx * 0.95, ry * 0.95, 0, 0, 6.29); x.clip();
    x.strokeStyle = "rgba(92,90,80,0.8)"; x.lineWidth = 2.4; // exposed ribs (dim)
    for (let k = 0; k < 2 + (v > 0 ? 1 : 0); k++) { const ox = -rx * 0.55 + k * rx * 0.55 + (Math.random() - 0.5) * 5; x.beginPath(); x.moveTo(ox, -ry * 1.4); x.quadraticCurveTo(ox + (Math.random() - 0.5) * 10, 0, ox + (Math.random() - 0.5) * 6, ry * 1.4); x.stroke(); }
    x.lineWidth = 1.3; x.strokeStyle = "rgba(70,68,60,0.8)"; for (let k = 0; k < 2; k++) { const oy = -ry * 0.35 + k * ry * 0.7; x.beginPath(); x.moveTo(-rx * 1.3, oy); x.lineTo(rx * 1.3, oy + (Math.random() - 0.5) * 4); x.stroke(); }
    x.restore();
    x.strokeStyle = "rgba(34,32,28,0.45)"; x.lineWidth = 1; x.lineCap = "round"; // split lines
    for (let k = 0; k < 4; k++) { const a = Math.random() * 6.28; x.beginPath(); x.moveTo(Math.cos(a) * rx * 1.25, Math.sin(a) * ry * 1.25); x.lineTo(Math.cos(a) * (rx + 16), Math.sin(a) * (ry + 12)); x.stroke(); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    tearTexs.push(new THREE.MeshStandardMaterial(Object.assign({ map: t, roughness: 0.75, metalness: 0.1, polygonOffsetFactor: -5, polygonOffsetUnits: -5 }, decalMatOpts)));
  }
  const holeGeo = new THREE.PlaneGeometry(1, 1);
  const ownHoles = [];
  // 1.4.0: health-driven structural damage (see buildOwnDamage) + fin / stabilizer cut-out maps
  const ownDmg = { items: [], cuts: [], lastKey: -1, wisp: null, wispT: 0 };
  function makeCutMap(x0, x1, y0, y1, W, H) { // alphaMap over a shape's cap UVs (shape coords x0..x1, y0..y1)
    const c = document.createElement("canvas"); c.width = W; c.height = H; const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    const tex = new THREE.CanvasTexture(c); tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.repeat.set(1 / (x1 - x0), 1 / (y1 - y0)); tex.offset.set(-x0 / (x1 - x0), -y0 / (y1 - y0));
    const px = (sx) => (sx - x0) / (x1 - x0) * W, py = (sy) => (1 - (sy - y0) / (y1 - y0)) * H; // flipY: canvas top = y1
    const cm = { c, ctx, tex, px, py, events: [], W, H };
    ownDmg.cuts.push(cm);
    return cm;
  }
  (function buildOwnShip() {
    // panel lines + rivets + weathering (multiplied into the olive drab)
    const panelTex = (() => {
      const c = document.createElement("canvas"); c.width = c.height = 256;
      const x = c.getContext("2d");
      x.fillStyle = "#d4d4d4"; x.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 2600; i++) { const v = 190 + Math.random() * 60 | 0; x.fillStyle = "rgba(" + v + "," + v + "," + v + ",0.35)"; x.fillRect(Math.random() * 256, Math.random() * 256, 2 + Math.random() * 6, 1 + Math.random() * 3); }
      x.strokeStyle = "rgba(70,70,70,0.55)"; x.lineWidth = 1.2;
      for (let yy = 0; yy <= 256; yy += 64) { x.beginPath(); x.moveTo(0, yy); x.lineTo(256, yy); x.stroke(); }
      for (let r = 0; r < 4; r++) for (let k = 0; k < 3; k++) { const xx = (k * 96 + (r % 2) * 48) % 256; x.beginPath(); x.moveTo(xx, r * 64); x.lineTo(xx, r * 64 + 64); x.stroke(); }
      x.fillStyle = "rgba(90,90,90,0.35)";
      for (let yy = 0; yy < 256; yy += 64) for (let xx = 0; xx < 256; xx += 6) x.fillRect(xx, yy + 3, 1.2, 1.2);
      const tx = new THREE.CanvasTexture(c);
      tx.colorSpace = THREE.SRGBColorSpace;
      tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
      tx.repeat.set(0.3, 0.3);
      tx.anisotropy = 4;
      return tx;
    })();
    const od = new THREE.MeshStandardMaterial({ color: 0x4d5634, map: panelTex, roughness: 0.5, metalness: 0.2, envMapIntensity: 0.5, side: THREE.DoubleSide });
    const odDark = new THREE.MeshStandardMaterial({ color: 0x2b2f22, roughness: 0.62, metalness: 0.3, side: THREE.DoubleSide });
    // polished aluminium: bright env reflection from above, hard sun highlights, rivet rows from the panel texture
    const aluTex = panelTex.clone(); aluTex.needsUpdate = true; aluTex.repeat.set(0.45, 0.45);
    // its own bright "sky" environment: a hot hazy horizon band + a sun spot, so the spine glares like the photos
    const aluEnv = (() => {
      const W = 256, H = 128, c = document.createElement("canvas"); c.width = W; c.height = H; const x = c.getContext("2d");
      const g = x.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, "#5f86c0"); g.addColorStop(0.36, "#a9c3e3"); g.addColorStop(0.47, "#f4f7fb"); g.addColorStop(0.5, "#e6ebf0"); g.addColorStop(0.56, "#aeb6bf"); g.addColorStop(1, "#5a6068");
      x.fillStyle = g; x.fillRect(0, 0, W, H);
      const sx = W * (0.5 + Math.atan2(45, 30) / (2 * Math.PI)), sy = H * (0.5 - Math.asin(90 / Math.hypot(45, 90, 30)) / Math.PI);
      for (const ox of [-W, 0, W]) { const sg = x.createRadialGradient(sx + ox, sy, 0, sx + ox, sy, 22); sg.addColorStop(0, "rgba(255,255,250,1)"); sg.addColorStop(0.25, "rgba(255,250,235,0.9)"); sg.addColorStop(1, "rgba(255,250,235,0)"); x.fillStyle = sg; x.fillRect(0, 0, W, H); }
      const t = new THREE.CanvasTexture(c); t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    const alu = new THREE.MeshStandardMaterial({ color: 0x4d5634, map: aluTex, roughness: 0.5, metalness: 0.2, envMapIntensity: 0.5, side: THREE.DoubleSide }); // 1.5.3: the aft spine is the same olive drab as the nose (was polished aluminium)
    const glass = new THREE.MeshStandardMaterial({ color: 0x1c262c, roughness: 0.08, metalness: 0.6, envMapIntensity: 0.65, side: THREE.DoubleSide });
    const boot = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.85, metalness: 0.05, side: THREE.DoubleSide });
    const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x || 0, y || 0, z || 0); ownShip.add(m); return m; };
    // --- fuselage: lofted rings nose → tail ---
    const st = [
      [5.3, 0.1, -2.02], [5.1, 0.45, -2.0], [4.6, 0.8, -1.96], [3.8, 0.98, -1.9], [2.6, 1.06, -1.86],
      [0.5, 1.08, -1.85], [-0.9, 1.072, -1.85], [-3.0, 1.06, -1.85], [-6.0, 0.96, -1.8], [-9.0, 0.74, -1.7],
      [-11.5, 0.52, -1.6], [-13.2, 0.36, -1.52], [-13.9, 0.12, -1.5],
    ];
    const SEG = 18, pos = [], idx = [], uv = [];
    for (const [z, r, cy] of st) for (let j = 0; j <= SEG; j++) {
      const a = (j / SEG) * Math.PI * 2;
      pos.push(Math.cos(a) * r, cy + Math.sin(a) * r * 1.08, z);
      uv.push(a * 1.06, z);
    }
    for (let i = 0; i < st.length - 1; i++) for (let j = 0; j < SEG; j++) {
      const a = i * (SEG + 1) + j, b = a + SEG + 1;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    fg.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    fg.setIndex(idx); fg.computeVertexNormals();
    // 1.4.0: olive-drab nose section, POLISHED bare-aluminium spine aft of the turret (as in the photos)
    const splitI = st.findIndex((q) => q[0] <= -0.9);
    fg.addGroup(0, splitI * SEG * 6, 0); fg.addGroup(splitI * SEG * 6, (st.length - 1 - splitI) * SEG * 6, 1);
    add(fg, [od, alu]);
    const topAt = (z) => { // fuselage top-line height at station z
      for (let i = 0; i < st.length - 1; i++) {
        const [z0, r0, c0] = st[i], [z1, r1, c1] = st[i + 1];
        if (z <= z0 && z >= z1) { const k = (z0 - z) / (z0 - z1); return (c0 + (c1 - c0) * k) + (r0 + (r1 - r0) * k) * 1.08; }
      }
      return -1.5;
    };
    // nose glazing (bombardier's plexi)
    const ng = new THREE.Mesh(new THREE.SphereGeometry(0.62, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), glass);
    ng.rotation.x = Math.PI / 2; ng.scale.set(1, 1.1, 1); ng.position.set(0, -2.0, 4.85); ownShip.add(ng);
    // --- cockpit: framed greenhouse (overhead + side glass) and windscreen ahead of the turret ---
    {
      const sh = new THREE.Shape();
      sh.moveTo(0.95, -1.25); sh.lineTo(0.95, -0.86); sh.quadraticCurveTo(1.05, -0.76, 1.4, -0.76);
      sh.lineTo(2.45, -0.78); sh.lineTo(3.3, -1.18); sh.lineTo(3.55, -1.3); sh.lineTo(0.95, -1.3);
      const cg = new THREE.ExtrudeGeometry(sh, { depth: 1.2, bevelEnabled: true, bevelSize: 0.12, bevelThickness: 0.14, bevelSegments: 3 });
      cg.translate(0, 0, -0.6);
      // 1.4.1: tinted plexiglass that REFLECTS THE SKY (Fresnel dielectric with a sky environment), over a dark
      // cockpit with the two pilots' heads — no more black slab. The frames are thin olive drab, not pale bars.
      const skyEnvC = (() => {
        const W = 256, H = 128, c = document.createElement("canvas"); c.width = W; c.height = H; const x = c.getContext("2d");
        const g = x.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, "#4f78b4"); g.addColorStop(0.3, "#86a8d4"); g.addColorStop(0.46, "#dfe8f2"); g.addColorStop(0.5, "#c8d2da"); g.addColorStop(0.56, "#7f8a7a"); g.addColorStop(1, "#4a5446");
        x.fillStyle = g; x.fillRect(0, 0, W, H);
        for (let i = 0; i < 26; i++) { const cx = Math.random() * W, cy = H * (0.36 + Math.random() * 0.1), r = 6 + Math.random() * 14; const cg2 = x.createRadialGradient(cx, cy, 0, cx, cy, r); cg2.addColorStop(0, "rgba(255,255,255,0.55)"); cg2.addColorStop(1, "rgba(255,255,255,0)"); x.fillStyle = cg2; x.fillRect(cx - r, cy - r, 2 * r, 2 * r); }
        const t = new THREE.CanvasTexture(c); t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.SRGBColorSpace; return t;
      })();
      const plexi = new THREE.MeshPhysicalMaterial({ color: 0x3a4c58, metalness: 0.0, roughness: 0.05, envMap: skyEnvC, envMapIntensity: 1.25,
        transparent: true, opacity: 0.5, reflectivity: 0.9, clearcoat: 1.0, clearcoatRoughness: 0.04, side: THREE.FrontSide, depthWrite: false });
      const cm = new THREE.Mesh(cg, plexi);
      cm.rotation.y = -Math.PI / 2; cm.renderOrder = 3; cm.userData.noHit = true;
      ownShip.add(cm);
      { // dark cockpit under the glass: instrument coaming, two seats' worth of pilots (leather helmets, shoulders)
        const inside = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.9, metalness: 0.1 });
        const leather = new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 0.75, metalness: 0.05 });
        const jacket = new THREE.MeshStandardMaterial({ color: 0x3a3226, roughness: 0.85, metalness: 0.0 });
        const floor = add(new THREE.BoxGeometry(1.3, 0.05, 2.1), inside, 0, -1.12, 1.95); floor.userData.noHit = true;
        const coam = add(new THREE.BoxGeometry(1.2, 0.16, 0.2), inside, 0, -1.02, 2.75); coam.userData.noHit = true;
        for (const sd of [-1, 1]) {
          const head = add(new THREE.SphereGeometry(0.095, 12, 10), leather, sd * 0.3, -0.9, 2.32); head.scale.set(1, 1.1, 1.05); head.userData.noHit = true;
          const sh = add(new THREE.BoxGeometry(0.34, 0.16, 0.2), jacket, sd * 0.3, -1.05, 2.26); sh.userData.noHit = true;
        }
      }
      // canopy frames (olive-drab bars over the glass)
      const frameOD = new THREE.MeshStandardMaterial({ color: 0x3a412a, roughness: 0.7, metalness: 0.15, envMapIntensity: 0.15, side: THREE.DoubleSide });
      const bar = (w, h, d, x, y, z, rx) => { const b = add(new THREE.BoxGeometry(w, h * 0.8, d), frameOD, x, y, z); if (rx) b.rotation.x = rx; return b; };
      for (const zz of [1.35, 1.95]) bar(1.3, 0.025, 0.035, 0, -0.612, zz);
      bar(1.36, 0.03, 0.05, 0, -0.615, 2.47);
      bar(0.035, 0.025, 1.2, 0, -0.612, 1.85);
      for (const sd of [-1, 1]) {
        bar(0.04, 0.03, 1.5, sd * 0.64, -0.63, 1.75);
        bar(0.04, 0.03, 1.0, sd * 0.6, -0.95, 2.93, -0.44);
      }
      bar(0.04, 0.03, 1.0, 0, -0.95, 2.93, -0.44);
      // fuselage skin skirt under the glass so the greenhouse sits IN the fuselage
      const sk = add(new THREE.BoxGeometry(1.5, 0.3, 2.6), od, 0, -1.12, 2.25);
      sk.visible = true;
    }
    // turret ring collar under the gunner (just visible at the lowest pitch)
    // 1.3.5: thin flush seam — reads as the turret ring (not a tyre around the view) when looking down
    { const ring = new THREE.Mesh(new THREE.TorusGeometry(0.74, 0.03, 5, 40), odDark); ring.rotation.x = Math.PI / 2; ring.scale.set(1, 1, 0.5); ring.position.set(0, topAt(0) + 0.005, 0); ownShip.add(ring); }
    // (1.4.0: the open radio-room hatch + gun were removed — a clean riveted spine like the photos)
    // --- wings: tapered low wing with dihedral, de-icer boots, insignia ---
    const LE = (ax) => 1.6 - (ax - 1) * (2.0 / 12);
    const TE = (ax) => -3.4 + (ax - 1) * (1.1 / 12);
    const WY = (ax) => -2.35 + ax * 0.0787;
    function wingGeo(pts, t0, t1, lift) {
      const sh = new THREE.Shape();
      sh.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) sh.lineTo(pts[i][0], pts[i][1]);
      sh.closePath();
      const g = new THREE.ExtrudeGeometry(sh, { depth: 1, bevelEnabled: false });
      g.rotateX(Math.PI / 2); // shape y → world z, extrusion → world -y (0..-1)
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), ax = Math.abs(x);
        const th = t0 + (t1 - t0) * Math.min(1, ax / 13);
        const y = p.getY(i) + 0.5; // -0.5..0.5
        p.setY(i, WY(ax) + (lift || 0) + y * th); // rotateX(+90): shape y → world +z
      }
      g.computeVertexNormals();
      return g;
    }
    const plan = [];
    // port tip → root (x>0), then starboard root → tip, then back along trailing edge
    const xs = [13.0, 10.5, 8.3, 6.3, 4.3, 2.4, 1.0];
    plan.push([13.35, -1.35]);
    for (const x of xs) plan.push([x, LE(x)]);
    for (const x of xs.slice().reverse()) plan.push([-x, LE(x)]);
    plan.push([-13.35, -1.35]);
    for (const x of xs) plan.push([-x, TE(x)]);
    for (const x of xs.slice().reverse()) plan.push([x, TE(x)]);
    { // 1.5.2: two half-wings (so one can tear off at the root in a wing-fold death); same planform as the one-piece wing
      const portP = [[13.35, -1.35]]; for (const x of xs) portP.push([x, LE(x)]); portP.push([0, LE(1.0)], [0, TE(1.0)]); for (const x of xs.slice().reverse()) portP.push([x, TE(x)]);
      const stbdP = portP.map(([x, z]) => [-x, z]).reverse();
      const wp = add(wingGeo(portP, 0.7, 0.24, 0), od); wp.userData.wingSide = 1;
      const ws = add(wingGeo(stbdP, 0.7, 0.24, 0), od); ws.userData.wingSide = -1;
    }
    for (const sd of [1, -1]) { // de-icer boots along the leading edge
      const bp = [];
      const bx = [12.6, 8.3, 4.3, 1.4];
      for (const x of bx) bp.push([sd * x, LE(x) + 0.03]);
      for (const x of bx.slice().reverse()) bp.push([sd * x, LE(x) - 0.38]);
      const bm = add(wingGeo(bp, 0.74, 0.28, 0.005), boot); bm.userData.wingSide = sd;
    }
    { // national insignia — upper port wing (as on the real B-17G)
      const c = document.createElement("canvas"); c.width = c.height = 128;
      const x = c.getContext("2d");
      x.fillStyle = "#1f2f5e"; x.beginPath(); x.arc(64, 64, 62, 0, Math.PI * 2); x.fill();
      x.fillStyle = "#e8e6dc"; x.beginPath();
      for (let k = 0; k < 10; k++) { const r = k % 2 ? 24 : 60, a = -Math.PI / 2 + k * Math.PI / 5; x.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r); }
      x.closePath(); x.fill();
      const tx = new THREE.CanvasTexture(c); tx.colorSpace = THREE.SRGBColorSpace; tx.anisotropy = 4;
      const ins = new THREE.Mesh(new THREE.CircleGeometry(1.15, 28), new THREE.MeshStandardMaterial({ map: tx, roughness: 0.6, metalness: 0.1, transparent: true, polygonOffset: true, polygonOffsetFactor: -2 }));
      ins.rotation.x = -Math.PI / 2;
      ins.rotation.z = Math.PI; // star points forward
      const ax = 10.2, th = 0.7 + (0.24 - 0.7) * (ax / 13);
      ins.position.set(ax, WY(ax) + th * 0.5 + 0.015, (LE(ax) + TE(ax)) * 0.5);
      ins.userData.wingSide = 1; ownShip.add(ins);
    }
    // --- tail (1.4.0 rebuild): bare-metal stabilizers with RED tips; a thicker, tapered B-17G fin at the right
    // height (tip ≈ 3.1u / 12 ft above the tail cone, y ≈ 2.0), long low dorsal fillet, rudder hinge + trim-tab lines.
    // Both carry an alphaMap "cut map" so shot-away chunks and holes really open to the sky (buildOwnDamage).
    const stabCut = makeCutMap(-5.9, 5.9, -13.6, -10.4, 512, 160);
    const stabMap = (() => {
      const W = 512, H = 160, c = document.createElement("canvas"); c.width = W; c.height = H; const x = c.getContext("2d");
      const px = (sx) => (sx + 5.9) / 11.8 * W, py = (sz) => (1 - (sz + 13.6) / 3.2) * H;
      x.fillStyle = "#c9cfc0"; x.fillRect(0, 0, W, H); // 1.5.3: light base × olive-drab material colour = the same olive drab as the rest of the ship
      x.strokeStyle = "rgba(90,95,100,0.55)"; x.lineWidth = 1;
      for (let k = -5; k <= 5; k++) { x.beginPath(); x.moveTo(px(k), 0); x.lineTo(px(k), H); x.stroke(); }
      x.strokeStyle = "rgba(40,44,48,0.8)"; x.lineWidth = 1.6; x.beginPath(); x.moveTo(0, py(-12.55)); x.lineTo(W, py(-12.55)); x.stroke(); // elevator hinge
      x.fillStyle = "rgba(120,125,130,0.5)"; for (let xx = 0; xx < W; xx += 5) { x.fillRect(xx, py(-11.2), 1, 1); x.fillRect(xx, py(-12.4), 1, 1); }
      /* 1.5.3: no red tips */
      x.fillStyle = "rgba(255,255,255,0.15)"; x.fillRect(0, py(-10.7), W, 3);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
      t.repeat.copy(stabCut.tex.repeat); t.offset.copy(stabCut.tex.offset); return t;
    })();
    const stabMat = new THREE.MeshStandardMaterial({ color: 0x4d5634, map: stabMap, alphaMap: stabCut.tex, alphaTest: 0.5, roughness: 0.5, metalness: 0.2, envMapIntensity: 0.5, side: THREE.DoubleSide });
    {
      const sh = new THREE.Shape();
      const hp = [[0.6, -10.6], [5.4, -12.35], [5.6, -12.9], [5.2, -13.35], [0.6, -13.4], [-0.6, -13.4], [-5.2, -13.35], [-5.6, -12.9], [-5.4, -12.35], [-0.6, -10.6]];
      sh.moveTo(hp[0][0], hp[0][1]);
      for (let i = 1; i < hp.length; i++) sh.lineTo(hp[i][0], hp[i][1]);
      const hg = new THREE.ExtrudeGeometry(sh, { depth: 0.2, bevelEnabled: false });
      { const pa = hg.attributes.position, uv = hg.attributes.uv; for (let i = 0; i < pa.count; i++) uv.setXY(i, pa.getX(i), pa.getY(i)); } // 1.4.0: side walls in shape coords too, so the cut map opens them
      { const pa = hg.attributes.position; for (let i = 0; i < pa.count; i++) { const ax = Math.abs(pa.getX(i)), k = 1 - 0.55 * Math.min(1, ax / 5.6); pa.setZ(i, (pa.getZ(i) - 0.1) * k + 0.1); } hg.computeVertexNormals(); }
      hg.rotateX(Math.PI / 2);
      const stab = add(hg, stabMat, 0, -1.35, 0); stab.userData.part = "stab";
    }
    const finCut = makeCutMap(-14.0, -4.8, -1.3, 2.3, 512, 200);
    const finMat = new THREE.MeshStandardMaterial({ color: 0x4d5634, map: aluTex, alphaMap: finCut.tex, alphaTest: 0.5, roughness: 0.5, metalness: 0.2, envMapIntensity: 0.5, side: THREE.DoubleSide });
    const FIN_TOP = 2.03;
    {
      const sh = new THREE.Shape();
      sh.moveTo(-5.0, topAt(-5.0) - 0.05);
      sh.lineTo(-8.8, topAt(-8.8) + 0.2);                              // long low dorsal fillet
      sh.quadraticCurveTo(-10.35, topAt(-10.35) + 0.45, -10.95, 0.05); // fillet sweeps up into the leading edge
      sh.lineTo(-11.72, 1.45);                                          // swept leading edge
      sh.quadraticCurveTo(-12.1, FIN_TOP, -12.66, FIN_TOP);             // rounded tip
      sh.quadraticCurveTo(-13.34, FIN_TOP - 0.03, -13.55, 1.45);
      sh.lineTo(-13.82, -0.2);                                          // rudder trailing edge
      sh.lineTo(-13.88, -1.05);
      sh.lineTo(-9.0, topAt(-9.0) - 0.14); sh.closePath();
      const fg2 = new THREE.ExtrudeGeometry(sh, { depth: 0.26, bevelEnabled: true, bevelSize: 0.035, bevelThickness: 0.04, bevelSegments: 2, curveSegments: 10 });
      { const pa = fg2.attributes.position, uv = fg2.attributes.uv; for (let i = 0; i < pa.count; i++) uv.setXY(i, pa.getX(i), pa.getY(i)); } // side walls cut too (edge-on the fin is ALL side wall)
      // taper: full thickness at the root, ~40 % at the tip; thinner toward the trailing edge too
      const pa = fg2.attributes.position, yRoot = -1.0;
      for (let i = 0; i < pa.count; i++) {
        const y = pa.getY(i), z = pa.getX(i);
        const kh = 1 - 0.6 * Math.max(0, Math.min(1, (y - yRoot) / (FIN_TOP - yRoot)));
        const kc = 1 - 0.35 * Math.max(0, Math.min(1, (-12.9 - z) / 0.9));
        pa.setZ(i, (pa.getZ(i) - 0.13) * kh * kc);
      }
      fg2.computeVertexNormals();
      const fin = new THREE.Mesh(fg2, finMat);
      fin.rotation.y = -Math.PI / 2; fin.userData.part = "fin";
      ownShip.add(fin);
      // rudder hinge line + rudder outline + trim tab, on both faces (thin dark strips just proud of the skin)
      const lineMat = new THREE.MeshBasicMaterial({ color: 0x3c4046, transparent: true, opacity: 0.85, polygonOffset: true, polygonOffsetFactor: -2, side: THREE.DoubleSide });
      const halfT = (y) => (0.13 + 0.04) * (1 - 0.6 * Math.max(0, Math.min(1, (y - yRoot) / (FIN_TOP - yRoot))));
      const strip = (pts, w) => {
        for (const sd of [-1, 1]) {
          const pos = [], idx = [];
          pts.forEach(([z, y], k) => { const hx = sd * (halfT(y) + 0.006); pos.push(hx, y, z - w / 2, hx, y, z + w / 2); if (k) { const q = k * 2; idx.push(q - 2, q - 1, q, q - 1, q + 1, q); } });
          const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
          const m = new THREE.Mesh(g, lineMat); m.userData.noHit = true; ownShip.add(m);
        }
      };
      const hinge = []; for (let k = 0; k <= 10; k++) { const y = 1.9 - k * 0.29; hinge.push([-12.92 - (1.9 - y) * 0.035, y]); }
      strip(hinge, 0.03);
      strip([[-13.2, -0.35], [-13.72, -0.35]], 0.012 * 0 + 0.02); // trim-tab top edge
      strip([[-13.2, -0.35], [-13.25, -0.95]], 0.02);
      strip([[-12.4, 1.95], [-12.2, 1.2], [-12.02, 0.3], [-11.85, -0.5]], 0.012); // fin spar / panel line
    }
    // --- four engines: nacelles, cowls, props (#1 outboard port … #4 outboard stbd) ---
    const EX = [8.3, 4.3, -4.3, -8.3];
    for (let i = 0; i < 4; i++) {
      const x = EX[i], ax = Math.abs(x);
      const zf = LE(ax) + (ax < 6 ? 2.7 : 2.6), zb = TE(ax) + (ax < 6 ? 0.2 : 1.2), L = zf - zb;
      const cy = WY(ax) - 0.02;
      const prof = [[0.001, 0], [0.4, 0.02], [0.6, 0.12], [0.65, 0.45], [0.63, 1.3], [0.5, L * 0.45], [0.3, L * 0.78], [0.06, L]].map(([r, y]) => new THREE.Vector2(r, y));
      const ng2 = new THREE.LatheGeometry(prof, 14);
      ng2.rotateX(-Math.PI / 2);
      add(ng2, od, x, cy, zf);
      const cowl = add(new THREE.TorusGeometry(0.6, 0.06, 6, 18), odDark, x, cy, zf + 0.02);
      cowl.visible = true;
      add(new THREE.CircleGeometry(0.56, 16), odDark, x, cy, zf + 0.03);
      const sp = new THREE.ConeGeometry(0.17, 0.42, 10); sp.rotateX(Math.PI / 2);
      add(sp, odDark, x, cy, zf + 0.25);
      { // 1.3.6: sooty exhaust staining on the upper wing aft of the cowl
        const st = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 3.4), stainMat);
        st.rotation.x = -Math.PI / 2; st.position.set(x, WY(ax) + (0.7 + (0.24 - 0.7) * (ax / 13)) * 0.5 + 0.03, zb - 1.0);
        ownShip.add(st);
      }
      // turbo-supercharger exhaust under the nacelle
      add(new THREE.CylinderGeometry(0.12, 0.12, 0.3, 8), odDark, x, cy - 0.5, zb + 1.2);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(1.45, 32), propDiscMat);
      disc.position.set(x, cy, zf + 0.34);
      ownShip.add(disc);
      const blades = makeBlades(1.45, 0.24);
      blades.position.copy(disc.position);
      ownShip.add(blades);
      const fire = new THREE.Sprite(new THREE.SpriteMaterial({ map: flameTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.95 }));
      fire.center.set(0.5, 0.2);
      fire.position.set(x, cy + 0.6, zf - 1.3);
      fire.visible = false;
      ownShip.add(fire);
      const smokeAt = new THREE.Object3D();
      smokeAt.position.set(x, cy + 0.8, zf - 1.9);
      ownShip.add(smokeAt);
      ownEngines.push({ disc, blades, fire, smokeAt, emit: 0, spin: Math.random() * 6, wind: 0 });
    }
    // 1.3.5: self-inflicted damage — tail fire/smoke and bullet holes
    {
      const fire = new THREE.Sprite(new THREE.SpriteMaterial({ map: flameTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.95 }));
      fire.center.set(0.5, 0.15);
      fire.position.set(0, 0.9, -11.6);
      fire.visible = false;
      ownShip.add(fire);
      const smokeAt = new THREE.Object3D();
      smokeAt.position.set(0, 1.6, -12.4);
      ownShip.add(smokeAt);
      ownTail.fire = fire; ownTail.smokeAt = smokeAt;
      const hc = document.createElement("canvas"); hc.width = hc.height = 32;
      const hx = hc.getContext("2d");
      const g = hx.createRadialGradient(16, 16, 1, 16, 16, 15);
      g.addColorStop(0, "rgba(8,8,6,1)"); g.addColorStop(0.35, "rgba(20,18,14,0.95)");
      g.addColorStop(0.55, "rgba(150,140,120,0.7)"); g.addColorStop(0.75, "rgba(40,36,30,0.35)"); g.addColorStop(1, "rgba(0,0,0,0)");
      hx.fillStyle = g; hx.fillRect(0, 0, 32, 32);
      const htex = new THREE.CanvasTexture(hc);
      for (let i = 0; i < 80; i++) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: htex, transparent: true, depthWrite: false }));
        sp.visible = false;
        ownShip.add(sp);
        ownHoles.push(sp);
      }
    }
    // 1.3.8: oil streaks on a dead / burning engine — a strip draped over the nacelle top and wing
    // by raycasting down onto the rendered skin (so it lies exactly on the surface)
    {
      const oc = document.createElement("canvas"); oc.width = 64; oc.height = 256;
      const ox = oc.getContext("2d");
      for (let k = 0; k < 26; k++) {
        const x0 = 4 + Math.random() * 56, w = 1 + Math.random() * 4, len = 80 + Math.random() * 176;
        const gg = ox.createLinearGradient(0, 256, 0, 256 - len);
        const a = 0.35 + Math.random() * 0.55;
        gg.addColorStop(0, "rgba(14,11,8," + a + ")"); gg.addColorStop(0.7, "rgba(24,19,12," + a * 0.6 + ")"); gg.addColorStop(1, "rgba(24,19,12,0)");
        ox.fillStyle = gg; ox.fillRect(x0, 256 - len, w, len);
      }
      const otex = new THREE.CanvasTexture(oc); otex.colorSpace = THREE.SRGBColorSpace;
      ownShip.updateMatrixWorld(true);
      const rc = new THREE.Raycaster(), targets = [];
      ownShip.traverse((o) => { if (o.isMesh && o.material && !o.material.transparent) targets.push(o); });
      for (let i = 0; i < 4; i++) {
        const E = ownEngines[i], ex = EX[i], ax = Math.abs(ex);
        const zf = LE(ax) + (ax < 6 ? 2.7 : 2.6), zEnd = TE(ax) + 0.05;
        const NZ = 14, xs = [-0.34, 0, 0.34], pos = [], uv = [], idx = [];
        for (let a = 0; a < NZ; a++) {
          const z = zf - 0.7 - (zf - 0.7 - zEnd) * (a / (NZ - 1));
          for (let b = 0; b < 3; b++) {
            const lx = ex + xs[b];
            rc.set(new THREE.Vector3(CAM.x + lx, CAM.y + 6, CAM.z + z), new THREE.Vector3(0, -1, 0)); rc.far = 12;
            const h = rc.intersectObjects(targets, false)[0];
            const y = h ? h.point.y - CAM.y + 0.012 : WY(ax) + 0.3;
            pos.push(lx, y, z); uv.push(b / 2, 1 - a / (NZ - 1));
          }
        }
        for (let a = 0; a < NZ - 1; a++) for (let b = 0; b < 2; b++) { const q = a * 3 + b; idx.push(q, q + 3, q + 1, q + 1, q + 3, q + 4); }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); geo.setIndex(idx); geo.computeVertexNormals();
        const mat = new THREE.MeshStandardMaterial({ map: otex, transparent: true, depthWrite: false, opacity: 0, roughness: 0.18, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, side: THREE.DoubleSide });
        const oil = new THREE.Mesh(geo, mat); oil.userData.noHit = true; oil.visible = false; oil.renderOrder = 1;
        ownShip.add(oil);
        E.oil = oil; E.oilA = 0;
      }
    }
    // ===== 1.4.0: STRUCTURAL DAMAGE driven by our ship's health =====
    // Everything is placed once (seeded) by raycasting onto the rendered skin, hidden, and switched on as health
    // falls past each item's threshold: hole clusters → dents/scorch → fuel/oil streaks → torn, peeled panels →
    // missing panels; the fin and stabilizer get holes and shot-away chunks cut into their alpha maps (the sky shows
    // through). Low health adds a trailing smoke wisp (game.js adds spider cracks in the dome and a dead engine).
    (function buildOwnDamage() {
      let sd = 4242; const R = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
      const canvasTex = (w, h, draw) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); draw(x, w, h); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; };
      const jag = (x, cx, cy, r0, r1, n) => { x.beginPath(); for (let k = 0; k <= n; k++) { const a = (k / n) * Math.PI * 2, r = r0 + (r1 - r0) * R(); const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r * (0.75 + R() * 0.4); if (k) x.lineTo(px, py); else x.moveTo(px, py); } x.closePath(); };
      const soot = (x, cx, cy, r, a) => { const g = x.createRadialGradient(cx, cy, r * 0.1, cx, cy, r); g.addColorStop(0, `rgba(14,11,8,${a})`); g.addColorStop(0.55, `rgba(40,30,20,${a * 0.5})`); g.addColorStop(1, "rgba(0,0,0,0)"); x.fillStyle = g; x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill(); };
      const torn = [0, 1, 2].map(() => canvasTex(128, 128, (x) => { // torn, peeled panel: dark opening, stringers, bright curled petals
        soot(x, 64, 64, 62, 0.75);
        x.fillStyle = "rgb(190,192,188)"; jag(x, 64, 64, 30, 50, 22); x.fill();
        x.fillStyle = "rgb(12,10,9)"; jag(x, 64, 64, 18, 34, 18); x.fill();
        x.save(); x.clip(); x.strokeStyle = "rgba(120,118,108,0.8)"; x.lineWidth = 3; for (let k = 0; k < 4; k++) { const yy = 34 + k * 20; x.beginPath(); x.moveTo(20, yy); x.lineTo(108, yy + 4); x.stroke(); } x.strokeStyle = "rgba(90,88,80,0.9)"; x.lineWidth = 5; x.beginPath(); x.moveTo(62, 20); x.lineTo(66, 108); x.stroke(); x.restore();
        x.strokeStyle = "rgba(60,58,54,0.9)"; x.lineWidth = 1.2; jag(x, 64, 64, 30, 50, 22); x.stroke();
        for (let k = 0; k < 6; k++) { const a = R() * Math.PI * 2; x.strokeStyle = "rgba(230,230,225,0.8)"; x.lineWidth = 1; x.beginPath(); x.moveTo(64 + Math.cos(a) * 30, 64 + Math.sin(a) * 30); x.lineTo(64 + Math.cos(a) * 52, 64 + Math.sin(a) * 50); x.stroke(); }
      }));
      // 1.4.1: a missing panel is a TORN DARK HOLE (ragged outline, black depth, bent frame stubs catching the light,
      // curled bare-metal lips, soot) — not a neat grated bay. Three variants.
      const missingV = [0, 1, 2].map((v) => canvasTex(160, 160, (x) => {
        const C = 80;
        soot(x, C + (R() - 0.5) * 10, C + (R() - 0.5) * 10, 78, 0.7);
        // ragged outline: many points, big random bites, a few long tears
        const n = 34, pts = [];
        for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2; let r = 38 + R() * 16; if (R() < 0.18) r += 12 + R() * 16; if (R() < 0.12) r -= 12; pts.push([C + Math.cos(a) * r * (1.05 - v * 0.08), C + Math.sin(a) * r * (0.78 + v * 0.1)]); }
        // torn bare-aluminium lip (bright, jagged) just outside the hole
        x.beginPath(); pts.forEach(([px, py], k) => { const ex = C + (px - C) * 1.14 + (R() - 0.5) * 5, ey = C + (py - C) * 1.14 + (R() - 0.5) * 5; if (k) x.lineTo(ex, ey); else x.moveTo(ex, ey); }); x.closePath();
        const lg = x.createLinearGradient(20, 20, 140, 140); lg.addColorStop(0, "rgb(206,208,204)"); lg.addColorStop(0.5, "rgb(140,142,138)"); lg.addColorStop(1, "rgb(92,92,88)"); x.fillStyle = lg; x.fill();
        // the hole: near-black with a faint depth gradient toward one side (interior structure far below)
        x.beginPath(); pts.forEach(([px, py], k) => { if (k) x.lineTo(px, py); else x.moveTo(px, py); }); x.closePath();
        const hg = x.createRadialGradient(C + 10, C + 12, 4, C, C, 58); hg.addColorStop(0, "rgb(4,4,4)"); hg.addColorStop(0.7, "rgb(10,9,8)"); hg.addColorStop(1, "rgb(26,23,20)"); x.fillStyle = hg; x.fill();
        x.save(); x.clip();
        // a bent frame stub and a broken stringer crossing the opening, lit on one edge
        for (let k = 0; k < 2; k++) {
          const y0 = C - 30 + R() * 60, y1 = y0 + (R() - 0.5) * 40, xe = C + (R() - 0.2) * 50;
          x.strokeStyle = "rgba(70,68,62,0.95)"; x.lineWidth = 5 - k * 2; x.beginPath(); x.moveTo(C - 70, y0); x.quadraticCurveTo(C - 10, y0 + 8, xe, y1); x.stroke();
          x.strokeStyle = "rgba(170,168,160,0.55)"; x.lineWidth = 1.2; x.beginPath(); x.moveTo(C - 70, y0 - 2); x.quadraticCurveTo(C - 10, y0 + 6, xe, y1 - 2); x.stroke();
        }
        // wiring / hydraulic line dangling
        x.strokeStyle = "rgba(95,60,40,0.8)"; x.lineWidth = 1.6; x.beginPath(); x.moveTo(C - 40, C - 40); x.bezierCurveTo(C - 20, C + 10, C + 5, C - 5, C + 18, C + 30); x.stroke();
        x.restore();
        // curled petals of skin bent outward at the tears
        for (let k = 0; k < 6; k++) { const j = (R() * n) | 0, [px, py] = pts[j], dx = px - C, dy = py - C, l = Math.hypot(dx, dy) || 1; x.fillStyle = k % 2 ? "rgb(196,198,194)" : "rgb(120,122,118)"; x.beginPath(); x.moveTo(px - dy / l * 6, py + dx / l * 6); x.lineTo(px + dx / l * (12 + R() * 12), py + dy / l * (12 + R() * 12)); x.lineTo(px + dy / l * 6, py - dx / l * 6); x.closePath(); x.fill(); }
        // dark hairline edge + a few rivet holes along what is left of the seams
        x.strokeStyle = "rgba(20,18,16,0.9)"; x.lineWidth = 1.4; x.beginPath(); pts.forEach(([px, py], k) => { if (k) x.lineTo(px, py); else x.moveTo(px, py); }); x.closePath(); x.stroke();
        x.fillStyle = "rgba(15,14,12,0.85)"; for (let k = 0; k < 14; k++) { const a = R() * Math.PI * 2, r = 62 + R() * 8; x.fillRect(C + Math.cos(a) * r, C + Math.sin(a) * r * 0.85, 2, 2); }
      }));
      const scorch = [0, 1].map(() => canvasTex(128, 128, (x) => { // dent + scorched paint
        soot(x, 64, 64, 60, 0.7); soot(x, 58 + R() * 12, 60 + R() * 12, 30, 0.6);
        for (let k = 0; k < 5; k++) soot(x, 64 + (R() - 0.5) * 50, 64 + (R() - 0.5) * 50, 14 + R() * 16, 0.45); // blotchy, no ring
        const g = x.createRadialGradient(54, 52, 2, 64, 64, 34); g.addColorStop(0, "rgba(255,255,255,0.18)"); g.addColorStop(0.5, "rgba(0,0,0,0.25)"); g.addColorStop(1, "rgba(0,0,0,0)"); x.fillStyle = g; x.beginPath(); x.arc(64, 64, 34, 0, Math.PI * 2); x.fill();
      }));
      const streak = canvasTex(64, 256, (x) => { // fuel / oil streaks trailing aft (texture +v = aft)
        for (let k = 0; k < 18; k++) { const x0 = 6 + R() * 52, w = 1 + R() * 4, len = 90 + R() * 160; const g = x.createLinearGradient(0, 0, 0, len); const a = 0.3 + R() * 0.5, oil = R() < 0.6; g.addColorStop(0, `rgba(${oil ? 16 : 70},${oil ? 12 : 52},${oil ? 8 : 26},${a})`); g.addColorStop(1, "rgba(20,16,10,0)"); x.fillStyle = g; x.fillRect(x0, 0, w, len); }
        soot(x, 32, 14, 16, 0.8);
      });
      const decalMat = (map, dw) => new THREE.MeshStandardMaterial({ map, transparent: true, alphaTest: 0.03, depthWrite: false, roughness: 0.6, metalness: 0.3, polygonOffset: true, polygonOffsetFactor: dw || -4, polygonOffsetUnits: -4, side: THREE.DoubleSide });
      const mats = { torn: torn.map((t) => decalMat(t)), missing: missingV.map((t) => decalMat(t, -5)), scorch: scorch.map((t) => decalMat(t, -3)), streak: [decalMat(streak, -3)] };
      ownShip.updateMatrixWorld(true);
      const rc = new THREE.Raycaster(), targets = [];
      ownShip.traverse((o) => { if (o.isMesh && o.material && !o.userData.noHit && (Array.isArray(o.material) || !o.material.transparent) && o.material !== propDiscMat) targets.push(o); });
      const O = new THREE.Vector3(CAM.x, CAM.y, CAM.z);
      const cast = (ox, oy, oz, dx, dy, dz) => { rc.set(new THREE.Vector3(ox, oy, oz).add(O), new THREE.Vector3(dx, dy, dz).normalize()); rc.far = 20; const h = rc.intersectObjects(targets, false)[0]; if (!h) return null; const n = h.face.normal.clone().transformDirection(h.object.matrixWorld); if (n.dot(rc.ray.direction) > 0) n.negate(); return { p: h.point.clone().sub(O), n, part: h.object.userData.part || null }; };
      const pickSurf = (where) => {
        for (let tries = 0; tries < 12; tries++) {
          let h = null;
          if (where === "spine") h = cast((R() - 0.5) * 1.0, 3, -1.3 - R() * 7.5, 0, -1, 0);
          else if (where === "spineOff") { const sg = R() < 0.5 ? -1 : 1; h = cast(sg * (0.5 + R() * 0.35), 3, -1.6 - R() * 7.2, 0, -1, 0); } // 1.4.1: off the aft spine centre line
          else if (where === "side") { const sg = R() < 0.5 ? -1 : 1; const z = -1.5 - R() * 8; h = cast(sg * 3, topAt(z) - 0.25 - R() * 0.35, z, -sg, -0.2, 0); }
          else if (where === "wing") { const sg = R() < 0.5 ? -1 : 1, ax = 1.6 + R() * 8.5; h = cast(sg * ax, 3, TE(ax) + 0.3 + R() * (LE(ax) - TE(ax) - 0.7), 0, -1, 0); }
          else if (where === "nacelle") { const i = (R() * 4) | 0, ex = EX[i], ax = Math.abs(ex); h = cast(ex + (R() - 0.5) * 0.5, 3, LE(ax) + 0.6 + R() * 1.4, 0, -1, 0); }
          else if (where === "stab") { const sg = R() < 0.5 ? -1 : 1; h = cast(sg * (0.9 + R() * 4.2), 3, -11.2 - R() * 1.9, 0, -1, 0); }
          else if (where === "fin") { const sg = R() < 0.5 ? -1 : 1; h = cast(sg * 3, -0.7 + R() * 2.4, -11.4 - R() * 2.0, -sg, 0, 0); }
          if (h) return h;
        }
        return null;
      };
      const _q = new THREE.Quaternion(), _z = new THREE.Vector3(0, 0, 1);
      const place = (mat, h, w, l, th, alongFlow) => {
        const m = new THREE.Mesh(holeGeo, mat); m.userData.decal = true; m.userData.noHit = true; m.renderOrder = 2;
        m.position.copy(h.p).addScaledVector(h.n, 0.008);
        if (alongFlow) { // texture +v runs aft: local Y = −(aft projected on the surface), local Z = normal
          const aft = new THREE.Vector3(0, 0, -1); aft.addScaledVector(h.n, -aft.dot(h.n)).normalize();
          const yv = aft.clone().negate(), xv = new THREE.Vector3().crossVectors(yv, h.n).normalize();
          m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xv, yv, h.n));
          m.position.addScaledVector(aft, l * 0.45);
        } else { _q.setFromUnitVectors(_z, h.n); m.quaternion.copy(_q); m.rotateZ(R() * Math.PI * 2); }
        m.scale.set(w, l, 1); m.visible = false; ownShip.add(m);
        ownDmg.items.push({ th, obj: m });
        return m;
      };
      const where = (w) => { const r = R(); for (const [k, p] of w) { if (r < p) return k; } return w[w.length - 1][0]; };
      const WH = [["spine", 0.5], ["side", 0.58], ["wing", 0.85], ["nacelle", 0.92], ["stab", 1]];
      // hole clusters: 22, from the first hits down to the wreck
      for (let i = 0; i < 30; i++) {
        const h = pickSurf(where(WH)); if (!h) continue;
        const th = 97 - i * 3.2, n = 6 + ((R() * 9) | 0);
        for (let k = 0; k < n; k++) {
          const hh = { p: h.p.clone(), n: h.n.clone() };
          const t1 = new THREE.Vector3(1, 0, 0).cross(h.n); if (t1.lengthSq() < 0.01) t1.set(0, 0, 1).cross(h.n); t1.normalize(); const t2 = new THREE.Vector3().crossVectors(h.n, t1);
          const rr = 0.5 * Math.sqrt(R()), a = R() * Math.PI * 2; hh.p.addScaledVector(t1, Math.cos(a) * rr).addScaledVector(t2, Math.sin(a) * rr);
          const s2 = 0.09 + R() * 0.11; place(holeTexs[(R() * 4) | 0], hh, s2, s2 * (0.8 + R() * 0.4), th - k * 0.4, false);
        }
      }
      for (let i = 0; i < 14; i++) { const h = pickSurf(where([["spine", 0.3], ["side", 0.4], ["wing", 0.85], ["nacelle", 1]])); if (h) { const s2 = 0.6 + R() * 0.9; place(mats.scorch[i % 2], h, s2, s2, 84 - i * 5.5, false); } }
      for (let i = 0; i < 6; i++) { const h = pickSurf(where([["wing", 0.55], ["nacelle", 0.8], ["spine", 1]])); if (h) place(mats.streak[0], h, 0.3 + R() * 0.25, 1.8 + R() * 1.6, 58 - i * 9, true); }
      for (let i = 0; i < 13; i++) { // torn, peeled panels + a curled flap of bare skin standing proud
        const h = pickSurf(where([["spineOff", 0.3], ["side", 0.4], ["wing", 0.88], ["stab", 1]])); if (!h) continue;
        const s2 = 0.42 + R() * 0.4, th = 68 - i * 5.1;
        place(mats.torn[i % 3], h, s2, s2 * (0.8 + R() * 0.4), th, false);
        const fg3 = new THREE.PlaneGeometry(s2 * 0.55, s2 * 0.45, 4, 4); const fp = fg3.attributes.position;
        for (let k = 0; k < fp.count; k++) { const yy = fp.getY(k) / (s2 * 0.45) + 0.5; fp.setZ(k, yy * yy * s2 * 0.35); }
        fg3.computeVertexNormals();
        const flap = new THREE.Mesh(fg3, new THREE.MeshStandardMaterial({ color: 0xbfc3c6, roughness: 0.3, metalness: 0.85, envMapIntensity: 1.0, side: THREE.DoubleSide }));
        flap.userData.noHit = true;
        const t1 = new THREE.Vector3(0, 0, 1).cross(h.n); if (t1.lengthSq() < 0.01) t1.set(1, 0, 0); t1.normalize();
        flap.position.copy(h.p).addScaledVector(h.n, 0.01).addScaledVector(new THREE.Vector3().crossVectors(h.n, t1), s2 * 0.3);
        flap.quaternion.setFromUnitVectors(_z, h.n); flap.rotateX(-0.9 - R() * 0.5); flap.rotateZ((R() - 0.5) * 0.8);
        flap.visible = false; ownShip.add(flap); ownDmg.items.push({ th: th - 2, obj: flap });
      }
      for (let i = 0; i < 10; i++) { const h = pickSurf(where([["spineOff", 0.3], ["side", 0.45], ["wing", 1]])); if (h) { const s2 = 0.5 + R() * 0.4; place(mats.missing[i % 3], h, s2, s2 * (0.7 + R() * 0.3), 48 - i * 4.6, false); } }
      // fin + stabilizer: holes and shot-away chunks in the cut maps (shape coords: fin (z, y), stab (x, z))
      const fc = ownDmg.cuts[1], scm = ownDmg.cuts[0];
      const holesEv = (cm, th, cx, cy, spread, n, r) => { const pts = []; for (let k = 0; k < n; k++) pts.push([cx + (R() - 0.5) * spread, cy + (R() - 0.5) * spread, r * (0.6 + R() * 0.8)]); cm.events.push({ th, draw: (x) => { for (const [a, b, rr] of pts) { x.beginPath(); x.arc(cm.px(a), cm.py(b), rr, 0, Math.PI * 2); x.fill(); } } }); };
      const chunkEv = (cm, th, poly) => { const pp = poly.map(([a, b]) => [a + (R() - 0.5) * 0.12, b + (R() - 0.5) * 0.12]); cm.events.push({ th, draw: (x) => { x.beginPath(); pp.forEach(([a, b], k) => { const X = cm.px(a), Y = cm.py(b); if (k) x.lineTo(X, Y); else x.moveTo(X, Y); }); x.closePath(); x.fill(); } }); };
      holesEv(fc, 88, -12.3, 0.9, 0.9, 7, 5); holesEv(fc, 72, -12.9, 0.1, 0.8, 8, 5.5); holesEv(fc, 55, -11.9, 1.4, 0.6, 7, 5); holesEv(fc, 38, -13.3, 1.1, 0.7, 9, 6); holesEv(fc, 20, -12.5, -0.4, 1.0, 11, 6.5);
      holesEv(scm, 80, 3.2, -11.9, 1.2, 9, 6); holesEv(scm, 62, -2.6, -12.2, 1.2, 10, 6); holesEv(scm, 44, -4.3, -12.6, 1.0, 9, 7); holesEv(scm, 26, 1.8, -12.9, 1.2, 11, 7.5); holesEv(scm, 14, -1.5, -11.6, 1.4, 12, 8);
      chunkEv(fc, 32, [[-13.0, 2.2], [-12.55, 1.62], [-12.9, 1.28], [-13.35, 1.5], [-13.7, 1.3], [-13.9, 2.2]]);     // top of the rudder shot away
      chunkEv(scm, 22, [[5.9, -12.1], [4.9, -12.35], [4.6, -12.8], [5.05, -13.05], [4.75, -13.45], [5.9, -13.6]]);   // port stab tip gone
      chunkEv(fc, 12, [[-13.9, 0.9], [-13.5, 0.75], [-13.3, 0.1], [-13.62, -0.3], [-13.3, -0.62], [-14.0, -0.8]]);  // rudder trailing edge torn out
      chunkEv(scm, 8, [[-5.9, -12.9], [-5.3, -12.75], [-4.9, -13.1], [-5.2, -13.6], [-5.9, -13.6]]);                // starboard elevator tip
      chunkEv(fc, 16, [[-11.4, 2.3], [-11.6, 1.62], [-11.95, 1.78], [-12.3, 1.42], [-12.7, 1.66], [-13.0, 1.5], [-13.4, 1.72], [-14.0, 1.55], [-14.0, 2.3]]); // the fin tip shot off (silhouette drops edge-on)
      chunkEv(fc, 4, [[-11.2, 2.3], [-11.3, 1.2], [-11.7, 1.28], [-12.1, 0.95], [-12.5, 1.25], [-12.9, 1.02], [-13.3, 1.3], [-14.0, 1.1], [-14.0, 2.3]]);  // …and most of the top third
      // skin torn up and standing proud of the fin + stab (reads edge-on from the turret, where cut-outs can't)
      const flapM = new THREE.MeshStandardMaterial({ color: 0xc4c8cc, roughness: 0.3, metalness: 0.85, envMap: aluEnv, envMapIntensity: 1.0, side: THREE.DoubleSide });
      const petal = (th, x, y, z, nx, s2, rz) => {
        const g = new THREE.PlaneGeometry(s2, s2 * 0.8, 3, 3); const fp = g.attributes.position;
        for (let k = 0; k < fp.count; k++) { const yy = fp.getY(k) / (s2 * 0.8) + 0.5, xx = fp.getX(k) / s2; fp.setZ(k, yy * yy * s2 * 0.5); fp.setX(k, fp.getX(k) * (1 - 0.5 * yy) + xx * 0.02); }
        g.computeVertexNormals();
        const m = new THREE.Mesh(g, flapM); m.userData.noHit = true;
        m.position.set(x, y, z); m.quaternion.setFromUnitVectors(_z, new THREE.Vector3(nx[0], nx[1], nx[2]).normalize()); m.rotateX(-1.0); m.rotateZ(rz);
        m.visible = false; ownShip.add(m); ownDmg.items.push({ th, obj: m });
      };
      petal(52, 0.12, 0.9, -12.2, [1, 0, 0], 0.32, 0.4); petal(34, -0.12, 0.35, -12.9, [-1, 0, 0], 0.4, -0.6); petal(18, 0.11, 1.35, -11.95, [1, 0, 0], 0.36, 2.2);
      petal(9, -0.1, -0.2, -12.4, [-1, 0, 0], 0.46, 1.1); petal(40, 2.7, -1.25, -12.1, [0, 1, 0], 0.42, 0.9); petal(24, -3.4, -1.25, -12.5, [0, 1, 0], 0.5, -1.4);
      // trailing smoke wisp source (aft spine, above the radio room)
      const wsp = new THREE.Object3D(); wsp.position.set(0.25, topAt(-5.2) + 0.05, -5.2); ownShip.add(wsp); ownDmg.wisp = wsp;
    })();
    ownShip.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  })();
  const _ov = new THREE.Vector3();
  const _fallE = new THREE.Euler();
  // ===== 1.4.1: BOMBS AWAY — sticks of 500-lb GP bombs falling out of every bay (box frame: they keep the box's
  // speed at first, then drag pulls them back and they nose over as they pick up speed) =====
  const BOMB_N = 200;
  const bombGeo = (() => {
    const body = new THREE.CylinderGeometry(0.17, 0.17, 0.95, 10); body.rotateX(Math.PI / 2);
    const nose = new THREE.SphereGeometry(0.17, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2); nose.rotateX(Math.PI / 2); nose.scale(1, 1, 1.9); nose.translate(0, 0, 0.475);
    const tail = new THREE.CylinderGeometry(0.17, 0.06, 0.42, 10); tail.rotateX(-Math.PI / 2); tail.translate(0, 0, -0.68);
    const fin1 = new THREE.BoxGeometry(0.5, 0.02, 0.3); fin1.translate(0, 0, -0.78);
    const fin2 = new THREE.BoxGeometry(0.02, 0.5, 0.3); fin2.translate(0, 0, -0.78);
    const parts = [body, nose, tail, fin1, fin2].map((g) => g.index ? g.toNonIndexed() : g);
    let n = 0; for (const g of parts) n += g.attributes.position.count;
    const P = new Float32Array(n * 3), N = new Float32Array(n * 3); let o = 0;
    for (const g of parts) { g.computeVertexNormals(); P.set(g.attributes.position.array, o * 3); N.set(g.attributes.normal.array, o * 3); o += g.attributes.position.count; }
    const G2 = new THREE.BufferGeometry(); G2.setAttribute("position", new THREE.BufferAttribute(P, 3)); G2.setAttribute("normal", new THREE.BufferAttribute(N, 3)); return G2;
  })();
  const bombMesh = new THREE.InstancedMesh(bombGeo, new THREE.MeshStandardMaterial({ color: 0x2a2c22, roughness: 0.65, metalness: 0.25 }), BOMB_N);
  bombMesh.count = 0; bombMesh.frustumCulled = false; scene.add(bombMesh);
  // 1.5.3: faint vertical streak above each falling bomb (slight motion blur once it is moving fast) — one instanced mesh, one draw
  const bombStreak = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.08, 0.18, 1, 5, 1, true), new THREE.MeshBasicMaterial({ color: 0xc8c4b8, transparent: true, opacity: 0.38, depthWrite: false, side: THREE.DoubleSide }), BOMB_N); // 1.6.1: more visible fall streak
  bombStreak.count = 0; bombStreak.frustumCulled = false; scene.add(bombStreak);
  const BOMB_G = 5.013, BOMB_AZ = 0.18, BOMB_CZ = 0.0016, BOMB_SPACING = 0.34; // 1.6.0: g 6.54 → 5.013 (drag-slowed fall: ~45 s from 25,000 ft instead of 39 s), 0.34 s between bombs of a stick (was 0.12) so a stick is a visible LINE of explosions; // 1.5.8: g = 9.81 m/s² at 1.5 m/u; from 25,000 ft (5,080 u) a stick reaches the ground ~39 s after release (was ~24 s from 1,400 u); it trails the airframe (drag) by BOMB_AZ·t² + BOMB_CZ·t³
  const _tw = new THREE.Vector3();
  let _geoNow = { x: 0, z: 0, rot: 0 };
  const bombs = []; const bombStats = { live: 0, dropped: 0 };
  const _bsq = new THREE.Quaternion(), _bss = new THREE.Vector3(), _bsp = new THREE.Vector3();
  const _bm = new THREE.Matrix4(), _bq = new THREE.Quaternion(), _bs = new THREE.Vector3(1.3, 1.3, 1.3), _bp = new THREE.Vector3(), _be = new THREE.Euler();
  function dropBombs(list) {
    for (const st of list) {
      for (let k = 0; k < st.n && bombs.length < BOMB_N; k++) { // a stick: one after another, ~0.12 s apart, out of alternate sides of the bay
        bombs.push({ ph: Math.random() * 6.28, x0: st.x + (k % 2 ? 0.28 : -0.28), y0: st.y + (k % 3) * 0.12, z0: st.z + (st.own ? 0 : 0.3), t: -(st.delay + k * BOMB_SPACING), yawJ: (Math.random() - 0.5) * 0.1, rollS: (Math.random() - 0.5) * 1.2, lead: st.lead, own: !!st.own });
        bombStats.dropped++;
      }
    }
  }
  function updateBombs(dt) {
    let n = 0;
    for (let i = bombs.length - 1; i >= 0; i--) { const b = bombs[i]; b.t += dt; if (b.t > 90 || (b.landed && (b.landAge = (b.landAge || 0) + dt) > 2.5)) bombs.splice(i, 1); }
    for (const b of bombs) {
      if (b.t < 0 || n >= BOMB_N) continue;
      if (b.landed) continue; // keep in array briefly for stats; not drawn
      const t = b.t;
      { // 1.5.8/1.6.1: fixed in the GROUND frame — same model as game.js tgtStep. Release x0/y0/z0 must already be on the geo track (game.js undoes straggler camera offset).
        const G0 = _geoNow, ca = Math.cos(G0.rot || 0), sa = Math.sin(G0.rot || 0), lagf = (q) => BOMB_AZ * q * q + BOMB_CZ * q * q * q;
        if (b.gx == null) { const dx = b.x0 - G0.x, dz = b.z0 - G0.z; b.gx = dx * ca - dz * sa; b.gz = dx * sa + dz * ca; b.t0 = t; b.yaw0 = G0.rot || 0; }
        const gz = b.gz + AIR_DRIFT * (t - b.t0) - lagf(t) + lagf(b.t0);
        _bp.set(G0.x + b.gx * ca + gz * sa, b.y0 - 0.5 * BOMB_G * t * t, G0.z - b.gx * sa + gz * ca); }
      town.getWorldPosition(_tw);
      if (_bp.y <= _tw.y + 0.5) { b.landed = true; b.landAge = 0; (bombStats.land || (bombStats.land = [])).push({ x: +_bp.x.toFixed(1), z: +_bp.z.toFixed(1), dx: Math.round(_bp.x - _tw.x), dz: Math.round(_bp.z - _tw.z), t: +t.toFixed(1), own: !!b.own, lead: !!b.lead, y0: +b.y0.toFixed(1) }); continue; }
      const vy = -BOMB_G * t, vz = -2 * BOMB_AZ * t - 3 * BOMB_CZ * t * t;
      const pitch = Math.atan2(-vy, 53.6 + Math.max(0, -vz) * 0.2) * Math.min(1, t / 2.5) + 0.05;
      const wob = Math.min(1, t / 1.2) * 0.07;
      _be.set(pitch + Math.sin(t * 2.7 + b.ph) * wob, (b.yaw0 != null ? b.yaw0 : (_geoNow.rot || 0)) + b.yawJ + Math.cos(t * 2.1 + b.ph) * wob, b.rollS * t * 0.3, "YXZ"); _bq.setFromEuler(_be);
      // 1.6.1: scale more aggressively so sticks stay readable from a straggler several km back / looking down
      { const dd = camera.position.distanceTo(_bp), sc = Math.max(2.0, dd / 280); _bs.set(sc, sc, sc); } _bm.compose(_bp, _bq, _bs); bombMesh.setMatrixAt(n, _bm);
      const sl = Math.min(22, Math.max(0, (-vy - 4) * 0.35)); // longer streak
      if (sl > 0.4) { _bsq.identity(); _bss.set(1.6, sl, 1.6); _bsp.set(_bp.x, _bp.y + sl * 0.5, _bp.z); _bm.compose(_bsp, _bsq, _bss); } else { _bss.set(0.0001, 0.0001, 0.0001); _bm.compose(_bp, _bsq.identity(), _bss); }
      bombStreak.setMatrixAt(n, _bm); n++;
      b._wx = _bp.x; b._wy = _bp.y; b._wz = _bp.z;
    }
    bombMesh.count = n; bombMesh.instanceMatrix.needsUpdate = true; bombStats.live = n;
    bombStreak.count = n; bombStreak.instanceMatrix.needsUpdate = true;
  }
  // ===== 1.4.1: OUR OWN B-17 GOING DOWN, seen from the chute =====
  // Big wing-root and engine fires, a thick black smoke trail left in the air mass, and ~6.5 s after we get out
  // the tail tears off (fin + stabilizer thrown clear, tumbling, with a burst of debris and its own smoke).
  const wreck = { fires: [], srcs: [], tail: null, parts: [], emit: 0, on: false, last: [null, null, null], wing: null, wingHid: [], wingSide: 0, moved: [] }; // 1.5.9: moved = effect anchors re-parented onto a detached piece (put back on a reset)
  {
    // four fire sources (wing roots, inboard engines), each a flame on top of the wing plus a streaming tongue aft
    // and a glow under the wing; the smoke comes from the top flame
    const srcDef = [[1.9, -0.7, 1.0], [-1.9, -0.9, 0.9], [4.3, 0.6, 0.85], [-4.3, 0.4, 0.75]];
    for (const [x, zOff, s] of srcDef) {
      const ax = Math.abs(x), wy = -2.35 + ax * 0.0787, zb = (1.6 - (ax - 1) * (2.0 / 12)) - 3.2;
      const top = wy + (ax < 3 ? 0.55 : 0.75);
      const src = new THREE.Object3D(); src.position.set(x, top, zb + zOff); ownShip.add(src); wreck.srcs.push(src);
      for (let k = 0; k < 4; k++) {
        const f = new THREE.Sprite(new THREE.SpriteMaterial({ map: fireTex, color: k === 3 ? 0xff7a30 : 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.95 }));
        if (k < 3) f.position.set(x + (k ? (Math.random() - 0.5) * 0.3 : 0), top + k * 0.25, zb + zOff - k * 1.9);
        else f.position.set(x, wy - 0.45, zb + zOff - 0.6);
        f.visible = false; f.userData.s = s * (k === 0 ? 1.15 : k === 3 ? 0.9 : 1 - k * 0.22); f.renderOrder = 3; ownShip.add(f); wreck.fires.push(f);
      }
    }
  }
  // thick black smoke: billboard puffs left behind in the air mass (a camera-facing ribbon goes edge-on when we look
  // straight down the trail from the chute — 1.4.1 first try read as brown stripes)
  const WP_N = 460, wpPool = [];
  const wpTex = (() => {
    const c = document.createElement("canvas"); c.width = c.height = 128; const x = c.getContext("2d");
    let sd = 31; const R = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
    for (let k = 0; k < 26; k++) { const px = 64 + (R() - 0.5) * 56, py = 64 + (R() - 0.5) * 56, r = 16 + R() * 26; const g = x.createRadialGradient(px, py, 0, px, py, r); g.addColorStop(0, "rgba(255,255,255," + (0.35 + R() * 0.3) + ")"); g.addColorStop(1, "rgba(255,255,255,0)"); x.fillStyle = g; x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill(); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  for (let i = 0; i < WP_N; i++) { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: wpTex, color: 0x121110, transparent: true, depthWrite: false, opacity: 0 })); sp.visible = false; scene.add(sp); wpPool.push({ sp, age: 0, life: 0, s0: 1, s1: 10, a: 0.8, rot: 0 }); }
  let wpIdx = 0;
  function wpEmit(pos, o) { const p = wpPool[wpIdx]; wpIdx = (wpIdx + 1) % WP_N; p.sp.position.copy(pos); p.age = 0; p.life = o.life * (0.85 + Math.random() * 0.3); p.s0 = o.s0; p.s1 = o.s1 * (0.8 + Math.random() * 0.4); p.a = o.a; p.sp.material.color.setHex(o.col); p.sp.material.rotation = Math.random() * 6.28; p.sp.visible = true; }
  const wpStats = { live: 0 };
  function updateWreckPuffs(dt) {
    let live = 0;
    for (const p of wpPool) {
      if (!p.sp.visible) continue;
      p.age += dt; if (p.age >= p.life) { p.sp.visible = false; continue; }
      live++; const k = p.age / p.life;
      p.sp.position.z -= AIR_DRIFT * dt; p.sp.position.y += 0.6 * dt;
      const sc = p.s0 + (p.s1 - p.s0) * Math.sqrt(k); p.sp.scale.set(sc, sc, 1);
      p.sp.material.opacity = p.a * Math.pow(1 - k, 1.2) * Math.min(1, p.age * 4 + 0.3);
    }
    wpStats.live = live;
  }
  const _wpA = new THREE.Vector3();
  // lay puffs along the path since the last emission, <= step apart, so the trail is continuous at any frame rate
  function wpTrail(slot, pos, step, o) {
    const L = wreck.last[slot];
    if (!L) { wreck.last[slot] = pos.clone(); wpEmit(pos, o); return; }
    L.z -= AIR_DRIFT * o._dt; // the previous point has drifted with the air mass
    const d = L.distanceTo(pos), n = Math.min(8, Math.floor(d / step));
    for (let i = 1; i <= n; i++) { _wpA.lerpVectors(L, pos, i / n); _wpA.x += (Math.random() - 0.5) * 1.2; _wpA.y += (Math.random() - 0.5) * 1.2; wpEmit(_wpA, o); }
    if (n > 0 || d > step * 8) L.copy(pos);
  }
  function updateOwnWreck(FALL, rdt) {
    const S = FALL && FALL.ship;
    const on = !!(S && (FALL.phase === "chute" || (FALL.phase === "fall" && (S.burn || 0) > 0)));
    if (!S) { // back to normal: re-attach the tail, clear the pieces
      if (wreck.on || wreck.tail || wreck.wing) {
        for (const o of wreck.moved) ownShip.add(o); // 1.5.9: fires / smoke sources / engine-out effects ride their piece; back on the airframe (local positions are unchanged)
        wreck.moved.length = 0;
        for (const q of wreck.wingHid) q.visible = true;
        wreck.wingHid.length = 0; if (wreck.wing) scene.remove(wreck.wing); wreck.wing = null; wreck.wingSide = 0;
        for (const E of ownEngines) E.gone = false;
        for (const q of wreck.parts) q.orig.visible = true;
        if (wreck.tail) scene.remove(wreck.tail);
        wreck.tail = null; wreck.parts.length = 0;
        for (const f of wreck.fires) f.visible = false;
        wreck.last = [null, null, null];
      }
      wreck.on = false; return;
    }
    wreck.on = on;
    const burn = S.burn || 0;
    const fl = 0.8 + 0.2 * Math.sin(pnow() * 0.013);
    for (const f of wreck.fires) {
      f.visible = on && burn > 0;
      if (f.visible) { const k = (2.4 + burn * 3.0) * f.userData.s * (0.8 + Math.random() * 0.4) * fl; f.scale.set(k * 0.85, k * (1.2 + Math.random() * 0.6), 1); f.material.opacity = 0.7 + Math.random() * 0.3; }
    }
    if (on && burn > 0) { // two thick black columns from the wing roots, a thinner grey-black one from the port engine
      const dtE = Math.min(0.25, rdt);
      for (let i = 0; i < 2; i++) { // one thick column per wing root (puffs laid ~3 u apart: ~120 live per column)
        wreck.srcs[i].getWorldPosition(_ov);
        wpTrail(i, _ov, 3.0, { _dt: dtE, life: 10, s0: 4.6, s1: 26 + burn * 8, a: 0.8, col: i ? 0x151311 : 0x0e0d0c });
      }
    }
    if (S.wingOff && !wreck.wing) { // 1.5.2: a wing folds at the root and tears away
      const side = S.wingOff > 0 ? 1 : -1; wreck.wingSide = side;
      const wgp = new THREE.Group(); wgp.position.copy(ownShip.position); wgp.quaternion.copy(ownShip.quaternion);
      const sphC = (o) => { if (o.geometry) { if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere(); return { x: o.geometry.boundingSphere.center.x * (o.scale.x || 1) + o.position.x, z: o.geometry.boundingSphere.center.z + o.position.z }; } return { x: o.position.x, z: o.position.z }; };
      for (const o of ownShip.children) {
        if (!o.visible || o.isSprite || o.userData.part === "fin" || o.userData.part === "stab") continue;
        if (!(o.isMesh || o.isGroup)) continue;
        let on = o.userData.wingSide === side;
        if (!on && o.userData.wingSide == null) { const c = sphC(o); on = c.x * side > 1.9 && c.z > -8.5 && c.z < 7 && (!o.geometry || !o.geometry.boundingSphere || o.geometry.boundingSphere.radius < 9); }
        if (!on) continue;
        const c2 = o.clone(); wgp.add(c2); o.visible = false; wreck.wingHid.push(o);
      }
      for (let i = 0; i < 4; i++) { if ((ownEngines[i].disc.position.x) * side > 0) { ownEngines[i].gone = true; ownEngines[i].disc.visible = false; ownEngines[i].blades.visible = false; ownEngines[i].fire.visible = false; } }
      const wf = new THREE.Sprite(new THREE.SpriteMaterial({ map: fireTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.9 })); wf.position.set(side * 3.0, 0.7, -0.6); wf.scale.set(5, 6.5, 1); wgp.add(wf);
      const wf2 = new THREE.Sprite(new THREE.SpriteMaterial({ map: fireTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.8 })); wf2.position.set(side * 8, 0.5, -0.9); wf2.scale.set(3.5, 4.5, 1); wgp.add(wf2);
      wgp.userData = { vx: side * 13 + (Math.random() - 0.5) * 3, vy: 3 + Math.random() * 3, vz: -9, wx: (Math.random() - 0.5) * 0.8, wy: (Math.random() - 0.5) * 1.0, wz: side * (1.6 + Math.random() * 1.2), fire: wf, fire2: wf2, t: 0, lastP: null, lastQ: null };
      scene.add(wgp); wreck.wing = wgp;
      { // 1.5.9: every fire / smoke source / engine-out effect on the severed side now belongs to the wing piece (wgp starts exactly on the ship's frame, so the local positions carry over)
        const mv = (o) => { if (o && o.parent === ownShip) { wgp.add(o); wreck.moved.push(o); } };
        for (let i = 0; i < wreck.srcs.length; i++) if (wreck.srcs[i].position.x * side > 0) { mv(wreck.srcs[i]); for (let k = 0; k < 4; k++) mv(wreck.fires[i * 4 + k]); }
        for (let i = 0; i < 4; i++) if (ownEngines[i].disc.position.x * side > 0) { mv(ownEngines[i].fire); mv(ownEngines[i].smokeAt); }
      }
      _ov.set(side * 1.6, -2, -1.2).applyMatrix4(ownShip.matrixWorld);
      spawnDebris(_ov.x, _ov.y, _ov.z, 90, 0.7); spawnDebris(_ov.x, _ov.y, _ov.z, 40, 1.2);
      emitSmoke(_ov, true, true);
    }
    if (wreck.wing) { // the severed wing: tumbles away on fire, trailing black smoke; the stub on the fuselage burns too
      const T = wreck.wing, u = T.userData, dt = Math.min(0.05, rdt), side = wreck.wingSide;
      u.t += dt; u.vy -= 7.5 * dt; u.vy = Math.max(u.vy, -62); u.vx *= Math.pow(0.8, dt); u.vz += (-AIR_DRIFT - u.vz) * Math.min(1, 0.3 * dt);
      T.position.x += u.vx * dt; T.position.y += u.vy * dt; T.position.z += u.vz * dt;
      T.rotateX(u.wx * dt); T.rotateY(u.wy * dt); T.rotateZ(u.wz * dt);
      if (!u.hit && T.position.y <= groundWY() + 2) { u.hit = true; T.visible = false; detStats.crashed.wing++; crashImpact(T.position, DET_SIZE.wing || 0.8, "wing"); } // 1.5.8: the player's own wing reaches the ground: explosion + scorch like the AI pieces
      u.fire.visible = u.t < 16; u.fire2.visible = u.t < 12;
      if (u.fire.visible) { u.fire.material.opacity = 0.6 + Math.random() * 0.35; const k = 5 + Math.random() * 1.4; u.fire.scale.set(k, k * 1.3, 1); }
      if (u.fire2.visible) u.fire2.material.opacity = 0.5 + Math.random() * 0.4;
      _ov.set(side * 4, 0.3, -0.8).applyMatrix4(T.matrixWorld);
      if (u.t < 26) { const Lp = u.lastP; if (!Lp || Lp.distanceTo(_ov) > 2.6) { wpEmit(_ov, { life: 8, s0: 2.4, s1: 16, a: 0.72, col: 0x131110 }); u.lastP = _ov.clone(); } }
      _ov.set(side * 1.3, -0.4, -1.4).applyMatrix4(ownShip.matrixWorld); // fuselage stub
      if (u.t < 30) { const Lq = u.lastQ; if (!Lq || Lq.distanceTo(_ov) > 3) { wpEmit(_ov, { life: 9, s0: 3, s1: 20, a: 0.75, col: 0x0e0d0c }); u.lastQ = _ov.clone(); } }
    }
    if (S.tailOff && !wreck.tail) { // the tail comes off
      const tg = new THREE.Group();
      tg.position.copy(ownShip.position); tg.quaternion.copy(ownShip.quaternion);
      ownShip.traverse((o) => { if (!o.isMesh || !o.visible || o.parent !== ownShip) return; if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere(); const cz = o.geometry.boundingSphere.center.z + o.position.z; if (o.userData.part === "fin" || o.userData.part === "stab" || (cz < -10.3 && o.geometry.boundingSphere.radius < 7)) wreck.parts.push({ orig: o }); });
      for (const q of wreck.parts) { const c = new THREE.Mesh(q.orig.geometry, q.orig.material); c.position.copy(q.orig.position); c.quaternion.copy(q.orig.quaternion); c.scale.copy(q.orig.scale); tg.add(c); q.orig.visible = false; }
      const tf = new THREE.Sprite(new THREE.SpriteMaterial({ map: fireTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.9 })); tf.position.set(0, -0.6, -10.8); tf.scale.set(2.6, 3.4, 1); tg.add(tf);
      tg.userData = { vx: (Math.random() - 0.5) * 16, vy: 6, vz: -14, wx: (Math.random() - 0.5) * 3, wy: (Math.random() - 0.5) * 2, wz: 1.5 + Math.random() * 2, fire: tf, t: 0 };
      scene.add(tg); wreck.tail = tg;
      for (const o of [ownTail.fire, ownTail.smokeAt]) if (o && o.parent === ownShip) { tg.add(o); wreck.moved.push(o); } // 1.5.9: the tail fire / smoke source ride the tail piece
      _ov.set(0, 0, -11).applyMatrix4(ownShip.matrixWorld);
      spawnDebris(_ov.x, _ov.y, _ov.z, 60, 0.5);
      emitSmoke(_ov, true, true);
    }
    if (wreck.tail) { // tumbling tail section: its own fall, spin and smoke
      const T = wreck.tail, u = T.userData, dt = Math.min(0.05, rdt);
      u.t += dt; u.vy -= 6.5 * dt; u.vy = Math.max(u.vy, -60); u.vz += (-AIR_DRIFT - u.vz) * Math.min(1, 0.35 * dt);
      T.position.x += u.vx * dt; T.position.y += u.vy * dt; T.position.z += u.vz * dt;
      T.rotateX(u.wx * dt); T.rotateY(u.wy * dt); T.rotateZ(u.wz * dt);
      if (!u.hit && T.position.y <= groundWY() + 2) { u.hit = true; T.visible = false; detStats.crashed.tail++; crashImpact(T.position, DET_SIZE.tail || 0.6, "tail"); }
      u.fire.visible = u.t < 14; if (u.fire.visible) u.fire.material.opacity = 0.6 + Math.random() * 0.35;
      _ov.set(0, 0, -11).applyMatrix4(T.matrixWorld);
      if (u.t < 24) { if (!u.lastP) u.lastP = null; const Lp = u.lastP; if (!Lp || Lp.distanceTo(_ov) > 3) { wpEmit(_ov, { life: 7, s0: 1.6, s1: 11, a: 0.6, col: 0x1c1a18 }); u.lastP = _ov.clone(); } }
    }
  }
  let _ownT = pnow(); let _lift = 0, _liftP = 0;
  function updateOwnShip(opts) {
    const now = pnow();
    const rdt = Math.min(0.25, (now - _ownT) / 1000);
    const dt = Math.min(0.05, rdt);
    _ownT = now;
    const FALL = opts.fall;
    if (FALL && FALL.ship) { // 1.3.8: shot down — the airframe spins and falls away (keeps falling under the chute)
      const S = FALL.ship;
      ownShip.position.set(S.x, S.y, S.z);
      ownShip.quaternion.setFromEuler(_fallE.set(S.pd || 0, S.yaw || 0, -(S.roll || 0), "YXZ"));
    } else {
      ownShip.position.set(CAM.x, CAM.y + _lift, CAM.z);
      ownShip.rotation.set(-_liftP, 0, -(opts.roll || 0));
    }
    ownShip.visible = !(FALL && FALL.ship && FALL.ship.crashed) && !window.__FG_FREECAM; // 1.6.0/1.6.1: hide in freecam so altitude stills see the town
    ownShip.updateMatrixWorld(true);
    updateOwnWreck(FALL, rdt);
    const engs = (opts.own && opts.own.engines) || [];
    for (let i = 0; i < 4; i++) {
      const E = ownEngines[i], st = engs[i] || { fire: 0, out: false };
      if (E.gone) {
        E.disc.visible = false; E.blades.visible = false; if (ownShip.userData.contrails) ownShip.userData.contrails[i].on = false;
        const W = wreck.wing, wu = W && W.userData, lit = !!(W && E.fire.parent === W && !wu.hit && wu.t < 18); // 1.5.9: an engine on the severed wing keeps burning ON the wing piece (its fire and smoke source were re-parented to it)
        E.fire.visible = lit;
        if (lit) {
          const s = 0.95 * (0.8 + Math.random() * 0.4); E.fire.scale.set(s * 0.7, s * (1.2 + Math.random() * 0.5), 1); E.fire.material.opacity = 0.7 + Math.random() * 0.3;
          E.smokeAt.getWorldPosition(_ov); engineFireFx(_ov, 0.9, rdt, E.fx || (E.fx = { t: 0 }));
          E.emit -= rdt;
          for (let n = 0; n < 5 && E.emit <= 0; n++) { E.smokeAt.getWorldPosition(_ov); ribbonEmit("own" + i, _ov, { w0: 0.45, w1: 5.4, life: 3.6, a: 0.58, col: [0.2, 0.195, 0.19], drift: 45 }); E.emit += 0.04; }
          if (E.emit < 0) E.emit = 0;
        }
        continue;
      }
      const out = !!st.out;
      E.disc.visible = !out;
      E.blades.visible = out;
      if (ownShip.userData.contrails) ownShip.userData.contrails[i].on = !out;
      if (!out) E.disc.rotation.z += dt * 33;
      else { // feathered: windmills down to a stop
        E.wind = Math.max(0, (E.wind == null ? 3 : E.wind) - dt * 0.8);
        E.blades.rotation.z += E.wind * dt;
      }
      if (!out) E.wind = 3;
      const burning = st.fire > 0.3 && st.fire < 0.97 || (out && st.fire > 0.5);
      E.fire.visible = burning;
      if (E.oil) { // oil streaks grow on a hit / dead engine and stay
        const want = out ? 0.9 : st.fire > 0.25 ? 0.5 : 0;
        E.oilA = want > E.oilA ? Math.min(want, E.oilA + dt * 0.12) : E.oilA;
        if (st.fire < 0.02 && !out) E.oilA = 0; // new mission / repaired
        E.oil.visible = E.oilA > 0.01; E.oil.material.opacity = E.oilA;
      }
      if (burning) {
        const s = (0.45 + st.fire * 0.5) * (0.8 + Math.random() * 0.4);
        E.fire.scale.set(s * 0.7, s * (1.2 + Math.random() * 0.5), 1);
        E.fire.material.opacity = 0.7 + Math.random() * 0.3;
      }
      if (burning) { E.smokeAt.getWorldPosition(_ov); engineFireFx(_ov, Math.min(1, st.fire), rdt, E.fx || (E.fx = { t: 0 })); } // 1.5.4 flame tongue + fragments
      const smoking = st.fire > 0.1 || out;
      if (smoking) {
        E.emit -= rdt;
        for (let n = 0; n < 5 && E.emit <= 0; n++) { // 1.4.0: continuous ribbon trail
          E.smokeAt.getWorldPosition(_ov);
          const dk = burning || out;
          ribbonEmit("own" + i, _ov, { w0: 0.45, w1: dk ? 5.4 : 3.0, life: dk ? 3.6 : 2.4, a: dk ? 0.58 : 0.42, col: dk ? [0.2, 0.195, 0.19] : [0.6, 0.6, 0.58], drift: 45 });
          E.emit += 0.04;
        }
        if (E.emit < 0) E.emit = 0;
      }
    }
    // 1.3.5: our own tail, shot up by our own turret
    const tl = opts.own && opts.own.tail;
    if (tl && ownTail.fire) {
      const tf = tl.fire || 0;
      const burning = tf > 0.4;
      ownTail.fire.visible = burning;
      if (burning) {
        const s = (0.5 + tf * 0.7) * (0.8 + Math.random() * 0.4);
        ownTail.fire.scale.set(s * 0.8, s * (1.3 + Math.random() * 0.6), 1);
        ownTail.fire.material.opacity = 0.7 + Math.random() * 0.3;
      }
      if (tf > 0.08) {
        ownTail.emit -= rdt;
        for (let n = 0; n < 4 && ownTail.emit <= 0; n++) {
          ownTail.smokeAt.getWorldPosition(_ov);
          _ov.z -= n * 0.6;
          emitSmoke(_ov, burning, false, { life: 2.4, vz: -11, s0: 0.5 + n * 0.15, s1: burning ? 3.6 : 2.6, a: burning ? 0.6 : 0.4, color: burning ? 0x34322f : 0x8e8c88 });
          ownTail.emit += burning ? 0.045 : 0.09;
        }
        if (ownTail.emit < 0) ownTail.emit = 0;
      }
    }
    // 1.4.0: structural damage by health
    {
      const hp = opts.own && opts.own.health != null ? opts.own.health : 100;
      for (const it of ownDmg.items) it.obj.visible = hp < it.th;
      for (const cm of ownDmg.cuts) {
        const n = cm.events.reduce((a, e) => a + (hp < e.th ? 1 : 0), 0);
        if (n !== cm.n) {
          cm.n = n; const x = cm.ctx; x.globalCompositeOperation = "source-over"; x.fillStyle = "#fff"; x.fillRect(0, 0, cm.W, cm.H);
          x.fillStyle = "#000"; for (const e of cm.events) if (hp < e.th) e.draw(x);
          cm.tex.needsUpdate = true;
        }
      }
      if (hp < 25 && ownDmg.wisp) { // a thin trailing smoke wisp, darker and thicker near the end
        ownDmg.wispT -= rdt;
        const heavy = hp < 10;
        while (ownDmg.wispT <= 0) {
          ownDmg.wisp.getWorldPosition(_ov);
          if (true) ribbonEmit("ownwisp", _ov, { w0: heavy ? 0.35 : 0.2, w1: heavy ? 4.5 : 2.6, life: heavy ? 3.2 : 2.4, a: heavy ? 0.5 : 0.28, col: heavy ? [0.22, 0.21, 0.2] : [0.62, 0.61, 0.6] });
          else emitSmoke(_ov, heavy, false, { life: heavy ? 2.6 : 2.0, vz: -30, s0: heavy ? 0.5 : 0.3, s1: heavy ? 4 : 2.4, a: heavy ? 0.45 : 0.25, color: heavy ? 0x3a3836 : 0x9e9c98 });
          ownDmg.wispT += heavy ? 0.04 : 0.07;
        }
      }
    }
    const holes = []; // 1.3.8: the old floating sprite 'rings' are gone — holes are raycast decals (addHole)
    for (let i = 0; i < ownHoles.length; i++) {
      const sp = ownHoles[i], h = holes[i];
      if (!h) { sp.visible = false; continue; }
      const L = Math.hypot(h.x, h.y, h.z) || 1, k = Math.max(0.2, 1 - 0.1 / L); // nudge toward the eye
      sp.position.set(h.x * k, h.y * k, h.z * k);
      const sc = 0.2 + Math.min(0.25, L * 0.012);
      sp.scale.set(sc, sc, 1);
      sp.visible = true;
    }
  }

  // ===== 1.3.8: DAMAGE DECALS — punctured skin placed by a real raycast on the rendered mesh =====
  // Hit point + face normal from THREE.Raycaster on the actual (rolled / banked / spinning) airframe,
  // decal parented to the airframe group in its local frame (moves with it), depth-tested with a
  // polygon offset (hidden when that skin is out of view). Dark torn holes with bare-metal petals.
  const _rc = new THREE.Raycaster();
  const _ro = new THREE.Vector3(), _rd = new THREE.Vector3(), _rn = new THREE.Vector3(), _rq = new THREE.Quaternion(), _rz = new THREE.Vector3(0, 0, 1);
  function hitList(g) {
    if (g.userData.hitList) return g.userData.hitList;
    const L = [];
    g.traverse((o) => { if (o.isMesh && (o.material === propDiscMat || o.material === propBladeMat)) o.userData.prop = true; if (o.isMesh && !o.userData.noHit && !o.userData.decal && o.material) L.push(o); });
    g.userData.hitList = L.filter((o) => !(o.material.transparent && o.material.depthWrite === false && !o.userData.prop));
    return g.userData.hitList;
  }
  function chainVisible(o, root) { for (let q = o; q && q !== root; q = q.parent) if (!q.visible) return false; return root.visible; }
  function shipGroup(which) { return which === "own" ? ownShip : friendlyPool[which]; }
  // world-space segment vs the rendered airframe → first surface hit (world point + outward normal)
  const _rsE = new THREE.Euler();
  function rayShip(which, x0, y0, z0, x1, y1, z1, pose) {
    const g = shipGroup(which);
    if (!g || !g.visible) return null;
    // 1.3.8: pose the airframe from the sim's CURRENT transform (position, heading, pitch, bank/roll, spin) — never a stale frame
    if (pose) { g.position.set(pose.x, pose.y, pose.z); g.quaternion.setFromEuler(_rsE.set(pose.rx || 0, pose.ry || 0, pose.rz || 0, "YXZ")); }
    g.updateMatrixWorld(true);
    _ro.set(x0, y0, z0); _rd.set(x1 - x0, y1 - y0, z1 - z0);
    const len = _rd.length(); if (len < 1e-6) return null;
    _rd.multiplyScalar(1 / len);
    _rc.set(_ro, _rd); _rc.near = 0; _rc.far = len;
    const hits = _rc.intersectObjects(hitList(g), false);
    for (const h of hits) {
      if (!chainVisible(h.object, g)) continue;
      _rn.copy(h.face ? h.face.normal : _rd).transformDirection(h.object.matrixWorld);
      if (_rn.dot(_rd) > 0) _rn.negate();
      return { x: h.point.x, y: h.point.y, z: h.point.z, nx: _rn.x, ny: _rn.y, nz: _rn.z, t: h.distance / len, prop: !!h.object.userData.prop, part: h.object.userData.part || null, obj: h.object };
    }
    return null;
  }
  const _hl = new THREE.Vector3(), _hn = new THREE.Vector3(), _gq = new THREE.Quaternion();
  // 1.5.8 CONFORMAL DECALS: cut a decal out of the skin triangles themselves (clipped to a rotated box around the hit point, pushed 5 mm off the surface along each face normal, UVs projected on the hit plane), so a hole /
  // tear follows the fuselage curve and never pokes out like a flat card. rel = object→frame matrix; c, n in the frame; hx/hy = half extents.
  const _bt = new THREE.Vector3(), _bb = new THREE.Vector3(), _bv = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], _bnt = new THREE.Vector3(), _be1 = new THREE.Vector3(), _be2 = new THREE.Vector3();
  function clipPoly(poly, ax, c, lim) { // keep dot(p - c, ax) <= lim
    const o = []; for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const da = (a[0] - c.x) * ax.x + (a[1] - c.y) * ax.y + (a[2] - c.z) * ax.z - lim, db = (b[0] - c.x) * ax.x + (b[1] - c.y) * ax.y + (b[2] - c.z) * ax.z - lim;
      if (da <= 0) o.push(a);
      if ((da < 0 && db > 0) || (da > 0 && db < 0)) { const k = da / (da - db); o.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]); }
    }
    return o;
  }
  function buildDecal(geo, rel, c, n, rot, hx, hy, off) {
    if (!geo || !geo.attributes.position) return null;
    if (Math.abs(n.y) < 0.9) _bt.set(0, 1, 0).cross(n); else _bt.set(1, 0, 0).cross(n);
    _bt.normalize(); _bb.crossVectors(n, _bt).normalize();
    const cr = Math.cos(rot), sr = Math.sin(rot), tx = _bt.x * cr + _bb.x * sr, ty = _bt.y * cr + _bb.y * sr, tz = _bt.z * cr + _bb.z * sr;
    _bb.set(-_bt.x * sr + _bb.x * cr, -_bt.y * sr + _bb.y * cr, -_bt.z * sr + _bb.z * cr); _bt.set(tx, ty, tz);
    const P = geo.attributes.position, I = geo.index, nT = I ? I.count / 3 : P.count / 3, depth = Math.max(0.04, 0.9 * Math.max(hx, hy));
    const pos = [], nor = [], uv = [], ng = [];
    const T = _bt.clone().negate(), B = _bb.clone().negate();
    for (let f = 0; f < nT; f++) {
      let near = false;
      for (let k = 0; k < 3; k++) { const vi = I ? I.getX(f * 3 + k) : f * 3 + k; _bv[k].fromBufferAttribute(P, vi).applyMatrix4(rel); if (Math.abs(_bv[k].clone().sub(c).dot(n)) <= depth) near = true; }
      if (!near) continue;
      _be1.subVectors(_bv[1], _bv[0]); _be2.subVectors(_bv[2], _bv[0]); _bnt.crossVectors(_be1, _be2); if (_bnt.lengthSq() < 1e-14) continue; _bnt.normalize();
      const d = _bnt.dot(n); if (Math.abs(d) < 0.35) continue; if (d < 0) _bnt.negate();
      let poly = [[_bv[0].x, _bv[0].y, _bv[0].z], [_bv[1].x, _bv[1].y, _bv[1].z], [_bv[2].x, _bv[2].y, _bv[2].z]];
      poly = clipPoly(poly, _bt, c, hx); if (poly.length < 3) continue; poly = clipPoly(poly, T, c, hx); if (poly.length < 3) continue;
      poly = clipPoly(poly, _bb, c, hy); if (poly.length < 3) continue; poly = clipPoly(poly, B, c, hy); if (poly.length < 3) continue;
      const q = poly.map((p) => [p[0] + _bnt.x * off, p[1] + _bnt.y * off, p[2] + _bnt.z * off]);
      for (let k = 1; k < q.length - 1; k++) for (const pt of [q[0], q[k], q[k + 1]]) {
        pos.push(pt[0], pt[1], pt[2]); nor.push(_bnt.x, _bnt.y, _bnt.z);
        const rx = pt[0] - c.x, ry = pt[1] - c.y, rz = pt[2] - c.z;
        uv.push((rx * _bt.x + ry * _bt.y + rz * _bt.z) / (2 * hx) + 0.5, (rx * _bb.x + ry * _bb.y + rz * _bb.z) / (2 * hy) + 0.5);
      }
    }
    if (pos.length < 9) return null;
    const g2 = new THREE.BufferGeometry();
    g2.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g2.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3)); g2.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    return g2;
  }
  const decalStats = { conformal: 0, flat: 0, tris: 0 };
  function setDecalGeo(m, g2) { if (m.geometry !== holeGeo) m.geometry.dispose(); m.geometry = g2 || holeGeo; }
  const _rel = new THREE.Matrix4(), _ginv = new THREE.Matrix4();
  function addHole(which, h, size) {
    const g = shipGroup(which);
    if (!g || !h || h.prop) return false;
    g.updateMatrixWorld(true);
    const list = g.userData.decals || (g.userData.decals = []);
    const cap = which === "own" ? 90 : 36;
    let m;
    if (list.length >= cap) { m = list.shift(); } else { m = new THREE.Mesh(holeGeo, holeTexs[0]); m.userData.decal = true; m.userData.noHit = true; m.renderOrder = 2; g.add(m); }
    m.material = holeTexs[(Math.random() * 4) | 0];
    _hl.set(h.x, h.y, h.z); g.worldToLocal(_hl);
    g.getWorldQuaternion(_gq).invert();
    _hn.set(h.nx, h.ny, h.nz).applyQuaternion(_gq).normalize();
    const s0 = (size || 0.1) * (0.7 + Math.random() * 0.6), asp = 0.8 + Math.random() * 0.4;
    let g2 = null;
    if (h.obj) { _ginv.copy(g.matrixWorld).invert(); _rel.multiplyMatrices(_ginv, h.obj.matrixWorld); g2 = buildDecal(h.obj.geometry, _rel, _hl, _hn, Math.random() * 6.28, s0 * 0.5, s0 * 0.5 * asp, 0.005); }
    setDecalGeo(m, g2);
    if (g2) { m.position.set(0, 0, 0); m.quaternion.identity(); m.scale.set(1, 1, 1); decalStats.conformal++; }
    else { decalStats.flat++; m.position.copy(_hl).addScaledVector(_hn, 0.006); _rq.setFromUnitVectors(_rz, _hn); m.quaternion.copy(_rq); m.rotateZ(Math.random() * Math.PI * 2); m.scale.set(s0, s0 * asp, 1); }
    m.visible = true;
    list.push(m);
    return true;
  }
  function addTear(which, h, size) { // 1.5.4: a torn-skin cut-out with exposed ribs (separate small pool so holes never evict it)
    const g = shipGroup(which);
    if (!g || !h || h.prop) return false;
    g.updateMatrixWorld(true);
    const list = g.userData.tears || (g.userData.tears = []);
    const cap = which === "own" ? 14 : 5;
    let m;
    if (list.length >= cap) { m = list.shift(); } else { m = new THREE.Mesh(holeGeo, tearTexs[0]); m.userData.decal = true; m.userData.noHit = true; m.renderOrder = 3; g.add(m); }
    m.material = tearTexs[(Math.random() * 3) | 0];
    _hl.set(h.x, h.y, h.z); g.worldToLocal(_hl);
    g.getWorldQuaternion(_gq).invert();
    _hn.set(h.nx, h.ny, h.nz).applyQuaternion(_gq).normalize();
    const sc = Math.min(0.75, (size || 0.5) * (0.8 + Math.random() * 0.4)), asp = 0.65 + Math.random() * 0.3; // capped: a tear must not be wider than the skin it is on
    let g2 = null;
    if (h.obj) { _ginv.copy(g.matrixWorld).invert(); _rel.multiplyMatrices(_ginv, h.obj.matrixWorld); g2 = buildDecal(h.obj.geometry, _rel, _hl, _hn, Math.random() * 6.28, sc * 0.5, sc * 0.5 * asp, 0.008); }
    setDecalGeo(m, g2);
    if (g2) { m.position.set(0, 0, 0); m.quaternion.identity(); m.scale.set(1, 1, 1); decalStats.conformal++; }
    else { decalStats.flat++; m.position.copy(_hl).addScaledVector(_hn, 0.012); _rq.setFromUnitVectors(_rz, _hn); m.quaternion.copy(_rq); m.rotateZ(Math.random() * Math.PI * 2); m.scale.set(sc * 0.8, sc * asp * 0.8, 1); }
    m.visible = true;
    list.push(m);
    return true;
  }
  function clearDamage() {
    for (const g of [ownShip, ...friendlyPool]) {
      const list = g.userData.decals || [];
      for (const m of list) { g.remove(m); if (m.geometry !== holeGeo) m.geometry.dispose(); }
      for (const m of (g.userData.tears || [])) { g.remove(m); if (m.geometry !== holeGeo) m.geometry.dispose(); }
      g.userData.tears = [];
      g.userData.decals = [];
      g.userData.fxDone = false;
    }
  }
  // ===== 1.3.8: 109 hit test against the rendered airframe at the fighter's CURRENT attitude =====
  // One invisible probe clone per type is posed exactly as updateFighters poses the live mesh
  // (nose = h, canopy = lift vector u → heading, pitch, bank; wreck spin excluded — wrecks are not hit).
  const fProbes = {};
  const _pf = new THREE.Vector3(), _pu = new THREE.Vector3(), _pr = new THREE.Vector3(), _pm = new THREE.Matrix4(), _pq = new THREE.Quaternion(), _pw = new THREE.Vector3();
  function fighterProbe(kind) {
    const k = kind === "110" ? "109" : (kind || "109");
    if (fProbes[k] !== undefined) return fProbes[k];
    const m = prototypes[k] || prototypes["109"] ? cloneFighter(k) : null;
    if (!m) return null; // models not loaded yet → caller falls back
    scene.remove(m); m.visible = true;
    // probe only (never drawn): both faces count, so a thin single-skin wing is solid from either side
    m.traverse((o) => { if (o.isMesh && o.material) { const mats = Array.isArray(o.material) ? o.material : [o.material]; o.material = mats.length === 1 ? mats[0].clone() : mats.map((x) => x.clone()); (Array.isArray(o.material) ? o.material : [o.material]).forEach((x) => { x.side = THREE.DoubleSide; }); } });
    fProbes[k] = m;
    return m;
  }
  // 1.3.9: projected silhouette area of each fighter type seen along its local X (side), Y (top) and
  // Z (nose) axes — CPU-rasterised once from the hit mesh (root-local units, i.e. before the ×base scale).
  const fAreas = {};
  function fighterAreas(kind) {
    const k = kind === "110" ? "109" : (kind || "109");
    if (fAreas[k]) return fAreas[k];
    const m = fighterProbe(k);
    if (!m) return null;
    const P = m.position.clone(), Q = m.quaternion.clone(), S = m.scale.clone();
    m.position.set(0, 0, 0); m.quaternion.identity(); m.scale.setScalar(1); m.updateMatrixWorld(true);
    const tris = [], v = new THREE.Vector3(), bb = new THREE.Box3();
    for (const o of fighterHitList(m)) {
      const g = o.geometry, pa = g.attributes.position, ix = g.index, n = ix ? ix.count : pa.count;
      const w = [];
      for (let i = 0; i < pa.count; i++) { v.fromBufferAttribute(pa, i).applyMatrix4(o.matrixWorld); w.push(v.x, v.y, v.z); bb.expandByPoint(v); }
      for (let i = 0; i + 2 < n; i += 3) { const a = ix ? ix.getX(i) : i, b = ix ? ix.getX(i + 1) : i + 1, c = ix ? ix.getX(i + 2) : i + 2; tris.push(w[a * 3], w[a * 3 + 1], w[a * 3 + 2], w[b * 3], w[b * 3 + 1], w[b * 3 + 2], w[c * 3], w[c * 3 + 1], w[c * 3 + 2]); }
    }
    m.position.copy(P); m.quaternion.copy(Q); m.scale.copy(S); m.updateMatrixWorld(true);
    const N = 192, out = [0, 0, 0];
    const mn = [bb.min.x, bb.min.y, bb.min.z], ext = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z];
    for (let ax = 0; ax < 3; ax++) {
      const u = (ax + 1) % 3, w2 = (ax + 2) % 3, cu = ext[u] / N || 1e-3, cw = ext[w2] / N || 1e-3;
      const grid = new Uint8Array(N * N);
      for (let t = 0; t < tris.length; t += 9) {
        const x0 = (tris[t + u] - mn[u]) / cu, y0 = (tris[t + w2] - mn[w2]) / cw, x1 = (tris[t + 3 + u] - mn[u]) / cu, y1 = (tris[t + 3 + w2] - mn[w2]) / cw, x2 = (tris[t + 6 + u] - mn[u]) / cu, y2 = (tris[t + 6 + w2] - mn[w2]) / cw;
        const den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
        if (Math.abs(den) < 1e-9) continue;
        const ia = Math.max(0, Math.floor(Math.min(x0, x1, x2))), ib = Math.min(N - 1, Math.ceil(Math.max(x0, x1, x2))), ja = Math.max(0, Math.floor(Math.min(y0, y1, y2))), jb = Math.min(N - 1, Math.ceil(Math.max(y0, y1, y2)));
        for (let j = ja; j <= jb; j++) for (let i = ia; i <= ib; i++) {
          const px = i + 0.5, py = j + 0.5;
          const l1 = ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) / den, l2 = ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) / den;
          if (l1 >= -0.02 && l2 >= -0.02 && l1 + l2 <= 1.02) grid[j * N + i] = 1;
        }
      }
      let c = 0; for (let i = 0; i < grid.length; i++) c += grid[i];
      out[ax] = c * cu * cw;
    }
    fAreas[k] = { side: out[0], top: out[1], front: out[2] };
    return fAreas[k];
  }
  function fighterHitList(m) {
    if (m.userData.fHit) return m.userData.fHit;
    const L = [];
    m.traverse((o) => {
      if (!o.isMesh || !o.visible || o.userData.isShadow || o.userData.decal || o.userData.noHit) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const nm = ((o.name || "") + " " + mats.map((x) => (x && x.name) || "").join(" ")).toLowerCase();
      if (nm.includes("disc") || mats.some((x) => x && (x.userData.tr0 != null ? x.userData.tr0 : x.transparent) && (x.userData.op0 != null ? x.userData.op0 : x.opacity) < 0.5)) return; // prop blur disc: not metal
      L.push(o);
    });
    m.userData.fHit = L;
    return L;
  }
  function poseFighter(m, e) {
    const base = e.type === "190" ? 1.4 : e.type === "110" ? 1.6 : 1.3;
    m.scale.setScalar(base);
    m.position.set(e.x, e.y, e.z);
    if (e.ux != null) {
      _pf.set(e.hx, e.hy, e.hz).normalize();
      _pu.set(e.ux, e.uy, e.uz); _pu.addScaledVector(_pf, -_pu.dot(_pf)).normalize();
      _pr.crossVectors(_pu, _pf).negate();
      _pw.copy(_pf).negate();
      _pm.makeBasis(_pr, _pu, _pw);
      m.quaternion.setFromRotationMatrix(_pm);
    } else {
      _pf.set(e.hx != null ? e.hx : e.vx || 0, e.hx != null ? e.hy : e.vy || 0, e.hx != null ? e.hz : e.vz || -1);
      if (_pf.lengthSq() < 1e-6) _pf.set(0, 0, -1);
      _pf.normalize();
      _pr.crossVectors(new THREE.Vector3(0, 1, 0), _pf); if (_pr.lengthSq() < 1e-6) _pr.set(1, 0, 0); _pr.normalize();
      _pu.crossVectors(_pf, _pr).normalize();
      _pm.makeBasis(_pr.clone().negate(), _pu, _pf.clone().negate());
      m.quaternion.setFromRotationMatrix(_pm);
      m.quaternion.premultiply(_pq.setFromAxisAngle(_pf, -(e.bank || 0)));
    }
    m.updateMatrixWorld(true);
  }
  const _ta = new THREE.Vector3(), _tb = new THREE.Vector3(), _to = new THREE.Vector3();
  const TOL_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.71, 0.71], [-0.71, 0.71], [0.71, -0.71], [-0.71, -0.71]];
  // tol (world units, optional): a round whose line passes within `tol` of the skin still strikes it — the
  // strike point is then the skin point hit by the nearest parallel offset ray (so sparks/holes stay ON the mesh)
  function rayFighter(e, x0, y0, z0, x1, y1, z1, tol) {
    const m = fighterProbe(e.type);
    if (!m) return undefined; // not ready
    poseFighter(m, e);
    _ro.set(x0, y0, z0); _rd.set(x1 - x0, y1 - y0, z1 - z0);
    const len = _rd.length(); if (len < 1e-6) return null;
    _rd.multiplyScalar(1 / len);
    _rc.set(_ro, _rd); _rc.near = 0; _rc.far = len;
    const L = fighterHitList(m);
    let hits = _rc.intersectObjects(L, false), off = 0;
    if (!hits.length && tol > 0) {
      _ta.set(0, 1, 0).cross(_rd); if (_ta.lengthSq() < 1e-6) _ta.set(1, 0, 0); _ta.normalize(); _tb.crossVectors(_rd, _ta).normalize();
      for (const fr of [0.5, 1]) {
        for (const q of TOL_DIRS) {
          _to.copy(_ro).addScaledVector(_ta, q[0] * tol * fr).addScaledVector(_tb, q[1] * tol * fr);
          _rc.set(_to, _rd); _rc.near = 0; _rc.far = len;
          hits = _rc.intersectObjects(L, false);
          if (hits.length) { off = tol * fr; break; }
        }
        if (hits.length) break;
      }
    }
    if (!hits.length) return null;
    const h = hits[0];
    _rn.copy(h.face ? h.face.normal : _rd).transformDirection(h.object.matrixWorld);
    if (_rn.dot(_rd) > 0) _rn.negate();
    _hl.copy(h.point); m.worldToLocal(_hl);
    _gq.copy(m.quaternion).invert(); _hn.copy(_rn).applyQuaternion(_gq).normalize();
    return { x: h.point.x, y: h.point.y, z: h.point.z, nx: _rn.x, ny: _rn.y, nz: _rn.z, t: h.distance / len, off,
      lx: _hl.x, ly: _hl.y, lz: _hl.z, lnx: _hn.x, lny: _hn.y, lnz: _hn.z, obj: h.object, rel: new THREE.Matrix4().copy(m.matrixWorld).invert().multiply(h.object.matrixWorld) };
  }
  function fighterBoundR(kind) {
    const m = fighterProbe(kind); if (!m) return 0;
    if (m.userData.bR) return m.userData.bR;
    m.position.set(0, 0, 0); m.quaternion.identity(); m.scale.setScalar(1); m.updateMatrixWorld(true);
    const b = new THREE.Box3(); for (const o of fighterHitList(m)) b.expandByObject(o);
    m.userData.bR = Math.max(b.min.length(), b.max.length());
    return m.userData.bR;
  }
  // bullet hole on the LIVE mesh of that bandit, in its local frame (moves/banks/spins with it)
  function addFighterHole(e, h, size) {
    const si = slotOf.get(e.id); if (si == null) return false;
    const slot = fighterPool[si]; const m = slot && slot.mesh; if (!m || !h || h.lx == null) return false;
    const list = m.userData.decals || (m.userData.decals = []);
    let d;
    if (list.length >= 24) d = list.shift(); else { d = new THREE.Mesh(holeGeo, holeTexs[0]); d.userData.decal = true; d.userData.noHit = true; d.renderOrder = 2; m.add(d); }
    d.material = holeTexs[(Math.random() * 4) | 0];
    _hn.set(h.lnx, h.lny, h.lnz).normalize();
    const ms = m.scale.x || 1;
    const s0 = (size || 0.12) * (0.7 + Math.random() * 0.6) / ms;
    let g2 = null;
    if (h.obj && h.rel) { _hl.set(h.lx, h.ly, h.lz); g2 = buildDecal(h.obj.geometry, h.rel, _hl, _hn, Math.random() * 6.28, s0 * 0.5, s0 * 0.5, 0.005 / ms); }
    setDecalGeo(d, g2);
    if (g2) { d.position.set(0, 0, 0); d.quaternion.identity(); d.scale.set(1, 1, 1); decalStats.conformal++; }
    else { decalStats.flat++; d.position.set(h.lx, h.ly, h.lz).addScaledVector(_hn, 0.006 / ms); _rq.setFromUnitVectors(_rz, _hn); d.quaternion.copy(_rq); d.rotateZ(Math.random() * Math.PI * 2); d.scale.set(s0, s0, 1); }
    d.visible = true;
    list.push(d);
    return true;
  }
  function fighterMeshDump(kind) {
    const m = fighterProbe(kind); if (!m) return null; const out = [];
    m.traverse((o) => { if (!o.isMesh) return; const mats = Array.isArray(o.material) ? o.material : [o.material]; const b = new THREE.Box3().setFromObject(o);
      out.push({ n: o.name, vis: o.visible, mats: mats.map((x) => x && [x.name, x.transparent, x.opacity, x.side, x.type]), inList: fighterHitList(m).includes(o), min: b.min.toArray().map((v) => +v.toFixed(2)), max: b.max.toArray().map((v) => +v.toFixed(2)) }); });
    return out;
  }
  function fighterDecalInfo(id) {
    const si = slotOf.get(id); if (si == null) return null;
    const m = fighterPool[si].mesh; if (!m) return null;
    m.updateMatrixWorld(true);
    return (m.userData.decals || []).map((d) => { const w = d.getWorldPosition(new THREE.Vector3()); return { x: w.x, y: w.y, z: w.z }; });
  }
  // ===== 1.3.8: PARACHUTES (US white gores / German beige) and our own canopy overhead =====
  const goreTex = (base) => {
    const c = document.createElement("canvas"); c.width = 128; c.height = 32;
    const x = c.getContext("2d");
    for (let k = 0; k < 16; k++) { const v = k % 2 ? 0 : 14; x.fillStyle = `rgb(${base[0] - v},${base[1] - v},${base[2] - v})`; x.fillRect(k * 8, 0, 8, 32); x.fillStyle = "rgba(90,85,70,0.5)"; x.fillRect(k * 8, 0, 1, 32); }
    x.fillStyle = "rgba(60,55,45,0.35)"; x.fillRect(0, 29, 128, 3);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  };
  const chuteMatUS = new THREE.MeshLambertMaterial({ map: goreTex([236, 232, 218]), side: THREE.DoubleSide, fog: true });
  const chuteMatDE = new THREE.MeshLambertMaterial({ map: goreTex([214, 196, 160]), side: THREE.DoubleSide, fog: true });
  const chuteBody = new THREE.MeshLambertMaterial({ color: 0x3b3a2c, fog: true });
  const lineMat = new THREE.LineBasicMaterial({ color: 0x6a665a, transparent: true, opacity: 0.8, fog: true });
  const canopyGeo = new THREE.SphereGeometry(1, 16, 6, 0, Math.PI * 2, 0, 1.15);
  const lineGeo = (() => {
    const p = [];
    for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2; p.push(Math.cos(a) * Math.sin(1.15), Math.cos(1.15), Math.sin(a) * Math.sin(1.15), 0, -1.45, 0); }
    return new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
  })();
  const bodyGeo = new THREE.CylinderGeometry(0.2, 0.17, 1.15, 6);
  const chutePool = [];
  function makeChute(mat) {
    const g = new THREE.Group();
    const can = new THREE.Group();
    const dome = new THREE.Mesh(canopyGeo, mat); can.add(dome);
    const lines = new THREE.LineSegments(lineGeo, lineMat); can.add(lines);
    g.add(can);
    const body = new THREE.Mesh(bodyGeo, chuteBody); g.add(body);
    g.userData = { can, dome, lines, body };
    g.visible = false; scene.add(g);
    return g;
  }
  for (let i = 0; i < 72; i++) chutePool.push(makeChute(chuteMatUS));
  function updateChutes3D(list) {
    list = list || [];
    for (let i = 0; i < chutePool.length; i++) {
      const g = chutePool[i], c = list[i];
      if (!c) { g.visible = false; continue; }
      g.visible = true;
      const U = g.userData;
      U.dome.material = c.kind === "de" ? chuteMatDE : chuteMatUS;
      g.position.set(c.x, c.y, c.z);
      const o = c.open || 0, R = 2.8;
      // streamer (tall, narrow) → blossoming canopy
      const w = 0.12 + 0.88 * Math.pow(o, 0.7), hgt = o > 0 ? 1 : 0.2;
      U.can.position.set(0, 0.6 + (1.2 + 2.9 * o) * (o > 0 ? 1 : 0.3), 0);
      U.can.scale.set(R * w, R * (o > 0 ? (0.55 + 0.25 * o) : 1.6) * hgt + 0.3, R * w);
      U.lines.visible = o > 0.05;
      U.can.visible = o > 0 || c.t > 0.4;
      const sw = Math.sin((c.t || 0) * 0.9 + c.id) * 0.12 * o;
      g.rotation.set(sw * 0.6, 0, sw);
      U.body.rotation.set(o > 0 ? 0 : (c.t || 0) * 3, 0, o > 0 ? 0 : (c.t || 0) * 2.2);
    }
  }
  // our own canopy, seen from the harness: dome ~3u above, 12 shroud lines to the risers, boots below
  const ownChute = new THREE.Group(); const _legDir = new THREE.Vector3();
  {
    const dome = new THREE.Mesh(canopyGeo, chuteMatUS); dome.scale.set(2.9, 1.9, 2.9); dome.position.y = 4.4; ownChute.add(dome);
    const p = [];
    for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2; p.push(Math.cos(a) * 2.9 * Math.sin(1.15), 4.4 + 1.9 * Math.cos(1.15), Math.sin(a) * 2.9 * Math.sin(1.15), (k < 6 ? 0.22 : -0.22), 0.35, 0.05); }
    ownChute.add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(p, 3)), new THREE.LineBasicMaterial({ color: 0x8a8578 })));
    // 1.4.1: seated in the harness — thighs forward, shins hanging, rounded boots (1.4.0's 6-sided stubs read as
    // brown hexagons when looking straight down at the falling ship). The legs group turns with the view heading.
    // 1.5.4: NO body in the bailout view (the player's legs/boots are gone for good — only canopy, shroud lines and the streamer remain)
    const legs = new THREE.Group(); legs.visible = false; // empty placeholder (kept so the heading code below stays valid)
    const streamer = new THREE.Mesh(canopyGeo, chuteMatUS); streamer.scale.set(0.35, 3.2, 0.35); streamer.position.y = 3.0; ownChute.add(streamer);
    ownChute.userData = { dome, streamer, legs };
    ownChute.visible = false; scene.add(ownChute);
  }

  // ===== 1.4.0: CONTINUOUS SMOKE TRAILS — camera-facing ribbons through a history of emission points =====
  // (1.3.9 puffs 7–9 u apart behind a 150 u/s 109 read as a string of beads). Points are left in the air mass and
  // drift aft with it; the ribbon widens and fades with age; the texture is lumpy along its length and fixed to
  // the smoke (v is assigned at emission) so it billows instead of sliding.
  const RIB_N = 44, RIB_P = 64;
  const ribTex = (() => {
    const W = 64, H = 256, c = document.createElement("canvas"); c.width = W; c.height = H; const x = c.getContext("2d"); const img = x.createImageData(W, H);
    let sd = 99; const R = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
    const blobs = []; for (let k = 0; k < 60; k++) blobs.push([R() * W, R() * H, 6 + R() * 16, 0.4 + R() * 0.6]);
    for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
      let n = 0; for (const [bx, by, br, ba] of blobs) { for (const oy of [-H, 0, H]) { const dx = (u - bx) / br, dy = (v - by - oy) / br, d = dx * dx + dy * dy; if (d < 1) n += ba * (1 - d) * (1 - d); } }
      const w = (u - (W - 1) / 2) / ((W - 1) / 2), across = Math.exp(-w * w * 3.2) * (1 - w * w);
      const a = Math.min(1, across * (0.45 + 0.75 * Math.min(1.2, n)));
      const o = (v * W + u) * 4; const l = 200 + 55 * Math.min(1, n); img.data[o] = l; img.data[o + 1] = l; img.data[o + 2] = l; img.data[o + 3] = 255 * a;
    }
    x.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapT = THREE.RepeatWrapping; return t;
  })();
  const ribMat = new THREE.MeshBasicMaterial({ map: ribTex, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true });
  const ribbons = [], ribByKey = new Map();
  {
    const idx = []; for (let i = 0; i < RIB_P - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    for (let r = 0; r < RIB_N; r++) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(RIB_P * 6), 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(RIB_P * 8), 4).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(RIB_P * 4), 2).setUsage(THREE.DynamicDrawUsage));
      g.setIndex(idx); g.setDrawRange(0, 0);
      const m = new THREE.Mesh(g, ribMat); m.frustumCulled = false; m.visible = false; m.renderOrder = 1; scene.add(m);
      ribbons.push({ key: null, pts: [], mesh: m, geo: g, v: 0, last: null, lastT: 0 });
    }
  }
  const ribStats = { emits: 0, live: 0 };
  function ribbonEmit(key, pos, o) {
    let rb = ribByKey.get(key);
    if (!rb) {
      rb = ribbons.find((q) => !q.pts.length) || ribbons.reduce((a, q) => (q.lastT < a.lastT ? q : a), ribbons[0]);
      if (rb.key != null) ribByKey.delete(rb.key);
      rb.key = key; rb.pts.length = 0; rb.v = Math.random() * 4; rb.last = null; ribByKey.set(key, rb);
    }
    if (rb.last) rb.v += rb.last.distanceTo(pos) / 9; else rb.last = new THREE.Vector3();
    rb.last.copy(pos); rb.lastT = pnow();
    if (rb.pts.length >= RIB_P) rb.pts.shift();
    let w0 = o.w0 || 0.4, w1 = o.w1 || 4, a = o.a || 0.5;
    if (CR.tailDim && typeof key === "string" && key.indexOf("own") === 0) { w0 *= 0.2; w1 *= 0.25; a *= 0.15; } // almost hide own trails looking aft // 1.6.1: aft view along own trails — keep readable, not a white wall
    rb.pts.push({ x: pos.x, y: pos.y, z: pos.z, age: 0, life: o.life || 2.5, w0, w1, a, c: o.col || [0.2, 0.2, 0.2], v: rb.v, dz: o.drift == null ? 55 : o.drift });
    ribStats.emits++;
  }
  const _rbA = new THREE.Vector3(), _rbT = new THREE.Vector3(), _rbS = new THREE.Vector3();
  function updateRibbons(dt) {
    let live = 0;
    for (const rb of ribbons) {
      const P = rb.pts;
      for (const p of P) { p.age += dt; p.z -= p.dz * dt; p.y += 0.35 * dt; }
      while (P.length && P[0].age >= P[0].life) P.shift();
      if (P.length < 2) { rb.mesh.visible = false; rb.geo.setDrawRange(0, 0); if (!P.length && rb.key != null) { ribByKey.delete(rb.key); rb.key = null; } continue; }
      live++;
      rb.mesh.visible = true;
      const pos = rb.geo.attributes.position.array, col = rb.geo.attributes.color.array, uv = rb.geo.attributes.uv.array;
      const n = P.length;
      for (let i = 0; i < n; i++) {
        const p = P[i], a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
        _rbT.set(b.x - a.x, b.y - a.y, b.z - a.z);
        _rbA.set(camera.position.x - p.x, camera.position.y - p.y, camera.position.z - p.z);
        _rbS.crossVectors(_rbT, _rbA); const L = _rbS.length() || 1;
        const k = p.age / p.life, w = (p.w0 + (p.w1 - p.w0) * Math.sqrt(k)) * 0.5;
        _rbS.multiplyScalar(w / L);
        const o = i * 6;
        pos[o] = p.x - _rbS.x; pos[o + 1] = p.y - _rbS.y; pos[o + 2] = p.z - _rbS.z;
        pos[o + 3] = p.x + _rbS.x; pos[o + 4] = p.y + _rbS.y; pos[o + 5] = p.z + _rbS.z;
        const al = p.a * Math.pow(1 - k, 1.3) * (i === n - 1 ? 0.35 : 1) * Math.min(1, p.age * 10 + 0.35);
        const c = i * 8; col[c] = p.c[0]; col[c + 1] = p.c[1]; col[c + 2] = p.c[2]; col[c + 3] = al; col[c + 4] = p.c[0]; col[c + 5] = p.c[1]; col[c + 6] = p.c[2]; col[c + 7] = al;
        const u = i * 4; uv[u] = 0; uv[u + 1] = p.v; uv[u + 2] = 1; uv[u + 3] = p.v;
      }
      rb.geo.setDrawRange(0, (n - 1) * 6);
      rb.geo.attributes.position.needsUpdate = true; rb.geo.attributes.color.needsUpdate = true; rb.geo.attributes.uv.needsUpdate = true;
    }
    ribStats.live = live;
  }
  // Smoke puffs (world-space, stream aft with the airflow)
  const smokePool = [];
  for (let i = 0; i < 150; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: smokeTex, color: 0x2a2a2a, transparent: true, depthWrite: false, opacity: 0,
    }));
    sp.visible = false;
    scene.add(sp);
    smokePool.push({ sp, life: 0, max: 1, vx: 0, vy: 0, vz: 0, s0: 1, s1: 4, a: 0.5 });
  }
  let smokeIdx = 0;
  function emitSmoke(pos, dark, big, o) {
    const p = smokePool[smokeIdx];
    smokeIdx = (smokeIdx + 1) % smokePool.length;
    p.sp.position.copy(pos);
    p.life = p.max = o && o.life ? o.life : big ? 3.2 : 2.4;
    p.vx = (Math.random() - 0.5) * 0.8;
    p.vy = 0.3 + Math.random() * 0.4;
    p.vz = o && o.vz ? o.vz * (0.85 + Math.random() * 0.3) : -9 - Math.random() * 3;
    p.s0 = o && o.s0 ? o.s0 : big ? 1.4 : 0.8;
    p.s1 = o && o.s1 ? o.s1 : big ? 7 : 4.5;
    p.a = o && o.a ? o.a : dark ? 0.55 : 0.35;
    p.sp.material.color.setHex(o && o.color != null ? o.color : dark ? 0x1e1e1e : 0x8a8a88);
    p.light = p.sp.material.color.r > 0.3; // 1.5.6: pale puffs are size-capped and fade out near the camera so they can never blank out a hull
    p.sp.visible = true;
  }
  function updateSmoke(dt) {
    for (const p of smokePool) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.sp.visible = false; continue; }
      const k = 1 - p.life / p.max;
      p.sp.position.x += p.vx * dt;
      p.sp.position.y += p.vy * dt;
      p.sp.position.z += p.vz * dt;
      let s = p.s0 + (p.s1 - p.s0) * k;
      let nf = 1; if (p.light) { if (s > 4.5) s = 4.5; const dx = p.sp.position.x - camera.position.x, dy = p.sp.position.y - camera.position.y, dz = p.sp.position.z - camera.position.z, dd = Math.sqrt(dx * dx + dy * dy + dz * dz); nf = dd < 8 ? 0 : dd > 30 ? 1 : (dd - 8) / 22; }
      p.sp.scale.set(s, s, 1);
      p.sp.material.opacity = p.a * (1 - k) * Math.min(1, k * 6 + 0.2) * nf;
    }
  }

  // ===== 1.5.4 ENGINE-FIRE TONGUE: a chain of additive flame sprites streaming aft from a burning nacelle (bright core -> orange -> red -> gone in ~0.5 s, ~10 u long),
  //       with dark fragments / glowing embers thrown into the (longer, darker) smoke plume =====
  const flamePool = [];
  for (let i = 0; i < 150; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: flameTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, fog: false }));
    sp.visible = false; sp.center.set(0.5, 0.5); scene.add(sp);
    flamePool.push({ sp, life: 0, max: 1, vx: 0, vy: 0, vz: 0, s0: 1, s1: 0.5 });
  }
  let flameIdx = 0;
  const flameStats = { emitted: 0, frags: 0 };
  function emitFlame(pos, fire) {
    const p = flamePool[flameIdx]; flameIdx = (flameIdx + 1) % flamePool.length;
    p.sp.position.copy(pos); p.life = p.max = 0.32 + Math.random() * 0.22 + 0.2 * fire;
    p.vx = (Math.random() - 0.5) * 2.4; p.vy = 0.8 + Math.random() * 1.6; p.vz = -(20 + Math.random() * 12 + 14 * fire);
    p.s0 = (0.9 + 1.1 * fire) * (0.8 + Math.random() * 0.4); p.s1 = p.s0 * 0.35;
    p.sp.visible = true; flameStats.emitted++;
  }
  function updateFlames(dt) {
    for (const p of flamePool) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.sp.visible = false; continue; }
      const k = 1 - p.life / p.max;
      p.sp.position.x += p.vx * dt; p.sp.position.y += p.vy * dt; p.sp.position.z += p.vz * dt;
      const s = p.s0 + (p.s1 - p.s0) * k; p.sp.scale.set(s * 0.8, s * 1.6, 1);
      p.sp.material.color.setRGB(1, 1 - 0.62 * k, 0.55 - 0.5 * k); // white-yellow at the nacelle -> deep orange-red
      p.sp.material.opacity = 0.95 * (1 - k * k);
    }
  }
  function emitFragment(pos, hot) { // a dark chunk (or glowing ember) in the plume — rides the flak-debris point pool
    const d = deb[debNext]; debNext = (debNext + 1) % DEB_N;
    d.x = pos.x; d.y = pos.y; d.z = pos.z; d.vx = (Math.random() - 0.5) * 7; d.vy = (Math.random() - 0.4) * 6; d.vz = -(5 + Math.random() * 18);
    d.hot = !!hot; d.t = 0; d.life = hot ? 0.5 + Math.random() * 0.5 : 1.8 + Math.random() * 1.6; flameStats.frags++;
  }
  function engineFireFx(pos, fire, dt, acc) { // call per burning engine per frame: acc is a per-engine accumulator object {t}
    acc.t -= dt;
    for (let n = 0; n < 3 && acc.t <= 0; n++) { emitFlame(pos, fire); acc.t += 0.028; }
    if (acc.t < 0) acc.t = 0;
    if (Math.random() < 5.5 * dt) emitFragment(pos, Math.random() < 0.4);
  }

  // Procedural northern-European farmland 200u (20,000 ft) below
  const GROUND_Y = -192;
  // 1.3.2: natural northern-European patchwork seen from ~20,000 ft.
  // Tileable jittered-Voronoi fields (irregular shapes, varied greens/yellows/browns, plough
  // striping), soft hedgerow edges, woods, villages, roads and a river; mipmapped + anisotropic.
  // A second/third lower-frequency lookup in the shader breaks up the tiling (see ground mat).
  const farmTex = (() => {
    const N = 1024, CELL = 26;
    const G = Math.ceil(N / CELL);
    const c = document.createElement("canvas");
    c.width = c.height = N;
    const x = c.getContext("2d");
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const pal = [
      [98, 110, 66], [108, 118, 72], [90, 104, 60], [122, 126, 80], [136, 132, 88],
      [150, 142, 98], [116, 106, 76], [104, 96, 70], [94, 108, 64], [128, 134, 86],
      [84, 98, 58], [140, 138, 100],
    ];
    // Farm blocks = coarse Voronoi cells (each with its own orientation); inside a block the
    // land is cut into rectangular parcels/strips aligned to that orientation (real patchwork).
    const img = x.createImageData(N, N);
    const d = img.data;
    const hash = (a, b, c) => { let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967295; };
    const BLK = 96, GB = Math.ceil(N / BLK);
    const blocks = [];
    for (let j = 0; j < GB; j++) for (let i = 0; i < GB; i++) {
      const w1 = 7 + rnd() * 10, w2 = 14 + rnd() * 26;
      blocks.push({ x: (i + 0.2 + rnd() * 0.6) * BLK, y: (j + 0.2 + rnd() * 0.6) * BLK, a: rnd() * Math.PI, w1, w2, id: j * GB + i });
    }
    for (let py = 0; py < N; py++) {
      const gj = (py / BLK) | 0;
      for (let px = 0; px < N; px++) {
        const gi = (px / BLK) | 0;
        let d1 = 1e9, d2 = 1e9, best = null;
        for (let oj = -1; oj <= 1; oj++) for (let oi = -1; oi <= 1; oi++) {
          let ci = gi + oi, cj = gj + oj, sx = 0, sy = 0;
          if (ci < 0) { ci += GB; sx = -N; } else if (ci >= GB) { ci -= GB; sx = N; }
          if (cj < 0) { cj += GB; sy = -N; } else if (cj >= GB) { cj -= GB; sy = N; }
          const p = blocks[cj * GB + ci];
          const dx = p.x + sx - px, dy = p.y + sy - py;
          const dd = dx * dx + dy * dy;
          if (dd < d1) { d2 = d1; d1 = dd; best = p; } else if (dd < d2) d2 = dd;
        }
        const ca = Math.cos(best.a), sa = Math.sin(best.a);
        const u = px * ca + py * sa, v = -px * sa + py * ca;
        const iu = Math.floor(u / best.w1), iv = Math.floor(v / best.w2);
        const fu = u / best.w1 - iu, fv = v / best.w2 - iv;
        const hsh = hash(best.id, iu, iv);
        const pc = pal[(hsh * pal.length) | 0];
        const k = 0.92 + hash(iv, best.id, iu) * 0.14;
        // crop rows inside some parcels
        const rows = hsh > 0.6 ? Math.sin(u * 2.2) * 0.035 : 0;
        let r = pc[0] * (k + rows), g = pc[1] * (k + rows), b = pc[2] * (k + rows);
        // parcel boundaries (thin, soft) and block edges (hedgerows / lanes)
        const eu = Math.min(fu, 1 - fu) * best.w1, ev = Math.min(fv, 1 - fv) * best.w2;
        const pe = Math.min(eu, ev);
        if (pe < 0.9) { const q = (1 - pe / 0.9) * 0.22; r = r * (1 - q) + 58 * q; g = g * (1 - q) + 70 * q; b = b * (1 - q) + 42 * q; }
        const be = Math.sqrt(d2) - Math.sqrt(d1);
        if (be < 2.2) { const q = (1 - be / 2.2) * 0.5; r = r * (1 - q) + 52 * q; g = g * (1 - q) + 64 * q; b = b * (1 - q) + 38 * q; }
        const o = (py * N + px) * 4;
        d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
      }
    }
    x.putImageData(img, 0, 0);
    // Tile-safe drawing helper: draw at the 9 wrap offsets
    const wrap = (fn) => { for (const ox of [-N, 0, N]) for (const oy of [-N, 0, N]) { x.save(); x.translate(ox, oy); fn(); x.restore(); } };
    // Woods: clumps of dark soft blobs
    for (let k = 0; k < 16; k++) {
      const cx = rnd() * N, cy = rnd() * N, n = 6 + ((rnd() * 10) | 0);
      const blobs = [];
      for (let i = 0; i < n; i++) blobs.push([cx + (rnd() - 0.5) * 60, cy + (rnd() - 0.5) * 40, 6 + rnd() * 12]);
      wrap(() => {
        for (const [bx, by, br] of blobs) {
          const gr = x.createRadialGradient(bx, by, 0, bx, by, br);
          gr.addColorStop(0, "rgba(40,56,32,0.9)");
          gr.addColorStop(0.7, "rgba(46,62,36,0.7)");
          gr.addColorStop(1, "rgba(52,68,40,0)");
          x.fillStyle = gr;
          x.beginPath(); x.arc(bx, by, br, 0, Math.PI * 2); x.fill();
        }
      });
    }
    // 1.6.0: the large forests and the big rivers live in the separate, much larger MACRO texture (macroTex) — not in this 10 km tile, where they repeated visibly and darkened the shader's low-frequency modulation
    // River: meandering, crosses the tile top→bottom (enters/exits at the same x → seamless)
    {
      const x0 = rnd() * N;
      const ctrl = [x0, x0 + 90, x0 - 110, x0 + 60, x0];
      wrap(() => {
        x.strokeStyle = "rgba(70,86,64,0.8)"; x.lineWidth = 9; x.lineCap = "round";
        const path = () => { x.beginPath(); x.moveTo(ctrl[0], 0);
          x.bezierCurveTo(ctrl[1], N * 0.25, ctrl[2], N * 0.5, ctrl[2] + 20, N * 0.6);
          x.bezierCurveTo(ctrl[2] + 40, N * 0.7, ctrl[3], N * 0.85, ctrl[4], N); };
        path(); x.stroke();
        x.strokeStyle = "rgba(96,116,124,0.95)"; x.lineWidth = 4.5; path(); x.stroke();
      });
    }
    // Roads: pale thin lines crossing the tile (seamless: same edge coordinate in/out)
    for (let k = 0; k < 4; k++) {
      const horiz = k % 2 === 0, a0 = rnd() * N, m1 = (rnd() - 0.5) * 160, m2 = (rnd() - 0.5) * 160;
      wrap(() => {
        x.strokeStyle = "rgba(176,168,140,0.5)"; x.lineWidth = 1.4;
        x.beginPath();
        if (horiz) { x.moveTo(0, a0); x.bezierCurveTo(N * 0.33, a0 + m1, N * 0.66, a0 + m2, N, a0); }
        else { x.moveTo(a0, 0); x.bezierCurveTo(a0 + m1, N * 0.33, a0 + m2, N * 0.66, a0, N); }
        x.stroke();
      });
    }
    // Villages: small clusters of red-brown roofs and grey walls
    for (let k = 0; k < 12; k++) {
      const cx = rnd() * N, cy = rnd() * N, n = 10 + ((rnd() * 18) | 0);
      const houses = [];
      for (let i = 0; i < n; i++) houses.push([cx + (rnd() - 0.5) * 22, cy + (rnd() - 0.5) * 18, 1.5 + rnd() * 2.2, rnd() < 0.6]);
      wrap(() => {
        x.fillStyle = "rgba(150,146,130,0.55)";
        x.beginPath(); x.ellipse(cx, cy, 15, 12, 0, 0, Math.PI * 2); x.fill();
        for (const [hx, hy, hs, red] of houses) {
          x.fillStyle = red ? "rgba(140,72,54,0.95)" : "rgba(170,164,150,0.95)";
          x.fillRect(hx, hy, hs, hs * 0.8);
        }
      });
    }
    // 1.6.0 SMALL VILLAGES: ~40 hamlets of 4-11 roofs strung along a short lane (so they read as places, not noise)
    for (let k = 0; k < 40; k++) {
      const cx = rnd() * N, cy = rnd() * N, n = 4 + ((rnd() * 8) | 0), ang = rnd() * Math.PI, ca = Math.cos(ang), sa = Math.sin(ang), len = 6 + rnd() * 8;
      wrap(() => {
        x.strokeStyle = "rgba(170,162,134,0.7)"; x.lineWidth = 1.1;
        x.beginPath(); x.moveTo(cx - ca * (len + 4), cy - sa * (len + 4)); x.lineTo(cx + ca * (len + 4), cy + sa * (len + 4)); x.stroke();
        for (let i = 0; i < n; i++) {
          const t2 = (rnd() - 0.5) * 2 * len, off = (rnd() < 0.5 ? -1 : 1) * (2.2 + rnd() * 2.2), hx = cx + ca * t2 - sa * off, hy = cy + sa * t2 + ca * off, hs = 1.6 + rnd() * 1.8;
          x.fillStyle = rnd() < 0.62 ? "rgba(146,76,56,0.95)" : "rgba(172,166,152,0.95)";
          x.fillRect(hx - hs / 2, hy - hs * 0.4, hs, hs * 0.8);
        }
      });
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(60, 60); // 1 tile ≈ 1000u; fields ≈ 25u
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 4);
    return t;
  })();
  // 1.6.0 MACRO LAND LAYER: large forests + big rivers (with tributaries that JOIN them, never cross) on their own 2048² tile, ~3.7x the farm tile (~38 km) and rotated 23° to it,
  // so neither repeats in step with the fields; sampled by the ground shader (uMacro) and laid over the field colour before the 1.5.9 tone chain (haze/fog untouched)
  const MACRO_REP = 3.7, MACRO_ROT = 0.4;
  const macroTex = (() => {
    const N = 2048, c = document.createElement("canvas"); c.width = c.height = N; const x = c.getContext("2d");
    let seed = 2026; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const wrap = (ctx, fn) => { for (const ox of [-N, 0, N]) for (const oy of [-N, 0, N]) { ctx.save(); ctx.translate(ox, oy); fn(ctx); ctx.restore(); } };
    // --- forests: solid canopy mask (random-walk arms of round crowns-of-wood), softened edge, then crown mottling painted only inside the wood
    const L = document.createElement("canvas"); L.width = L.height = N; const lx = L.getContext("2d");
    const woods = [];
    for (let k = 0; k < 15; k++) {
      const cx = rnd() * N, cy = rnd() * N, arms = 2 + ((rnd() * 4) | 0), big = 0.7 + rnd() * 0.8;
      for (let a = 0; a < arms; a++) {
        let fx = cx, fy = cy, ang = rnd() * Math.PI * 2; const steps = 8 + ((rnd() * 22 * big) | 0);
        for (let i = 0; i < steps; i++) { ang += (rnd() - 0.5) * 1.1; fx += Math.cos(ang) * 11; fy += Math.sin(ang) * 11; woods.push([fx + (rnd() - 0.5) * 14, fy + (rnd() - 0.5) * 14, (12 + rnd() * 20) * big]); }
      }
    }
    for (let k = 0; k < 40; k++) { const cx = rnd() * N, cy = rnd() * N, n = 2 + ((rnd() * 5) | 0); for (let i = 0; i < n; i++) woods.push([cx + (rnd() - 0.5) * 40, cy + (rnd() - 0.5) * 40, 7 + rnd() * 11]); } // copses
    lx.fillStyle = "rgb(48,66,38)";
    wrap(lx, (q) => { for (const [bx, by, br] of woods) { q.beginPath(); q.arc(bx, by, br, 0, Math.PI * 2); q.fill(); } });
    lx.globalCompositeOperation = "source-atop";
    wrap(lx, (q) => { for (const [bx, by, br] of woods) for (let m = 0; m < 7; m++) { const r2 = 1.0 + rnd() * 2.0; q.fillStyle = rnd() < 0.5 ? "rgba(76,98,56,0.6)" : "rgba(30,44,24,0.6)"; q.beginPath(); q.arc(bx + (rnd() - 0.5) * br * 1.6, by + (rnd() - 0.5) * br * 1.6, r2, 0, Math.PI * 2); q.fill(); } });
    lx.globalCompositeOperation = "source-over";
    try { x.filter = "blur(1.6px)"; } catch (e) {}
    x.globalAlpha = 0.9; for (const ox of [-N, 0, N]) for (const oy of [-N, 0, N]) x.drawImage(L, ox, oy);
    x.globalAlpha = 1; try { x.filter = "none"; } catch (e) {}
    L.width = L.height = 1;
    // --- rivers: two big meandering rivers (periodic in x, half a tile apart: they can never meet) + tributaries that flow into them
    const strokeRiver = (pts, w) => wrap(x, (q) => {
      const path = () => { q.beginPath(); q.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) q.lineTo(pts[i][0], pts[i][1]); };
      q.lineCap = "round"; q.lineJoin = "round";
      q.strokeStyle = "rgba(58,82,46,0.5)"; q.lineWidth = w * 2.6; path(); q.stroke();
      q.strokeStyle = "rgba(78,96,70,0.8)"; q.lineWidth = w * 1.5; path(); q.stroke();
      q.strokeStyle = "rgba(100,122,132,0.96)"; q.lineWidth = w; path(); q.stroke();
    });
    const mains = [];
    for (let r = 0; r < 2; r++) {
      const y0 = N * (0.22 + 0.5 * r) + (rnd() - 0.5) * 60, H = [[1, 70 + rnd() * 60], [2, 30 + rnd() * 30], [5, 16 + rnd() * 14], [11, 6 + rnd() * 5], [19, 3]].map(([k, A]) => [k, A, rnd() * 6.283]);
      const f = (xx) => { let y = y0; for (const [k, A, ph] of H) y += A * Math.sin(6.2832 * k * xx / N + ph); return y; };
      mains.push(f); const pts = []; for (let xx = 0; xx <= N; xx += 3) pts.push([xx, f(xx)]);
      strokeRiver(pts, r ? 6.5 : 9);
    }
    for (let k = 0; k < 5; k++) { // tributaries: rise half-way between the rivers, wander, and end ON the nearer one
      const r = k % 2, f = mains[r], g = mains[1 - r]; let xx = rnd() * N; const yS = (f(xx) + g(xx) + (r ? 0 : N)) * 0.5 % N, pts = [];
      const steps = 70; let yy = yS; const dir = (((f(xx) - yS) % N + N * 1.5) % N - N * 0.5) > 0 ? 1 : -1;
      for (let i = 0; i <= steps; i++) { pts.push([xx, yy]); xx += Math.sin(i * 0.31 + k) * 4 + (rnd() - 0.5) * 3; const tgt = f(xx); let dy = ((tgt - yy) % N + N * 1.5) % N - N * 0.5; if (Math.abs(dy) < 4) { pts.push([xx, yy + dy]); break; } yy += Math.sign(dy) * Math.min(Math.abs(dy), 6 + i * 0.12); }
      strokeRiver(pts, 3.4); void dir;
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    t.anisotropy = window.__FG_MACRO_ANI != null ? window.__FG_MACRO_ANI : Math.min(4, renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 4); // 1.6.0 perf: x4 is plenty for this soft, low-frequency layer (was x8)
    return t;
  })();
  const horizonHaze = (() => {
    const c = document.createElement("canvas");
    c.width = 4; c.height = 256;
    const x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, 0, 256);
    // canvas top → cylinder BOTTOM (CanvasTexture flipY) — opaque low, clear high
    g.addColorStop(0, "rgba(127,169,218,0)");
    g.addColorStop(0.55, "rgba(127,169,218,0.22)");
    g.addColorStop(0.75, "rgba(127,169,218,0.12)");
    g.addColorStop(1, "rgba(127,169,218,0)");
    x.fillStyle = g;
    x.fillRect(0, 0, 4, 256);
    const tx = new THREE.CanvasTexture(c);
    tx.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(14000, 14000, 900, 64, 1, true),
      new THREE.MeshBasicMaterial({ map: tx, transparent: true, depthWrite: false, side: THREE.BackSide, fog: false })
    );
    m.position.y = -260; // spans ~ -2.9° .. +0.8°: softens the far-ground/sky seam only
    m.renderOrder = -1;
    scene.add(m);
    return m;
  })();
  // 1.3.6: the Earth ~2.1 km below the box (EARTH_K = 7 × the 202u local depth), scaled about the camera.
  // The ground no longer "scrolls a texture": a ground FRAME (ground + town + bomb smoke) is placed each
  // frame from the game's ground odometer (geo.x/z/rot, world units) — it moves past at exactly the
  // box's 280 mph ground speed and rotates with the box's heading, so everything flying (109s, clouds,
  // flak) now reads against a ground that really moves at 280 mph.
  const cloudShadowTex = (() => { // tileable soft blotches (cloud shadows on the ground)
    const N = 256, c = document.createElement("canvas"); c.width = c.height = N; const x = c.getContext("2d");
    x.fillStyle = "#000"; x.fillRect(0, 0, N, N);
    let sd = 31; const R = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
    for (let k = 0; k < 26; k++) { const cx = R() * N, cy = R() * N, r = 10 + R() * 26, n = 4 + ((R() * 5) | 0);
      for (let i = 0; i < n; i++) { const bx = cx + (R() - 0.5) * r * 1.6, by = cy + (R() - 0.5) * r, br = r * (0.5 + R() * 0.6);
        for (const ox of [-N, 0, N]) for (const oy of [-N, 0, N]) { const g = x.createRadialGradient(bx + ox, by + oy, 0, bx + ox, by + oy, br); g.addColorStop(0, "rgba(255,255,255,0.55)"); g.addColorStop(1, "rgba(255,255,255,0)"); x.fillStyle = g; x.beginPath(); x.arc(bx + ox, by + oy, br, 0, Math.PI * 2); x.fill(); } } }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  })();
  // 1.5.8: the formation really flies at 25,000 ft: 7,620 m = 5,080 u (1 u = 1.5 m) above the ground (was 7 x 202 = 1,414 u ~ 7,000 ft). The Earth is scaled about the camera by EARTH_K;
  // everything on it that was authored for the old K = 7 (town, craters, bomb bursts) lives in `landG`, scaled KR = 7/K, so its WORLD size is unchanged (but it now sits 3.6x farther away).
  const ALT_U = 5080, K_LAND = 7, FARM_REP = 2.4;
  const EARTH_K = ALT_U / (CAM.y - GROUND_Y);
  const KR = K_LAND / EARTH_K;
  const earth = new THREE.Group();
  earth.scale.setScalar(EARTH_K);
  earth.position.set(CAM.x * (1 - EARTH_K), CAM.y * (1 - EARTH_K), CAM.z * (1 - EARTH_K));
  scene.add(earth);
  // 1.5.9: the earth fog depends on the VIEW ANGLE again, like 1.5.7 (depth / EARTH_K, near = scene fog near) and a further 35 % clearer (depth / (1.35 x EARTH_K)). 1.5.8 fogged the raw depth from 1,575 u, i.e. ~25x thicker for the same line of sight at 25,000 ft.
  const earthFog = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace("#include <fog_fragment>",
      "#ifdef USE_FOG\n  float fogFactor = smoothstep( fogNear, fogFar, vFogDepth / " + (EARTH_K * 1.35).toFixed(1) + " );\n  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );\n#endif");
  };
  const groundFrame = new THREE.Group();
  groundFrame.position.y = GROUND_Y;
  earth.add(groundFrame);
  const landG = new THREE.Group(); landG.scale.setScalar(KR); groundFrame.add(landG);
  farmTex.repeat.set(92 * FARM_REP, 92 * FARM_REP); // 1.5.8: real 25,000 ft: fields keep their (old) world size scaled by the new altitude
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60000, 60000),
    (() => {
      const m = new THREE.MeshBasicMaterial({ map: farmTex, color: 0xc4cab6, fog: true });
      m.onBeforeCompile = (sh) => {
        sh.uniforms.uShadow = { value: cloudShadowTex }; sh.uniforms.uMacro = { value: macroTex };
        sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nuniform sampler2D uShadow;\nuniform sampler2D uMacro;").replace("#include <map_fragment>", `
#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  vec2 muv = mat2(${Math.cos(MACRO_ROT).toFixed(5)}, ${Math.sin(MACRO_ROT).toFixed(5)}, ${(-Math.sin(MACRO_ROT)).toFixed(5)}, ${Math.cos(MACRO_ROT).toFixed(5)}) * vMapUv * ${(1 / MACRO_REP).toFixed(5)} + vec2(0.31, 0.17);
  vec4 mac = texture2D( uMacro, muv );
  sampledDiffuseColor.rgb = mix( sampledDiffuseColor.rgb, mac.rgb, mac.a ); // 1.6.0 forests + rivers
  vec3 lo1 = texture2D( map, vMapUv * 0.113 + vec2(0.37, 0.61) ).rgb;
  vec3 lo2 = texture2D( map, vec2(vMapUv.y, -vMapUv.x) * 0.031 + vec2(0.2, 0.7) ).rgb;
  float l1 = dot(lo1, vec3(0.333)), l2 = dot(lo2, vec3(0.333));
  vec3 col = sampledDiffuseColor.rgb * (0.72 + 0.62 * l1 + 0.0);
  col = mix(col, col * vec3(1.06, 1.04, 0.9), smoothstep(0.35, 0.55, l2));
  col = mix(col, (lo1 + sampledDiffuseColor.rgb) * 0.5, 0.18);
  float gl = dot(col, vec3(0.3, 0.55, 0.15));
  col = mix(vec3(gl), col, 1.0); // 1.5.1: natural colour (was desaturated)
  // 1.4.0: seen from 25,000 ft — soft cloud shadows from the deck below us, then a veil of blue-grey air even straight down
  float shd = texture2D(uShadow, vMapUv * 0.9 + vec2(0.13, 0.41)).r * 0.65 + texture2D(uShadow, vMapUv * 0.37 + vec2(0.7, 0.2)).r * 0.35;
  col *= 1.0 - 0.34 * smoothstep(0.35, 0.75, shd);
  col = mix(col, vec3(0.45, 0.58, 0.76), 0.04);
  diffuseColor.rgb *= col;
#endif
`);
        earthFog(sh);
      };
      return m;
    })()
  );
  ground.rotation.x = -Math.PI / 2;
  groundFrame.add(ground);

  // 1.3.6 TARGET: a small German town with a railway depot (local units: 1 = 10 world u ≈ 15 m).
  // Rail yard (12 tracks, wagons), engine shed, roundhouse + turntable, station, a river with a
  // bridge, streets with gabled roofs, a church, a few sheds/works along the yard.
  const TOWN_Z = 1238;          // ground-frame local z (1.5.7: 1653 → 1048 for the 180 mph box): ~24 s of ground travel ahead at release = where the sticks land (world z = geo.z + K·TOWN_Z)
  const TOWN_X = -15.3;             // 1.5.2: dead on our ground track (was 300 = 3 km to port, so the bombs never hit it)
  const town = new THREE.Group();
  town.position.set(TOWN_X, 3.2, TOWN_Z); // 1.6.1: ~22 world-u above the farm plane (was 0.05→0.35u) so depth precision at 25,000 ft does not z-fight the town away
  const TOWN_S = 1.5 * Math.sqrt(15); // 1.6.0: the town is 15x larger BY AREA (x3.873 linear on the 1.5.9 footprint, ≈ 6 km across, readable from 25,000 ft)
  town.scale.set(TOWN_S, TOWN_S, TOWN_S);
  landG.add(town);
  // 1.6.1: city blotch on landG (not inside town scale) — a dark disc + street grid that always reads from 25,000 ft
  {
    const N = 256, c = document.createElement("canvas"); c.width = c.height = N; const x = c.getContext("2d");
    x.fillStyle = "#2e2a26"; x.beginPath(); x.arc(N/2, N/2, N*0.48, 0, Math.PI*2); x.fill();
    x.fillStyle = "#252220"; x.beginPath(); x.arc(N/2-10, N/2, N*0.22, 0, Math.PI*2); x.fill();
    x.strokeStyle = "rgba(170,160,150,0.45)"; x.lineWidth = 2;
    for (let i = -5; i <= 5; i++) {
      x.beginPath(); x.moveTo(20, N/2 + i*18); x.lineTo(N-20, N/2 + i*18); x.stroke();
      x.beginPath(); x.moveTo(N/2 + i*18, 20); x.lineTo(N/2 + i*18, N-20); x.stroke();
    }
    x.fillStyle = "rgba(40,70,90,0.55)"; // river through city
    x.fillRect(N*0.42, 10, N*0.08, N-20);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.92, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -12, polygonOffsetUnits: -12 });
    // size in landG units: town is ~TOWN_S*60 across; use ~90 so blotch ≈ town footprint in world
    const blot = new THREE.Mesh(new THREE.CircleGeometry(TOWN_S * 55, 48), mat);
    blot.rotation.x = -Math.PI / 2; blot.position.set(TOWN_X, 0.35, TOWN_Z); blot.renderOrder = 4; blot.frustumCulled = false;
    landG.add(blot);
  }
  const townMats = [];
  // 1.5.3: the town's structures as data (town-local x, z, half-width, half-depth, yaw) so game.js can resolve real bomb landings against them
  const TL = { houses: [], keys: [], stalls: [], wagons: [], tracks: [] };
  const TS = { houseM: [], wagonM: [], walls: null, roofs: null, wagons: null, keyMesh: [], stallMesh: [], craters: null, nCr: 0, rubble: null, hit: new Set() };
  {
    let seed = 1936;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const lam = (c) => { const m = new THREE.MeshLambertMaterial({ color: c, fog: true, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8 }); townMats.push(m); return m; };
    const bas = (c, o) => { const m = new THREE.MeshBasicMaterial(Object.assign({ color: c, fog: true, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8 }, o || {})); townMats.push(m); return m; };
    const YD_X = -13.3, YD_Z = -36.5; // the depot hall (yard-aligned (0,-39) in town-local coords): no houses on it
    const YARD_A = 0.0; // 1.6.0: the yard / depot / factory complex lies ALONG the bomb track (was tilted 0.35 rad)
    const KC = 0.4, VS = 0.7; // 1.6.0: the target complex keeps ~its 1.5.9 physical size (x0.28 of the x3.87 town), yard 30 % shorter, so a real stick of bombs can still catch depot AND factory
    const CXG = new THREE.Group(); CXG.scale.set(KC, KC, KC); town.add(CXG);
    // canvas texture for the yard: ballast bed, rails, wagons in rows
    const yardTex = (() => {
      const c = document.createElement("canvas"); c.width = 128; c.height = 1024;
      const x = c.getContext("2d");
      x.fillStyle = "#6e6a60"; x.fillRect(0, 0, 128, 1024);
      for (let i = 0; i < 2600; i++) { const v = 90 + rnd() * 40 | 0; x.fillStyle = "rgba(" + v + "," + (v - 4) + "," + (v - 10) + ",0.5)"; x.fillRect(rnd() * 128, rnd() * 1024, 2, 2); }
      const n = 12;
      for (let t = 0; t < n; t++) {
        const cx = 8 + t * (112 / (n - 1));
        x.fillStyle = "rgba(48,44,40,0.9)"; x.fillRect(cx - 2.5, 0, 5, 1024); // ballast + sleepers
        x.fillStyle = "rgba(150,146,140,0.8)"; x.fillRect(cx - 1.5, 0, 0.8, 1024); x.fillRect(cx + 0.8, 0, 0.8, 1024);
        // strings of wagons on most tracks
        let y = rnd() * 80;
        while (y < 1000) {
          const run = 60 + rnd() * 260;
          if (rnd() < 0.72) for (let k = 0; k < run; k += 13) {
            const col = rnd() < 0.5 ? "rgb(86,62,48)" : rnd() < 0.5 ? "rgb(70,72,70)" : "rgb(104,88,70)";
            x.fillStyle = col; x.fillRect(cx - 3, y + k, 6, 11);
          }
          y += run + 20 + rnd() * 90;
        }
      }
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
      t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
      return t;
    })();
    const yard = new THREE.Mesh(new THREE.PlaneGeometry(6.2, 58 * VS), bas(0xffffff, { map: yardTex }));
    yard.rotation.set(-Math.PI / 2, 0, YARD_A);
    CXG.add(yard);
    // main line out of town both ways (a thin dark line across the countryside)
    const line = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 900), bas(0x3e3a34));
    line.rotation.set(-Math.PI / 2, 0, YARD_A); line.position.y = -0.01;
    town.add(line);
    const branch = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 500), bas(0x423e38));
    branch.rotation.set(-Math.PI / 2, 0, YARD_A + 0.9); branch.position.set(-2, -0.01, -26);
    town.add(branch);
    const ax = (u, v) => { // yard-aligned coordinates → town local
      const c = Math.cos(YARD_A), s = Math.sin(YARD_A);
      v *= VS; return [u * c + v * s, -u * s + v * c];
    };
    // freight wagons in 3D (catch the sun), engine shed, roundhouse, station
    const wagonGeo = new THREE.BoxGeometry(0.2, 0.2, 0.85);
    const wagons = new THREE.InstancedMesh(wagonGeo, lam(0x5a4638), 140);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1), pv = new THREE.Vector3();
    const yq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), YARD_A);
    for (let i = 0; i < 140; i++) {
      const tr = (rnd() * 12) | 0, u = -3.1 + 0.25 + tr * (5.7 / 11), v = -26 + rnd() * 52;
      const [px, pz] = ax(u, v);
      pv.set(px, 0.1, pz); m4.compose(pv, yq, sc); wagons.setMatrixAt(i, m4); TL.wagons.push([px, pz, 0.1, 0.425, YARD_A]); TS.wagonM.push(m4.clone());
      const tint = 0.75 + rnd() * 0.5; wagons.setColorAt(i, new THREE.Color(0x5a4638).multiplyScalar(tint));
    }
    CXG.add(wagons); TS.wagons = wagons;
    for (let tr = 0; tr < 12; tr++) for (let j = 0; j < 13; j++) { const [tx, tz] = ax(-3.1 + 0.25 + tr * (5.7 / 11), -24 + 4 * j); TL.tracks.push([tx, tz, 0.15, 2.0 * VS, YARD_A]); }
    const box = (w, h, d, u, v, mat, rotExtra) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      const [px, pz] = ax(u, v); m.position.set(px, h / 2, pz); m.rotation.y = YARD_A + (rotExtra || 0);
      CXG.add(m); return m;
    };
    const keyB = (name, w, d, u, v, m, kind) => { const [px, pz] = ax(u, v); TL.keys.push([px, pz, w / 2, d / 2, YARD_A, name, kind || "d"]); TS.keyMesh.push(m); return m; }; // kind: "d" = depot target, "f" = factory target
    const roofDark = lam(0x4a4642), brick = lam(0x7a5a4a), stone = lam(0x9a968c);
    keyB("engine shed", 2.2, 9, 4.6, 12, box(2.2, 0.7, 9, 4.6, 12, roofDark));           // engine shed (long, dark)
    keyB("station", 1.6, 5.5, -4.8, -2, box(1.6, 0.9, 5.5, -4.8, -2, stone));           // station building
    keyB("goods shed", 1.0, 1.4, -4.8, -6.2, box(1.0, 0.6, 1.4, -4.8, -6.2, brick));         // goods shed
    keyB("works", 3.2, 1.8, 5.2, -14, box(3.2, 0.9, 1.8, 5.2, -14, brick), "d");           // works / warehouse
    keyB("goods hall", 2.4, 3.2, -6.2, 16, box(2.4, 1.1, 3.2, -6.2, 16, brick), "d");           // factory hall
    { // roundhouse: a 3/4 ring of stalls around a turntable
      const [cx, cz] = ax(5.5, 22);
      const tt = new THREE.Mesh(new THREE.CircleGeometry(0.8, 20), bas(0x4a4640));
      tt.rotation.x = -Math.PI / 2; tt.position.set(cx, 0.02, cz); CXG.add(tt);
      for (let k = 0; k < 14; k++) {
        const a = -0.6 + k * (4.2 / 13);
        const st = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.45, 1.5), roofDark);
        st.position.set(cx + Math.cos(a) * 1.9, 0.22, cz + Math.sin(a) * 1.9);
        st.rotation.y = -a + Math.PI / 2; CXG.add(st); TL.stalls.push([st.position.x, st.position.z, 0.31, 0.75, st.rotation.y]); TS.stallMesh.push(st);
      }
    }
    // river with a bridge where the main line crosses
    {
      const pts = [];
      for (let k = 0; k <= 24; k++) { const t = k / 24; pts.push(new THREE.Vector2(-70 + t * 140, 28 * Math.sin(t * 3.1 + 0.4) - 30 + t * 18)); }
      const shape = [];
      const pos = [], idx = [];
      for (let k = 0; k < pts.length; k++) {
        const p = pts[k], q2 = pts[Math.min(pts.length - 1, k + 1)], p0 = pts[Math.max(0, k - 1)];
        const dx = q2.x - p0.x, dy = q2.y - p0.y, l = Math.hypot(dx, dy) || 1, w = 1.6 + Math.sin(k) * 0.3;
        pos.push(p.x - dy / l * w, 0.015, p.y + dx / l * w, p.x + dy / l * w, 0.015, p.y - dx / l * w);
        if (k) { const a = (k - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      }
      void shape;
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
      const river = new THREE.Mesh(g, bas(0x46545a, { side: THREE.DoubleSide }));
      town.add(river);
    }
    // streets (pale) + houses (walls + gabled roofs, instanced)
    const streetM = bas(0x8e8a80);
    const streets = [];
    for (let k = -4; k <= 3; k++) streets.push([k * 7.5 - 12, 0, 0.35, 56, 0.12]);
    for (let k = -4; k <= 4; k++) streets.push([-16, k * 6.5, 62, 0.35, 0.12]);
    streets.push([-8, -4, 0.45, 60, 0.55]); streets.push([-20, 10, 0.45, 50, -0.8]);
    for (const [cx, cz, w, d, rot] of streets) {
      const st = new THREE.Mesh(new THREE.PlaneGeometry(w, d), streetM);
      st.rotation.set(-Math.PI / 2, 0, rot); st.position.set(cx, 0.01, cz); town.add(st);
    }
    const N = 1500;
    const wallG = new THREE.BoxGeometry(1, 0.55, 1); wallG.translate(0, 0.275, 0);
    const roofG = (() => { // gable prism, ridge along x
      const v = [-0.55, 0.55, -0.58, 0.55, 0.55, -0.58, 0.55, 0.95, 0, -0.55, 0.95, 0, -0.55, 0.55, 0.58, 0.55, 0.55, 0.58];
      const i = [0, 2, 1, 0, 3, 2, 4, 3, 5, 3, 2, 5, 5, 2, 1, 5, 1, 4, 0, 4, 3, 0, 1, 4];
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3)); g.setIndex(i);
      g.computeVertexNormals(); return g;
    })();
    const walls = new THREE.InstancedMesh(wallG, lam(0xb4ada0), N);
    const roofs = new THREE.InstancedMesh(roofG, lam(0xffffff), N);
    const roofPal = [0xb85438, 0xa04430, 0xc46840, 0x8a3c2c, 0x9a5038, 0x6e6660] // 1.6.1: hotter reds so roof mass reads from altitude;
    let n = 0;
    const scl = new THREE.Vector3(), rq = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    const place = (x0, z0, rot, len, wid) => {
      if (n >= N) return;
      if (Math.hypot(x0 + 14, z0 - 0.5) < 5.2) return; // the cathedral close
      if (x0 > -3.2 && x0 < 12.5 && z0 > -16 && z0 < 10.5) return; // the target complex (yard, depot, factory)
      pv.set(x0, 0, z0); scl.set(len, 1.0 + rnd() * 0.9, wid); rq.setFromAxisAngle(up, rot); // 1.6.1 taller mass
      m4.compose(pv, rq, scl); walls.setMatrixAt(n, m4); roofs.setMatrixAt(n, m4); TL.houses.push([x0, z0, len / 2, wid / 2, rot]); TS.houseM.push(m4.clone());
      const rc = new THREE.Color(roofPal[(rnd() * roofPal.length) | 0]).multiplyScalar(0.95 + rnd() * 0.25);
      roofs.setColorAt(n, rc); walls.setColorAt(n, new THREE.Color(1, 1, 1).multiplyScalar(0.85 + rnd() * 0.2));
      n++;
    };
    // old town: dense blocks between the streets, west of the yard
    for (let bx = -4; bx < 3; bx++) for (let bz = -4; bz < 4; bz++) {
      const cx = bx * 7.5 - 12 + 3.75, cz = bz * 6.5 + 3.25;
      const dcen = Math.hypot(cx + 14, cz);
      if (dcen > 24 && rnd() < 0.45) continue;
      for (let k = 0; k < 14; k++) {
        const side = k % 4, t = rnd() * 5.4 - 2.7;
        const ox = side === 0 ? t : side === 1 ? t : side === 2 ? -2.9 : 2.9;
        const oz = side === 0 ? -2.3 : side === 1 ? 2.3 : t * 0.8;
        place(cx + ox, cz + oz, side < 2 ? 0 : Math.PI / 2, 1.5 + rnd() * 1.4, 1.15 + rnd() * 0.55); // 1.6.1 larger roofs
      }
    }
    // villas / outskirts scattered along the roads
    while (n < N) {
      const a = rnd() * Math.PI * 2, r = 16 + rnd() * 44;
      place(Math.cos(a) * r - 12, Math.sin(a) * r, rnd() * Math.PI, 1.0 + rnd() * 0.7, 0.85 + rnd() * 0.4);
    }
    walls.instanceMatrix.needsUpdate = true; roofs.instanceMatrix.needsUpdate = true;
    walls.renderOrder = 1; // 1.6.0 perf: roofs draw first, so the (hidden) wall tops under them fail the depth test instead of being shaded then overdrawn
    town.add(walls); town.add(roofs); TS.walls = walls; TS.roofs = roofs;
    { // 1.6.0/1.6.1 CATHEDRAL: landmark scaled up so the spire reads from altitude
      const slate = lam(0x4a5560), cx0 = -14, cz0 = 0.5;
      const add = (geo, mat, x, y, z, ry) => { const m = new THREE.Mesh(geo, mat); m.position.set(cx0 + x, y, cz0 + z); if (ry) m.rotation.y = ry; town.add(m); return m; };
      add(new THREE.BoxGeometry(1.8, 1.6, 6.2), stone, 0, 0.8, 0); add(new THREE.BoxGeometry(4.8, 1.35, 1.8), stone, 0, 0.68, 0.45); // nave + transept
      add(new THREE.BoxGeometry(1.55, 0.42, 6.0), slate, 0, 1.75, 0); add(new THREE.BoxGeometry(4.6, 0.36, 1.55), slate, 0, 1.45, 0.45);   // roofs
      add(new THREE.BoxGeometry(1.15, 3.4, 1.15), stone, 0, 1.7, 0.45); add(new THREE.ConeGeometry(0.95, 5.2, 4), slate, 0, 5.9, 0.45, Math.PI / 4); // crossing tower + spire (taller)
      for (const sx of [-0.7, 0.7]) { add(new THREE.BoxGeometry(0.85, 3.1, 0.85), stone, sx, 1.55, -3.2); add(new THREE.ConeGeometry(0.65, 1.8, 4), slate, sx, 3.9, -3.2, Math.PI / 4); } // west towers
    }
    { // 1.6.0 TRAIN DEPOT (target): a long arched train shed over the yard's throat with the station hall in front of it — in yard-aligned coordinates, at the north end of the tracks
      const shedM = lam(0x6a6862), hallM = lam(0xa8a296), roofM = lam(0x35383a);
      const shed = box(5.8, 1.0, 11, 6.2, -24, shedM); keyB("train depot shed", 5.8, 11, 6.2, -24, shed, "d");
      { const [px, pz] = ax(6.2, -24); const arch = new THREE.Mesh(new THREE.CylinderGeometry(2.9, 2.9, 11, 14, 1, false, 0, Math.PI), roofM); arch.rotation.set(0, YARD_A + Math.PI / 2, Math.PI / 2); arch.position.set(px, 1.0, pz); arch.rotation.order = "YZX"; CXG.add(arch); }
      const hall = box(7.2, 1.4, 2.6, 6.2, -35.1, hallM); keyB("train depot hall", 7.2, 2.6, 6.2, -35.1, hall, "d");
      { const [px, pz] = ax(8.6, -35.1); const clock = new THREE.Mesh(new THREE.BoxGeometry(0.7, 2.3, 0.7), hallM); clock.position.set(px, 1.15, pz); clock.rotation.y = YARD_A; CXG.add(clock); const cap = new THREE.Mesh(new THREE.ConeGeometry(0.55, 0.9, 4), roofM); cap.position.set(px, 2.75, pz); cap.rotation.y = YARD_A + Math.PI / 4; CXG.add(cap); }
            const [ex, ez] = ax(6.2, -35.1); TS.depotC = [ex * KC, ez * KC];
    }
    { // 1.6.0 FACTORY (target): a works district east of the yard — three long sawtooth halls, a power house, two tall brick chimneys and storage tanks
      const FX = 10, hallM = lam(0x7e7468), saw = lam(0x58504a), chim = lam(0x8a4a38), tankM = lam(0xb9b4a6);
      const keyD = (name, w, d, x, z, m, kind) => { TL.keys.push([x, z, w / 2, d / 2, 0, name, kind || "f"]); TS.keyMesh.push(m); return m; };
      const put = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); CXG.add(m); return m; };
      for (let i = 0; i < 3; i++) {
        const z = -8 + i * 4.6, m = put(new THREE.BoxGeometry(11, 1.05, 3.8), hallM, FX, 0.525, z); keyD("factory hall " + "ABC"[i], 11, 3.8, FX, z, m);
        for (let k = 0; k < 5; k++) put(new THREE.BoxGeometry(1.7, 0.3, 3.6), saw, FX - 4.4 + k * 2.2, 1.2, z); // sawtooth roof lights
      }
      keyD("power house", 3.4, 3.4, 19.5, -6, put(new THREE.BoxGeometry(3.4, 1.5, 3.4), hallM, 19.5, 0.75, -6));
      keyD("chimney", 0.7, 0.7, 18, 1, put(new THREE.CylinderGeometry(0.22, 0.34, 5.2, 8), chim, 18, 2.6, 1));
      keyD("chimney", 0.7, 0.7, 20, 5, put(new THREE.CylinderGeometry(0.2, 0.3, 4.4, 8), chim, 20, 2.2, 5));
      for (let k = 0; k < 3; k++) put(new THREE.CylinderGeometry(0.9, 0.9, 0.9, 12), tankM, 17 + k * 2.2, 0.45, 12);
      const sidingM = bas(0x3e3a34), sid = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 40), sidingM); sid.rotation.set(-Math.PI / 2, 0, 0); sid.position.set(4.6, 0.02, 0); CXG.add(sid); // siding along the works
      const road = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 40), streetM); road.rotation.set(-Math.PI / 2, 0, 0); road.position.set(23, 0.012, 3); CXG.add(road);
    }

    { // 1.6.1 ALTITUDE LANDMARKS: a few very large masses (not targets) so the town reads as a city from 25,000 ft
      const big = lam(0xb8a090), bigR = lam(0xa04028), dark = lam(0x4a4540);
      const put = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); town.add(m); return m; };
      for (let i = 0; i < 3; i++) { put(new THREE.BoxGeometry(4.5, 2.2, 3.2), big, -22 - i * 5.5, 1.1, -6 + i * 2); put(new THREE.BoxGeometry(4.6, 0.5, 3.3), bigR, -22 - i * 5.5, 2.35, -6 + i * 2); }
      put(new THREE.BoxGeometry(14, 2.8, 4.0), dark, -6, 1.4, 22); put(new THREE.BoxGeometry(14.2, 0.55, 4.2), bigR, -6, 2.95, 22);
      for (let i = 0; i < 5; i++) { put(new THREE.BoxGeometry(2.2, 3.4, 2.0), big, 8 + i * 2.6, 1.7, 14); put(new THREE.BoxGeometry(2.3, 0.4, 2.1), bigR, 8 + i * 2.6, 3.5, 14); }
    }
    for (const A of [TL.wagons, TL.tracks, TL.stalls, TL.keys]) for (const e of A) { e[0] *= KC; e[1] *= KC; e[2] *= KC; e[3] *= KC; } // 1.6.0: complex coordinates → town-local
  }

  // ===== 1.6.1 TOWN FROM ALTITUDE: a dark built-up footprint + street grid so the town reads from 25,000 ft
  // as a real city mass (roofs alone were ~2 px at 20 km and vanished into farmland). No sky sprites — ground only.
  {
    const N = 512, c = document.createElement("canvas"); c.width = c.height = N; const x = c.getContext("2d");
    x.fillStyle = "#0000"; x.clearRect(0, 0, N, N);
    // irregular urban blotch (darker paved / built-up)
    x.fillStyle = "rgba(42, 38, 34, 1)";
    x.beginPath();
    let sd = 77; const R = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
    const cx = N * 0.48, cy = N * 0.52, rad = N * 0.46;
    x.moveTo(cx + rad, cy);
    for (let i = 1; i <= 24; i++) {
      const a = i / 24 * Math.PI * 2, rr = rad * (0.72 + R() * 0.4);
      x.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
    x.closePath(); x.fill();
    // denser core
    x.fillStyle = "rgba(32, 28, 26, 1)";
    x.beginPath(); x.arc(cx - N * 0.04, cy, rad * 0.45, 0, Math.PI * 2); x.fill();
    // street grid (light)
    x.strokeStyle = "rgba(180, 170, 160, 0.5)"; x.lineWidth = 2.5;
    for (let i = -6; i <= 6; i++) {
      const o = i * (N * 0.055);
      x.beginPath(); x.moveTo(cx - rad * 0.85, cy + o); x.lineTo(cx + rad * 0.85, cy + o); x.stroke();
      x.beginPath(); x.moveTo(cx + o, cy - rad * 0.85); x.lineTo(cx + o, cy + rad * 0.85); x.stroke();
    }
    // diagonal boulevards
    x.strokeStyle = "rgba(200, 195, 185, 0.4)"; x.lineWidth = 3;
    x.beginPath(); x.moveTo(cx - rad * 0.7, cy - rad * 0.5); x.lineTo(cx + rad * 0.75, cy + rad * 0.55); x.stroke();
    x.beginPath(); x.moveTo(cx - rad * 0.6, cy + rad * 0.65); x.lineTo(cx + rad * 0.55, cy - rad * 0.4); x.stroke();
    // rail yard dark strip (reads from altitude)
    x.fillStyle = "rgba(35, 33, 30, 0.75)";
    x.save(); x.translate(cx + N * 0.08, cy - N * 0.08); x.rotate(-0.35);
    x.fillRect(-N * 0.06, -N * 0.22, N * 0.12, N * 0.44); x.restore();
    // river glint through town
    x.strokeStyle = "rgba(90, 130, 150, 0.55)"; x.lineWidth = 5;
    x.beginPath(); x.moveTo(cx - rad * 0.9, cy + rad * 0.2);
    x.quadraticCurveTo(cx, cy + rad * 0.35, cx + rad * 0.85, cy - rad * 0.1); x.stroke();
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    const fpMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }); // 1.6.1: no earth-fog washout at 20 km
    townMats.push(fpMat);
    // town-local: cover the built-up area (~±50 units outskirts). World size ≈ 50*TOWN_S*K_LAND ≈ 2 km radius blotch.
    const under = new THREE.Mesh(new THREE.CircleGeometry(72, 32), new THREE.MeshBasicMaterial({ color: 0x3a3530, fog: false, depthWrite: false, transparent: true, opacity: 0.85, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }));
    under.rotation.x = -Math.PI / 2; under.position.set(-8, 0.06, 2); under.renderOrder = 2; under.frustumCulled = false; town.add(under); townMats.push(under.material);
    const fp = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), fpMat);
    fp.rotation.x = -Math.PI / 2; fp.position.set(-8, 0.12, 2); fp.renderOrder = 3; fp.frustumCulled = false;
    town.add(fp);
    // industrial / depot darker pad (extra contrast near targets)
    const padMat = new THREE.MeshBasicMaterial({ color: 0x2a2824, transparent: true, opacity: 0.75, fog: false, depthWrite: false });
    townMats.push(padMat);
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(28, 36), padMat);
    pad.rotation.x = -Math.PI / 2; pad.position.set(2, 0.025, -8); pad.frustumCulled = false; town.add(pad);
  }
  // 1.6.1: keep town meshes drawing at long range (instanced houses had default frustum spheres that culled early)
  if (TS.walls) { TS.walls.frustumCulled = false; TS.roofs.frustumCulled = false; }
  town.traverse((o) => { if (o.isMesh || o.isInstancedMesh) o.frustumCulled = false; });

  town.traverse((o) => { if (o.material && !o.material._earthFog) { o.material._earthFog = true; o.material.onBeforeCompile = earthFog; } });
  town.traverse((o) => { if (o.isMesh || o.isInstancedMesh) { o.renderOrder = Math.max(o.renderOrder || 0, 2); if (o.material && !o.material.polygonOffset) { o.material.polygonOffset = true; o.material.polygonOffsetFactor = -8; o.material.polygonOffsetUnits = -8; } } });

  // bomb bursts + smoke columns on the target (children of the ground frame → move with the ground)
  const impactFlash = [], impactSmoke = [];
  const flashMat0 = new THREE.SpriteMaterial({ map: fireTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  for (let i = 0; i < 40; i++) { const sp = new THREE.Sprite(flashMat0.clone()); sp.visible = false; landG.add(sp); impactFlash.push({ sp, life: 0 }); }
  for (let i = 0; i < 170; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, color: 0x3a3632, transparent: true, depthWrite: false, fog: true }));
    sp.visible = false; landG.add(sp); impactSmoke.push({ sp, life: 0, max: 1, vy: 0, s0: 1, s1: 4, a: 0.6 });
  }
  let _ifI = 0, _isI = 0;
  function bombBurst(lx, lz, big) { // ground-frame local coords (landG). 1.6.1: much bigger so a stick reads from a straggler several km back
    const mul = big ? 3.6 : 2.0;
    const f = impactFlash[_ifI]; _ifI = (_ifI + 1) % impactFlash.length;
    f.sp.position.set(lx, 0.8, lz); f.life = f.max = 1.6; f.big = mul; f.sp.visible = true;
    // second flash slightly offset for volume
    { const f2 = impactFlash[_ifI]; _ifI = (_ifI + 1) % impactFlash.length;
      f2.sp.position.set(lx + (Math.random() - 0.5) * 0.8, 1.2, lz + (Math.random() - 0.5) * 0.8); f2.life = f2.max = 1.1; f2.big = mul * 0.7; f2.sp.visible = true; }
    for (let k = 0; k < 5; k++) {
      const p = impactSmoke[_isI]; _isI = (_isI + 1) % impactSmoke.length;
      p.sp.position.set(lx + (Math.random() - 0.5) * 2.0, 0.5 + k * 0.7, lz + (Math.random() - 0.5) * 2.0);
      p.life = p.max = 55 + Math.random() * 35; p.vy = 0.7 + Math.random() * 0.7 + k * 0.2;
      p.s0 = (2.2 + k * 0.55) * (big ? 1.3 : 1); p.s1 = (14 + Math.random() * 12) * (big ? 1.4 : 1); p.a = k === 0 ? 0.9 : 0.65;
      p.sp.material.color.setHex(k === 0 ? 0x6a5e50 : 0x2a2724);
      p.sp.visible = true;
    }
  }
  function updateImpacts(dt) {
    for (const f of impactFlash) {
      if (f.life <= 0) continue;
      f.life -= dt;
      if (f.life <= 0) { f.sp.visible = false; continue; }
      const k = 1 - f.life / f.max, s = (2.2 + k * 3.5) * f.big;
      f.sp.scale.set(s, s, 1); f.sp.material.opacity = (1 - k);
    }
    for (const p of impactSmoke) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.sp.visible = false; continue; }
      const k = 1 - p.life / p.max;
      p.sp.position.y += p.vy * dt * (1 - k * 0.6);
      p.sp.position.x += 0.03 * dt; // drifting downwind
      const s = p.s0 + (p.s1 - p.s0) * Math.sqrt(k);
      p.sp.scale.set(s, s, 1);
      p.sp.material.opacity = p.a * Math.min(1, k * 30) * (1 - k * k);
    }
  }
  // the bombing: earlier groups of the bomber stream are already hitting the target as we come in;
  // our box's pattern lands ~25 s after "bombs away" across the yard.
  // 1.5.3: no more invented bursts — every burst/crater/wreck on the target is a real bomb from dropBombs() resolved by game.js (townStrike)
  function townBombing(opts, dt) {
    if ((opts.missionT || 0) < 1 && TS.nCr) townReset();
    updateImpacts(dt); updateCrashFx(dt);
  }
  const rubbleMat = new THREE.MeshLambertMaterial({ color: 0x2c2824, fog: true }); rubbleMat.onBeforeCompile = earthFog; rubbleMat._earthFog = true;
  const craterGeo = new THREE.CircleGeometry(0.34, 14); craterGeo.rotateX(-Math.PI / 2);
  const craterMat = new THREE.MeshBasicMaterial({ color: 0x2b2620, fog: true, transparent: true, opacity: 0.82, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  craterMat.onBeforeCompile = earthFog; craterMat._earthFog = true;
  TS.craters = new THREE.InstancedMesh(craterGeo, craterMat, 320); TS.craters.count = 0; TS.craters.frustumCulled = false; town.add(TS.craters);
  // ===== 1.5.8 CRASH SITES: where a hull / tail / wing hits the ground: fireball + flicker flames, a smoke column that climbs for ~30 s, a persistent scorch + debris-field decals (instanced, ground-fixed so they stream aft
  // with the farmland), and a distance-delayed boom. All of it lives in landG (local units = world / 7); a B-17 hull is a ~300 m fireball seen from 7.6 km, a tail ~40 %, a wing ~60 %. =====
  const CR = { fire: [], smoke: [], sites: [], nSc: 0, SC_N: 520, sm: 0, fi: 0, stats: { n: 0, hull: 0, tail: 0, wing: 0, puffs: 0 } };
  // 1.6.1: larger pools — parachute view is uncapped ("go big"); turret still only sees distant sites
  for (let i = 0; i < 140; i++) { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: fireTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })); sp.visible = false; landG.add(sp); CR.fire.push({ sp, life: 0, max: 1, s: 1, fl: 0 }); }
  for (let i = 0; i < 480; i++) { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, color: 0x2a2724, transparent: true, depthWrite: false, fog: true })); sp.visible = false; landG.add(sp); CR.smoke.push({ sp, life: 0, max: 1, vy: 0, s0: 1, s1: 4, a: 0.6, vx: 0 }); }
  CR.chuteRich = false; // set true while the player is in parachute view
  CR.tailDim = false; // 1.6.1: looking aft along own trails — dim so they do not wash out the Cheyenne view
  // 1.6.1: soft radial scorch (no hard CircleGeometry discs — those read as flat grey/white plates from the chute)
  const scTex = (() => {
    const N = 128, c = document.createElement("canvas"); c.width = c.height = N; const x = c.getContext("2d");
    const g = x.createRadialGradient(N/2, N/2, 2, N/2, N/2, N/2 - 1);
    g.addColorStop(0, "rgba(18,16,14,1)"); g.addColorStop(0.35, "rgba(28,24,20,0.92)");
    g.addColorStop(0.65, "rgba(40,34,28,0.55)"); g.addColorStop(1, "rgba(40,34,28,0)");
    x.fillStyle = g; x.fillRect(0, 0, N, N);
    // irregular soot flecks
    let sd = 19; const R = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
    for (let i = 0; i < 40; i++) {
      const a = R() * 6.28, rr = R() * 48, px = N/2 + Math.cos(a) * rr, py = N/2 + Math.sin(a) * rr;
      const gg = x.createRadialGradient(px, py, 0, px, py, 4 + R() * 8);
      gg.addColorStop(0, "rgba(10,9,8,0.7)"); gg.addColorStop(1, "rgba(10,9,8,0)");
      x.fillStyle = gg; x.fillRect(px - 12, py - 12, 24, 24);
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const scGeo = new THREE.PlaneGeometry(2, 2); scGeo.rotateX(-Math.PI / 2);
  const scMat = new THREE.MeshBasicMaterial({ map: scTex, color: 0xffffff, fog: true, transparent: true, opacity: 0.95, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  scMat.onBeforeCompile = earthFog; scMat._earthFog = true;
  CR.scorch = new THREE.InstancedMesh(scGeo, scMat, CR.SC_N); CR.scorch.count = 0; CR.scorch.frustumCulled = false; CR.scorch.renderOrder = 1; landG.add(CR.scorch);
  CR.scorch.setColorAt(0, new THREE.Color(1, 1, 1));
  const _cq = new THREE.Vector3(), _cm = new THREE.Matrix4(), _cqq = new THREE.Quaternion(), _cs = new THREE.Vector3(), _cc = new THREE.Color(), _cy = new THREE.Vector3(0, 1, 0);
  function crashDecal(lx, lz, rx, rz, yaw, r, g, b) { // world radii (u) → landG units
    const i = CR.nSc % CR.SC_N; CR.nSc++;
    _cqq.setFromAxisAngle(_cy, yaw); _cm.compose(_cq.set(lx, 0.075 + (i % 7) * 0.004, lz), _cqq, _cs.set(rx / K_LAND, 1, rz / K_LAND)); CR.scorch.setMatrixAt(i, _cm);
    CR.scorch.setColorAt(i, _cc.setRGB(r, g, b)); CR.scorch.count = Math.min(CR.nSc, CR.SC_N);
    CR.scorch.instanceMatrix.needsUpdate = true; if (CR.scorch.instanceColor) CR.scorch.instanceColor.needsUpdate = true;
  }
  function crashImpact(P, size, kind) {
    landG.updateWorldMatrix(true, false);
    const L = landG.worldToLocal(_cq.copy(P)), lx = L.x, lz = L.z, K = K_LAND;
    CR.stats.n++; CR.stats[kind] = (CR.stats[kind] || 0) + 1;
    const rich = CR.chuteRich ? 2.2 : 1; // 1.6.1: parachute view goes big
    const fire = (dx, dz, wr, life, delay, col) => {
      const f = CR.fire[CR.fi]; CR.fi = (CR.fi + 1) % CR.fire.length;
      f.sp.position.set(lx + dx / K, Math.max(0.4, 0.55 * wr / K), lz + dz / K);
      f.s = wr * 2.4 / K * (0.85 + Math.random() * 0.3); f.max = life; f.life = life + delay; f.delay = delay; f.fl = Math.random() * 6;
      f.sp.material.color.setHex(col || 0xffcc66); f.sp.visible = false;
    };
    // layered fireball: white core → yellow → orange (additive soft sprites, not hard discs)
    fire(0, 0, 220 * size * rich, 1.4 + 0.6 * size, 0, 0xfff2c8);
    fire(0, 0, 180 * size * rich, 3.2 + 1.5 * size, 0.05, 0xffb040);
    fire(0, 0, 140 * size * rich, 5.5 + 2 * size, 0.12, 0xff6a20);
    const nSec = Math.round((CR.chuteRich ? 10 : 5) * (kind === "hull" ? 1 : 0.7));
    for (let k = 0; k < nSec; k++) fire((Math.random() - 0.5) * 160 * size, (Math.random() - 0.5) * 160 * size, (40 + Math.random() * 70) * size * rich, 8 + Math.random() * 10, 0.15 + k * 0.18, Math.random() < 0.4 ? 0xff9030 : 0xff5010);
    CR.sites.push({ lx, lz, t: 0, size: size * rich, acc: 0, dur: (CR.chuteRich ? 48 : 22) + 14 * size, kind, rich });
    // soft scorch (textured) + debris field
    const yaw = Math.random() * 6.28;
    crashDecal(lx, lz, 80 * size, 80 * size, yaw, 1, 1, 1);
    crashDecal(lx, lz, 130 * size, 95 * size, yaw + 0.4, 0.85, 0.82, 0.78);
    crashDecal(lx + 80 * size * Math.cos(yaw) / K, lz + 80 * size * Math.sin(yaw) / K, 150 * size, 28 * size, -yaw, 0.7, 0.65, 0.6);
    const nd = (kind === "hull" ? 14 : 7) * (CR.chuteRich ? 2 : 1);
    for (let k = 0; k < nd; k++) {
      const a = Math.random() * 6.28, d = (50 + Math.random() * 200) * size;
      crashDecal(lx + Math.cos(a) * d / K, lz + Math.sin(a) * d / K, (8 + Math.random() * 18) * size, (8 + Math.random() * 18) * size, Math.random() * 3, 0.9, 0.88, 0.85);
    }
    // initial smoke bloom — many overlapping soft puffs at staggered heights (reads 3D from nadir)
    for (let k = 0; k < (CR.chuteRich ? 36 : 14); k++) {
      const p = CR.smoke[CR.sm]; CR.sm = (CR.sm + 1) % CR.smoke.length; CR.stats.puffs++;
      const ang = Math.random() * 6.28, rad = Math.random() * 55 * size;
      const h0 = (0.4 + Math.random() * 8 + (k % 6) * 1.8) * rich;
      p.sp.position.set(lx + Math.cos(ang) * rad / K, h0 / K, lz + Math.sin(ang) * rad / K);
      p.life = p.max = 20 + Math.random() * 18; p.vy = (55 + Math.random() * 50) / K; p.vx = (6 + Math.random() * 16) / K;
      p.s0 = (28 + Math.random() * 30) * size / K; p.s1 = (200 + Math.random() * 220) * size * rich / K; p.a = 0.55 + Math.random() * 0.35;
      p.sp.material.rotation = Math.random() * 6.28;
      p.sp.material.color.setHex(Math.random() < 0.35 ? 0x5a5248 : 0x1a1816); p.sp.visible = true;
    }
    // vertical column seed: stack of smaller puffs up the axis
    for (let k = 0; k < (CR.chuteRich ? 22 : 8); k++) {
      const p = CR.smoke[CR.sm]; CR.sm = (CR.sm + 1) % CR.smoke.length; CR.stats.puffs++;
      const h0 = (2 + k * (CR.chuteRich ? 3.2 : 2.4)) * rich;
      p.sp.position.set(lx + (Math.random() - 0.5) * 18 * size / K, h0 / K, lz + (Math.random() - 0.5) * 18 * size / K);
      p.life = p.max = 24 + Math.random() * 20; p.vy = (70 + Math.random() * 40) / K; p.vx = (4 + Math.random() * 8) / K;
      p.s0 = (18 + Math.random() * 16) * size / K; p.s1 = (140 + Math.random() * 120) * size * rich / K; p.a = 0.5 + Math.random() * 0.3;
      p.sp.material.rotation = Math.random() * 6.28;
      p.sp.material.color.setHex(0x22201c); p.sp.visible = true;
    }
    if (window.FGAudio && window.FGAudio.crash) window.FGAudio.crash(P.x, P.y, P.z, size);
  }
  function updateCrashFx(dt) {
    for (const f of CR.fire) {
      if (f.life <= 0) continue;
      f.life -= dt;
      if (f.life <= 0) { f.sp.visible = false; continue; }
      if (f.life > f.max) { f.sp.visible = false; continue; }
      f.sp.visible = true;
      const k = 1 - f.life / f.max, grow = Math.min(1, k * 8) * 0.7 + 0.3, fl = 0.8 + 0.35 * Math.sin(f.fl + pnow() * 0.025);
      // vertical stretch so the fireball reads as a rising flash, not a flat disc from above
      const s = f.s * grow * (k < 0.15 ? 1 : 1 - (k - 0.15) * 0.5) * fl;
      f.sp.scale.set(s * (1 - 0.15 * k), s * (1.15 + 0.9 * k), 1);
      f.sp.material.opacity = Math.min(1, 1.5 * Math.pow(1 - k, 1.25));
      f.sp.position.y += 0.8 * dt * (1 - k); // climb a little
    }
    for (let q = CR.sites.length - 1; q >= 0; q--) {
      const c = CR.sites[q]; c.t += dt;
      if (c.t > c.dur) { CR.sites.splice(q, 1); continue; }
      const rate = (c.kind === "hull" ? 4.5 : 2.6) * (c.rich ? 1.6 : 1) * (c.t < 4 ? 1.4 : 1);
      c.acc += dt * rate;
      while (c.acc >= 1) {
        c.acc -= 1; const p = CR.smoke[CR.sm]; CR.sm = (CR.sm + 1) % CR.smoke.length; CR.stats.puffs++;
        const sz = c.size;
        // prefer a rising column of varied soft puffs (not one flat disc)
        const col = Math.random() < 0.55;
        const h0 = col ? (1.5 + Math.random() * 14) * (c.rich || 1) : (0.4 + Math.random() * 1.5);
        p.sp.position.set(c.lx + (Math.random() - 0.5) * (col ? 28 : 55) * sz / K_LAND, h0 / K_LAND, c.lz + (Math.random() - 0.5) * (col ? 28 : 55) * sz / K_LAND);
        p.life = p.max = 28 + Math.random() * 24; p.vy = (50 + Math.random() * 45) / K_LAND; p.vx = (8 + Math.random() * 14) / K_LAND;
        p.s0 = (22 + Math.random() * 30) * sz / K_LAND; p.s1 = (180 + Math.random() * 200) * sz / K_LAND; p.a = 0.5 + Math.random() * 0.35;
        p.sp.material.rotation = Math.random() * 6.28;
        p.sp.material.color.setHex(Math.random() < 0.25 ? 0x5a5048 : 0x1c1a18); p.sp.visible = true;
      }
      // secondary pops early on
      if (c.rich && c.t < 6 && Math.random() < 0.04) {
        const f = CR.fire[CR.fi]; CR.fi = (CR.fi + 1) % CR.fire.length;
        f.sp.position.set(c.lx + (Math.random() - 0.5) * 30 * c.size / K_LAND, 1.5, c.lz + (Math.random() - 0.5) * 30 * c.size / K_LAND);
        f.s = 40 * c.size / K_LAND; f.max = 2.2; f.life = 2.2; f.fl = Math.random() * 6; f.sp.material.color.setHex(0xffa030); f.sp.visible = true;
      }
    }
    for (const p of CR.smoke) {
      if (p.life <= 0) continue;
      p.life -= dt; if (p.life <= 0) { p.sp.visible = false; continue; }
      const k = 1 - p.life / p.max;
      p.sp.position.y += p.vy * dt * (1 - k * 0.5); p.sp.position.x += p.vx * dt; p.sp.position.z += p.vx * 0.35 * dt;
      const sc = p.s0 + (p.s1 - p.s0) * Math.sqrt(k);
      // 1.6.1: tall soft columns + slow spin so overlapping puffs do not read as one disc from nadir
      const tall = 1.55 + 2.1 * k;
      p.sp.scale.set(sc * (0.7 + 0.25 * Math.sin(p.life * 1.7)), sc * tall, 1);
      if (p.sp.material) p.sp.material.rotation += dt * (0.15 + (p.vx || 0) * 0.02);
      p.sp.material.opacity = p.a * Math.min(1, k * 10) * (1 - k * k) * 0.88;
    }
  }
  function crashReset() {
    CR.nSc = 0; CR.scorch.count = 0; CR.sites.length = 0;
    for (const f of CR.fire) { f.life = 0; f.sp.visible = false; } for (const p of CR.smoke) { p.life = 0; p.sp.visible = false; }
    CR.stats.n = CR.stats.hull = CR.stats.tail = CR.stats.wing = CR.stats.puffs = 0;
  }
  const _zm = new THREE.Matrix4().makeScale(0, 0, 0), _dc = new THREE.Color(0.2, 0.17, 0.15), _wc = new THREE.Color(1, 1, 1);
  const _tmpM = new THREE.Matrix4(), _tp = new THREE.Vector3(), _tq = new THREE.Quaternion(), _ts = new THREE.Vector3();
  function townReset() {
    TS.nCr = 0; TS.craters.count = 0; TS.hit.clear();
    TS.houseM.forEach((m, i) => { TS.walls.setMatrixAt(i, m); TS.roofs.setMatrixAt(i, m); });
    TS.walls.instanceMatrix.needsUpdate = true; TS.roofs.instanceMatrix.needsUpdate = true;
    TS.wagonM.forEach((m, i) => TS.wagons.setMatrixAt(i, m)); TS.wagons.instanceMatrix.needsUpdate = true;
    TS.keyMesh.forEach((m) => { m.scale.set(1, 1, 1); m.position.y = m.geometry.parameters.height / 2; if (m._mat0) m.material = m._mat0; m.rotation.z = 0; });
    TS.stallMesh.forEach((m) => { m.scale.set(1, 1, 1); m.position.y = 0.22; if (m._mat0) m.material = m._mat0; });
    for (const p of impactSmoke) { p.life = 0; p.sp.visible = false; }
  }
  // ev: { u, v (town-local), houses:[ids], wagons:[ids], stalls:[ids], keys:[[id, hits]] }
  function townStrike(ev) {
    bombBurst(TOWN_X + TOWN_S * ev.u, TOWN_Z + TOWN_S * ev.v, true);
    if (TS.nCr < 320) {
      _tp.set(ev.u, 0.07, ev.v); _tq.identity(); const sc = 0.8 + Math.random() * 0.5; _ts.set(sc, 1, sc);
      TS.craters.setMatrixAt(TS.nCr++, _tmpM.compose(_tp, _tq, _ts)); TS.craters.count = TS.nCr; TS.craters.instanceMatrix.needsUpdate = true;
    }
    for (const i of ev.houses || []) {
      _tmpM.copy(TS.houseM[i]); _tmpM.decompose(_tp, _tq, _ts); _ts.y *= 0.14; TS.walls.setMatrixAt(i, _tmpM.compose(_tp, _tq, _ts)); TS.roofs.setMatrixAt(i, _zm);
      TS.walls.setColorAt(i, _dc);
    }
    if ((ev.houses || []).length) { TS.walls.instanceMatrix.needsUpdate = true; TS.roofs.instanceMatrix.needsUpdate = true; if (TS.walls.instanceColor) TS.walls.instanceColor.needsUpdate = true; }
    for (const i of ev.wagons || []) { _tmpM.copy(TS.wagonM[i]); _tmpM.decompose(_tp, _tq, _ts); _ts.set(1.1, 0.2, 0.9); TS.wagons.setMatrixAt(i, _tmpM.compose(_tp, _tq, _ts)); TS.wagons.setColorAt(i, _dc); }
    if ((ev.wagons || []).length) { TS.wagons.instanceMatrix.needsUpdate = true; if (TS.wagons.instanceColor) TS.wagons.instanceColor.needsUpdate = true; }
    for (const i of ev.stalls || []) { const m = TS.stallMesh[i]; if (!m._mat0) m._mat0 = m.material; m.material = rubbleMat; m.scale.y = 0.3; m.position.y = 0.07; }
    for (const [i, h] of ev.keys || []) {
      const m = TS.keyMesh[i], H = m.geometry.parameters.height; if (!m._mat0) m._mat0 = m.material;
      if (h >= 2) { m.material = rubbleMat; m.scale.y = 0.25; m.position.y = H * 0.125; } else { m.scale.y = 0.75; m.position.y = H * 0.375; m.rotation.z = 0.06; }
    }
  }

  // 1.3.2: volumetric-looking cumulus = clusters of 5–9 lit puff billboards of several sizes.
  // Each puff texture has a sunlit top and a grey-blue shaded base; puffs lower in a cluster are
  // tinted darker, so a cluster reads as a lumpy volume rather than one flat cutout.
  const cloudClusters = [];
  const puffTexs = [0, 1, 2, 3].map((k) => {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const x = c.getContext("2d");
    let seed = 91 + k * 57;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    // body: several overlapping soft lobes
    for (let i = 0; i < 9; i++) {
      const px = 34 + rnd() * 60, py = 46 + rnd() * 34;
      const r = Math.min(20 + rnd() * 22, px - 2, 126 - px, py - 2, 126 - py);
      const g = x.createRadialGradient(px, py - r * 0.25, r * 0.1, px, py, r);
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(0.62, "rgba(250,251,255,0.95)");
      g.addColorStop(0.9, "rgba(240,244,252,0.55)");
      g.addColorStop(1, "rgba(236,240,246,0)");
      x.fillStyle = g;
      x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill();
    }
    // shade the underside (source-atop keeps alpha)
    x.globalCompositeOperation = "source-atop";
    const ug = x.createLinearGradient(0, 40, 0, 118);
    ug.addColorStop(0, "rgba(255,252,244,0.25)");
    ug.addColorStop(0.45, "rgba(200,208,220,0.0)");
    ug.addColorStop(1, "rgba(92,108,138,0.8)");
    x.fillStyle = ug;
    x.fillRect(0, 0, 128, 128);
    const tx = new THREE.CanvasTexture(c);
    tx.colorSpace = THREE.SRGBColorSpace;
    return tx;
  });
  function buildCluster() {
    const g = new THREE.Group();
    const n = 5 + ((Math.random() * 5) | 0);
    for (let i = 0; i < n; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: puffTexs[(Math.random() * 4) | 0], transparent: true, depthWrite: false, opacity: 0.92, fog: true,
      }));
      g.add(sp);
    }
    scene.add(g);
    return g;
  }
  function shapeCluster(g, size) {
    const n = g.children.length;
    for (let i = 0; i < n; i++) {
      const sp = g.children[i];
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.6;
      const rr = Math.random() * 0.45 * size;
      const hy = (Math.random() - 0.35) * 0.3 * size;
      sp.position.set(Math.cos(a) * rr, hy, Math.sin(a) * rr * 0.6);
      const s = size * (0.45 + Math.random() * 0.45) * (hy > 0 ? 0.85 : 1.15);
      sp.scale.set(s, s * (hy > 0 ? 0.72 : 0.5), 1);
      // lower puffs darker / bluer, upper puffs sunlit warm
      const k = Math.max(0, Math.min(1, 0.5 + hy / (0.3 * size)));
      sp.material.color.setRGB(0.66 + 0.3 * k, 0.69 + 0.28 * k, 0.76 + 0.22 * k);
    }
  }
  function resetCloud(g, initial) {
    const r = Math.random();
    const kind = r < 0.42 ? "low" : r < 0.66 ? "level" : r < 0.84 ? "tower" : "near";
    let x0, y0, size;
    if (kind === "low") { // broken deck ~150–250 m below the box
      x0 = (Math.random() - 0.5) * 5000; y0 = -95 - Math.random() * 70; size = 130 + Math.random() * 220;
    } else if (kind === "level") { // level with the box, off to the sides
      x0 = (Math.random() < 0.5 ? -1 : 1) * (400 + Math.random() * 2600); y0 = -30 + Math.random() * 70; size = 120 + Math.random() * 240;
    } else if (kind === "tower") { // 1.3.6: big distant cumulus build-ups, layered toward the horizon
      x0 = (Math.random() < 0.5 ? -1 : 1) * (1800 + Math.random() * 3200); y0 = -260 + Math.random() * 120; size = 420 + Math.random() * 480;
    } else { // small puffs streaming past close by — 280 mph made visible
      x0 = (Math.random() < 0.5 ? -1 : 1) * (170 + Math.random() * 220); y0 = -50 + Math.random() * 90; size = 26 + Math.random() * 30;
    }
    g.position.set(x0, y0, initial ? -2400 + Math.random() * 8400 : 5200 + Math.random() * 2400);
    g.userData.kind = kind;
    shapeCluster(g, size);
  }
  for (let i = 0; i < 30; i++) {
    const g = buildCluster();
    resetCloud(g, true);
    cloudClusters.push(g);
  }
  // 1.3.6: a second, lower layer — flat fair-weather cumulus ~2 km below, over the ground haze
  const lowDeck = [];
  // 1.4.0: two decks (≈1.3 km and ≈2.2 km below) with a darker, flatter underside under every cloud → depth
  function resetLow(sp, initial) {
    const deep = sp.userData.deep, s = (deep ? 420 : 280) + Math.random() * (deep ? 700 : 480);
    sp.scale.set(s, s * 0.3, 1);
    sp.position.set((Math.random() - 0.5) * 20000, deep ? -3300 - Math.random() * 900 : -1900 - Math.random() * 600, initial ? -7000 + Math.random() * 20000 : 12000 + Math.random() * 3000);
    const u = sp.userData.under; if (u) { u.scale.set(s * 0.92, s * 0.16, 1); u.position.set(sp.position.x, sp.position.y - s * 0.07, sp.position.z); }
  }
  for (let i = 0; i < 40; i++) {
    const deep = i % 3 === 0;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTexs[i % 4], transparent: true, depthWrite: false, opacity: deep ? 0.72 : 0.86, fog: true, color: deep ? 0xd8dee6 : 0xeef2f6 }));
    const under = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTexs[(i + 1) % 4], transparent: true, depthWrite: false, opacity: 0.5, fog: true, color: 0x8a94a2 }));
    under.renderOrder = -1; sp.userData.deep = deep; sp.userData.under = under;
    resetLow(sp, true); scene.add(under); scene.add(sp); lowDeck.push(sp);
  }
  const cloudSprites = cloudClusters; // legacy name
  void cloudSprites;

  // 1.3.6 flak: black 88 mm bursts hanging in the air (they stream aft at the box's airspeed),
  // depth-tested sprites instead of the old 2D overlay
  const flakPool = [];
  for (let i = 0; i < 30; i++) {
    const fl = new THREE.Sprite(new THREE.SpriteMaterial({ map: fireTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    fl.visible = false; scene.add(fl);
    const puffs = [0, 1, 2, 3].map(() => { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, color: 0x1c1b1a, transparent: true, depthWrite: false, fog: true })); sp.visible = false; scene.add(sp); return sp; });
    flakPool.push({ fl, puffs, age: 99, off: puffs.map(() => new THREE.Vector3()), x: 0, y: 0, z: 0 });
  }
  let _flakAcc = 0;
  function updateFlak(on, dt, dz) {
    if (on) _flakAcc += dt * 2.6;
    while (_flakAcc >= 1) {
      _flakAcc -= 1;
      const f = flakPool.find((q) => q.age > 5);
      if (!f) break;
      f.age = 0; f.x = (Math.random() - 0.5) * 900; f.y = -60 + Math.random() * 300; f.z = -150 + Math.random() * 1100;
      f.off.forEach((o, k) => o.set((Math.random() - 0.5) * 7, (Math.random() - 0.3) * 5, (Math.random() - 0.5) * 7).multiplyScalar(k ? 1 : 0.2));
      if (window.FGAudio) window.FGAudio.flak(f.x, f.y, f.z); // 1.3.7: the crump
    }
    for (const f of flakPool) {
      if (f.age > 5) { f.fl.visible = false; f.puffs.forEach((p) => { p.visible = false; }); continue; }
      f.age += dt; f.z -= dz;
      const t = f.age;
      f.fl.visible = t < 0.14;
      if (f.fl.visible) { f.fl.position.set(f.x, f.y, f.z); const s = 9 + t * 60; f.fl.scale.set(s, s, 1); f.fl.material.opacity = 1 - t / 0.14; }
      const grow = 0.4 + Math.min(1, t / 1.1) * 0.8, a = t < 0.1 ? t / 0.1 : Math.max(0, 1 - (t - 0.1) / 4.9);
      f.puffs.forEach((p, k) => {
        p.visible = a > 0.01;
        p.position.set(f.x + f.off[k].x * grow, f.y + f.off[k].y * grow + t * 0.6, f.z + f.off[k].z * grow);
        const s = (14 + k * 3) * grow; p.scale.set(s, s, 1); p.material.opacity = 0.78 * a;
      });
    }
  }

  // ===== 1.3.8: 88 mm FLAK — flash, then a black-brown, oily, ragged cloud that expands, drifts, lingers =====
  // One small mesh per live burst (8 camera-facing puffs expanded in the vertex shader) so three.js
  // sorts every burst against the cloud sprites; depth-tested (our airframe / other ships hide it) + fog.
  const flakAtlas = (() => {
    const c = document.createElement("canvas"); c.width = 512; c.height = 256;
    const x = c.getContext("2d");
    for (let cell = 0; cell < 8; cell++) {
      const cx = (cell % 4) * 128 + 64, cy = ((cell / 4) | 0) * 128 + 64;
      x.save(); x.beginPath(); x.rect(cx - 64, cy - 64, 128, 128); x.clip();
      for (let k = 0; k < 46; k++) { // clumped soft blobs → cauliflower/ragged outline
        const a = Math.random() * Math.PI * 2, rr = Math.pow(Math.random(), 0.7) * 34;
        const bx = cx + Math.cos(a) * rr, by = cy + Math.sin(a) * rr * 0.9, br = 10 + Math.random() * 18;
        const lum = 150 + Math.random() * 90 - (by - cy) * 0.9; // fake light from above
        const g = x.createRadialGradient(bx, by, 0, bx, by, br);
        g.addColorStop(0, `rgba(${lum | 0},${lum * 0.94 | 0},${lum * 0.86 | 0},0.55)`);
        g.addColorStop(0.6, `rgba(${lum * 0.8 | 0},${lum * 0.74 | 0},${lum * 0.66 | 0},0.32)`);
        g.addColorStop(1, "rgba(0,0,0,0)");
        x.fillStyle = g; x.beginPath(); x.arc(bx, by, br, 0, Math.PI * 2); x.fill();
      }
      // ragged bites out of the edge + oily streaks
      x.globalCompositeOperation = "destination-out";
      for (let k = 0; k < 18; k++) { const a = Math.random() * Math.PI * 2, rr = 40 + Math.random() * 18, br = 6 + Math.random() * 12; const g = x.createRadialGradient(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 0, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, br); g.addColorStop(0, "rgba(0,0,0,0.9)"); g.addColorStop(1, "rgba(0,0,0,0)"); x.fillStyle = g; x.fillRect(cx - 64, cy - 64, 128, 128); }
      x.globalCompositeOperation = "source-over";
      for (let k = 0; k < 3; k++) { const a = Math.random() * Math.PI * 2; x.strokeStyle = "rgba(120,110,95,0.25)"; x.lineWidth = 3 + Math.random() * 4; x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx + Math.cos(a) * 58, cy + Math.sin(a) * 58); x.stroke(); }
      x.restore();
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const flakMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: null } }]),
    vertexShader: [
      "attribute vec2 corner; attribute vec4 aData; attribute vec3 aTint;",
      "varying vec2 vUv; varying float vA; varying vec3 vT;",
      "#include <fog_pars_vertex>",
      "void main(){",
      "  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);",
      "  float c = cos(aData.z), s = sin(aData.z);",
      "  mvPosition.xy += vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * aData.x;",
      "  gl_Position = projectionMatrix * mvPosition;",
      "  vUv = (vec2(mod(aData.w, 4.0), floor(aData.w / 4.0)) + corner + 0.5) / vec2(4.0, 2.0);",
      "  vA = aData.y; vT = aTint;",
      "  #include <fog_vertex>",
      "}"].join("\n"),
    fragmentShader: [
      "uniform sampler2D map; varying vec2 vUv; varying float vA; varying vec3 vT;",
      "#include <fog_pars_fragment>",
      "void main(){ vec4 t = texture2D(map, vUv); float a = min(1.0, t.a * 1.6) * vA; if (a < 0.004) discard;",
      "  gl_FragColor = vec4(t.rgb * vT, a);",
      "  #include <fog_fragment>",
      "}"].join("\n"),
    transparent: true, depthWrite: false, depthTest: true, fog: true,
  });
  flakMat.uniforms.map.value = flakAtlas;
  const FP = 9; // puffs per burst
  const flakFlashTex = (() => {
    const c = document.createElement("canvas"); c.width = c.height = 64; const x = c.getContext("2d");
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,250,220,1)"); g.addColorStop(0.18, "rgba(255,190,90,1)"); g.addColorStop(0.45, "rgba(255,90,30,0.75)"); g.addColorStop(1, "rgba(160,20,0,0)");
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  // 1.5.4 sun-glare bloom: a big soft white-blue glow that flares with the shell flash and dies in ~0.3 s (additive, one sprite per pooled burst)
  const flakBloomTex = (() => {
    const c = document.createElement("canvas"); c.width = c.height = 128; const x = c.getContext("2d");
    const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(255,255,250,0.95)"); g.addColorStop(0.12, "rgba(255,248,225,0.6)"); g.addColorStop(0.35, "rgba(240,238,235,0.22)"); g.addColorStop(0.7, "rgba(200,215,240,0.07)"); g.addColorStop(1, "rgba(200,215,240,0)");
    x.fillStyle = g; x.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const flakMeshes = [];
  for (let i = 0; i < 130; i++) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(FP * 4 * 3), cor = new Float32Array(FP * 4 * 2), dat = new Float32Array(FP * 4 * 4), tin = new Float32Array(FP * 4 * 3), idx = [];
    for (let p = 0; p < FP; p++) {
      const v = p * 4; cor.set([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5], v * 2);
      idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
    }
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("corner", new THREE.BufferAttribute(cor, 2));
    geo.setAttribute("aData", new THREE.BufferAttribute(dat, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aTint", new THREE.BufferAttribute(tin, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(idx);
    const m = new THREE.Mesh(geo, flakMat); m.frustumCulled = false; m.visible = false; scene.add(m);
    const fl = new THREE.Sprite(new THREE.SpriteMaterial({ map: flakFlashTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    fl.visible = false; scene.add(fl);
    flakMeshes.push({ m, fl, id: -1, puffs: null });
  }
  const flakLight = new THREE.PointLight(0xff7a30, 0, 140, 1.2); scene.add(flakLight);
  // 1.4.0 flak debris: dark shell fragments + a few hot sparks thrown out of each burst, falling under gravity
  const DEB_N = 900;
  const debGeo = new THREE.BufferGeometry();
  const debPos = new Float32Array(DEB_N * 3), debCol = new Float32Array(DEB_N * 3);
  debGeo.setAttribute("position", new THREE.BufferAttribute(debPos, 3));
  debGeo.setAttribute("color", new THREE.BufferAttribute(debCol, 3));
  const debMat = new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, fog: true });
  const debPts = new THREE.Points(debGeo, debMat); debPts.frustumCulled = false; scene.add(debPts);
  const deb = []; for (let i = 0; i < DEB_N; i++) deb.push({ t: 99, x: 0, y: -1e5, z: 0, vx: 0, vy: 0, vz: 0, hot: false, life: 1 });
  let debNext = 0;
  function spawnDebris(x, y, z, n, scale) {
    for (let i = 0; i < n; i++) {
      const d = deb[debNext]; debNext = (debNext + 1) % DEB_N;
      const a = Math.random() * 6.283, e = (Math.random() - 0.35) * 2.2, sp = (18 + Math.random() * 55) * scale;
      d.x = x; d.y = y; d.z = z; d.vx = Math.cos(a) * Math.cos(e) * sp; d.vy = Math.sin(e) * sp * 0.7; d.vz = Math.sin(a) * Math.cos(e) * sp;
      d.hot = i < n * 0.3; d.t = 0; d.life = d.hot ? 0.25 + Math.random() * 0.35 : 1.4 + Math.random() * 1.6;
    }
  }
  let debLast = pnow();
  function updateFlakDebris(dz) { // 1.5.4: renamed — it shared its name with the wreck-debris updater below, so in 1.5.3 the flak shell-fragment pool was never stepped
    const now = pnow(), dt = Math.min(0.05, (now - debLast) / 1000); debLast = now;
    for (let i = 0; i < DEB_N; i++) {
      const d = deb[i];
      if (d.t < d.life) {
        d.t += dt; d.vy -= 9.8 * dt; const drag = Math.exp(-dt * 1.6); d.vx *= drag; d.vy *= drag; d.vz *= drag;
        d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt - dz;
        debPos[i * 3] = d.x; debPos[i * 3 + 1] = d.y; debPos[i * 3 + 2] = d.z;
        const f = 1 - d.t / d.life;
        if (d.hot) { debCol[i * 3] = 1.0 * f + 0.1; debCol[i * 3 + 1] = 0.62 * f + 0.05; debCol[i * 3 + 2] = 0.2 * f; }
        else { debCol[i * 3] = 0.07; debCol[i * 3 + 1] = 0.065; debCol[i * 3 + 2] = 0.06; }
      } else debPos[i * 3 + 1] = -1e5;
    }
    debGeo.attributes.position.needsUpdate = true; debGeo.attributes.color.needsUpdate = true;
  }
  const flakStats = { live: 0, flashes: 0, maxLive: 0 };
  function prng(seed) { let s = (seed * 9301 + 49297) % 233280; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; }
  function updateFlakBursts(list) {
    list = list || [];
    const byId = new Map(); for (const b of list) if (b.t >= 0) byId.set(b.id, b);
    // keep each burst in its mesh
    for (const F of flakMeshes) if (F.id >= 0 && !byId.has(F.id)) { F.id = -1; F.m.visible = false; F.fl.visible = false; }
    const used = new Set(flakMeshes.filter((F) => F.id >= 0).map((F) => F.id));
    for (const b of byId.values()) {
      if (used.has(b.id)) continue;
      const F = flakMeshes.find((q) => q.id < 0); if (!F) break;
      F.id = b.id; used.add(b.id);
      const r = prng(Math.floor(b.seed * 1000) + 7);
      F.puffs = [];
      // 1.4.0: ragged, lopsided bursts — a random blast axis stretches the lobes, each burst has its own size and a
      // warm/cool/brown tint, and some lobes are thrown further out (no two bursts look like the same ball)
      const sz = b.size || 1, ax = r() * 6.283, ay = (r() - 0.5) * 1.2, str = 1 + r() * 1.3;
      const bx = Math.cos(ax) * Math.cos(ay), by = Math.sin(ay), bz = Math.sin(ax) * Math.cos(ay);
      const tint = r(); F.tint = tint < 0.33 ? [1.12, 1.0, 0.86] : tint < 0.66 ? [0.9, 0.93, 1.02] : [1.0, 0.97, 0.95];
      F.dark = 0.7 + r() * 0.6;
      for (let p = 0; p < FP; p++) {
        const a = r() * Math.PI * 2, e = (r() - 0.5) * 1.6, d = p === 0 ? 0 : (1.0 + r() * 3.4) * (r() < 0.25 ? 1.8 : 1);
        let ox = Math.cos(a) * Math.cos(e) * d, oy = Math.sin(e) * d * 0.8, oz = Math.sin(a) * Math.cos(e) * d;
        const along = (ox * bx + oy * by + oz * bz) * (str - 1); ox += bx * along; oy += by * along; oz += bz * along;
        F.puffs.push({ ox: ox * sz, oy: oy * sz, oz: oz * sz, s: (p === 0 ? 9.5 : 4 + r() * 6.5) * sz, rot: r() * 6.28, spin: (r() - 0.5) * 0.25, cell: (r() * 8) | 0, lum: 0.7 + r() * 0.6, wx: (r() - 0.5) * 1.3, wz: (r() - 0.5) * 1.3, late: r() * 0.5 });
      }
      // 1.5.5: no flak shell-fragment points (in 1.5.3 that pool was never stepped, so they were never visible)
    }
    let live = 0, best = null, bestD = 1e9;
    for (const F of flakMeshes) {
      if (F.id < 0) continue;
      const b = byId.get(F.id); if (!b) continue;
      live++;
      const t = b.t;
      F.m.visible = true; F.m.position.set(b.x, b.y, b.z);
      const geo = F.m.geometry, pos = geo.attributes.position.array, dat = geo.attributes.aData.array, tin = geo.attributes.aTint.array;
      const grow = 1 - Math.exp(-t * 5.5);       // fast blast expansion, then slow billowing
      const fade = t < 0.04 ? t / 0.04 : t < 5 ? 1 : Math.max(0, 1 - (t - 5) / 8.5);
      const glow = Math.max(0, 1 - t / 0.45);   // hot orange core in the first instants
      for (let p = 0; p < FP; p++) {
        const P = F.puffs[p], tp = Math.max(0, t - P.late * 0.2);
        const g2 = 1 - Math.exp(-tp * 5.5);
        const ox = P.ox * (0.35 + 1.1 * g2) + P.wx * t, oy = P.oy * (0.35 + 1.1 * g2) + 0.22 * t, oz = P.oz * (0.35 + 1.1 * g2) + P.wz * t;
        const size = P.s * (0.3 + 0.75 * g2) + t * 0.55;
        const alpha = 0.92 * fade * (p === 0 ? 1 : 0.9) * (1 - 0.3 * Math.min(1, t / 12));
        const kGlow = glow * (p === 0 ? 1 : 0.6);
        const tr = (0.12 + 0.03 * P.lum) * (1 - kGlow) + 2.2 * kGlow, tg = (0.10 + 0.025 * P.lum) * (1 - kGlow) + 0.75 * kGlow, tb = (0.085 + 0.02 * P.lum) * (1 - kGlow) + 0.2 * kGlow;
        for (let v = 0; v < 4; v++) {
          const o = (p * 4 + v);
          pos[o * 3] = ox; pos[o * 3 + 1] = oy; pos[o * 3 + 2] = oz;
          dat[o * 4] = size; dat[o * 4 + 1] = alpha; dat[o * 4 + 2] = P.rot + P.spin * t; dat[o * 4 + 3] = P.cell;
          const kk = P.lum * (kGlow > 0.02 ? 1 : F.dark);
          tin[o * 3] = tr * kk * F.tint[0]; tin[o * 3 + 1] = tg * kk * F.tint[1]; tin[o * 3 + 2] = tb * kk * F.tint[2];
        }
      }
      void grow;
      geo.attributes.position.needsUpdate = true; geo.attributes.aData.needsUpdate = true; geo.attributes.aTint.needsUpdate = true;
      // the instant flash: bright orange-red, ~0.12 s
      F.fl.visible = t < 0.16;
      if (F.fl.visible) { F.fl.position.set(b.x, b.y, b.z); const s = (10 + t * 90) * (b.size || 1); F.fl.scale.set(s, s, 1); F.fl.material.opacity = Math.min(1, 1.25 * (1 - t / 0.16)); flakStats.flashes++; }
      if (t < 0.18) { const d = camera.position.distanceTo(F.m.position); if (d < bestD) { bestD = d; best = { b, t }; } }
    }
    flakStats.live = live; flakStats.maxLive = Math.max(flakStats.maxLive, live);
    if (best && bestD < 160) { flakLight.position.set(best.b.x, best.b.y, best.b.z); flakLight.intensity = 140 * (1 - best.t / 0.18); } else flakLight.intensity = 0;
  }

  // ===== 1.5.3 CONTRAILS (Masters-of-the-Air look): every Fortress engine lays a long, parallel, slowly widening/fading white trail that streams aft
  // (air-fixed, so they all run parallel and converge on the horizon); distant bomber groups add more; every fighter draws a thin curving trail along its
  // real path (P-51 brighter/bolder, Germans subtler; it thickens on hard pulls). Three merged ribbon meshes = 3 draw calls, bounded vertex pools,
  // vertex alpha fades them out near the lens so they never smear across the guns/reticle.
  const _yAxis = new THREE.Vector3(0, 1, 0); let _detT = null;
  const AIR_DRIFT = 53.6; // the air mass streams aft at the formation speed (1.5.7: 180 mph = 53.6 u/s; was 83.4 at 280 mph) in the box frame
  const conTex = (() => {
    const W = 64, H = 128, c = document.createElement("canvas"); c.width = W; c.height = H;
    const x = c.getContext("2d"); const img = x.createImageData(W, H);
    let sd = 5; const R = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
    const bl = []; for (let k = 0; k < 46; k++) bl.push([R() * W, R() * H, 4 + R() * 9, 0.4 + R() * 0.6]);
    for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
      const w = (u - (W - 1) / 2) / ((W - 1) / 2);
      let n = 0; for (const [bx, by, br, ba] of bl) for (const oy of [-H, 0, H]) { const dx = (u - bx) / br, dy = (v - by - oy) / (br * 2.4), d = dx * dx + dy * dy; if (d < 1) n += ba * (1 - d); }
      const lump = 0.62 + 0.38 * Math.min(1, n);
      const across = Math.exp(-w * w * 2.4) * (1 - w * w * w * w);
      const o = (v * W + u) * 4; img.data[o] = 255; img.data[o + 1] = 255; img.data[o + 2] = 255; img.data[o + 3] = 255 * across * lump;
    }
    x.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapT = THREE.RepeatWrapping; t.flipY = false; return t;
  })();
  const conMat = new THREE.MeshBasicMaterial({ map: conTex, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
  function ribMesh(nRib, nPts) { // nRib ribbons × nPts sections, one draw call
    const V = nRib * nPts * 2;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(V * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(V * 4), 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(V * 2), 2).setUsage(THREE.DynamicDrawUsage));
    const idx = new Uint32Array(nRib * (nPts - 1) * 6); g.setIndex(new THREE.BufferAttribute(idx, 1).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.Mesh(g, conMat); m.frustumCulled = false; m.renderOrder = 2; m.visible = false; scene.add(m);
    return { m, g, nRib, nPts, pos: g.attributes.position.array, col: g.attributes.color.array, uv: g.attributes.uv.array, idx, ni: 0, used: 0 };
  }
  const rmBegin = (R) => { R.ni = 0; R.used = 0; };
  // add one section (vertex pair) of ribbon r at index i of nPts
  function rmSec(R, r, i, px, py, pz, tx, ty, tz, w, wMin, red, grn, blu, a, v) {
    _ca.set(camera.position.x - px, camera.position.y - py, camera.position.z - pz);
    const dist = _ca.length();
    _cw.set(tx, ty, tz).cross(_ca); let L = _cw.length();
    if (L < 1e-4) { _cw.set(1, 0, 0); L = 1; }
    const ww = Math.max(w, dist * wMin) * 0.5 / L; _cw.multiplyScalar(ww);
    const nf = dist < 45 ? 0 : dist > 240 ? 1 : (dist - 45) / 195; a *= nf * nf * (3 - 2 * nf); // never smear across the lens
    const o = (r * R.nPts + i) * 6, c = (r * R.nPts + i) * 8, u = (r * R.nPts + i) * 4;
    R.pos[o] = px - _cw.x; R.pos[o + 1] = py - _cw.y; R.pos[o + 2] = pz - _cw.z; R.pos[o + 3] = px + _cw.x; R.pos[o + 4] = py + _cw.y; R.pos[o + 5] = pz + _cw.z;
    R.col[c] = R.col[c + 4] = red; R.col[c + 1] = R.col[c + 5] = grn; R.col[c + 2] = R.col[c + 6] = blu; R.col[c + 3] = R.col[c + 7] = a;
    R.uv[u] = 0; R.uv[u + 1] = v; R.uv[u + 2] = 1; R.uv[u + 3] = v;
  }
  function rmLink(R, r, n) { // connect n sections of ribbon r
    for (let i = 0; i < n - 1; i++) { const a = (r * R.nPts + i) * 2; R.idx[R.ni++] = a; R.idx[R.ni++] = a + 1; R.idx[R.ni++] = a + 2; R.idx[R.ni++] = a + 1; R.idx[R.ni++] = a + 3; R.idx[R.ni++] = a + 2; }
  }
  function rmEnd(R) {
    R.g.setDrawRange(0, R.ni); R.m.visible = R.ni > 0;
    R.g.attributes.position.needsUpdate = true; R.g.attributes.color.needsUpdate = true; R.g.attributes.uv.needsUpdate = true; R.g.index.needsUpdate = true;
  }
  const _ca = new THREE.Vector3(), _cp = new THREE.Vector3(), _cw = new THREE.Vector3();
  const conStats = { bomberRibs: 0, fighterRibs: 0, verts: 0, bomberVerts: 0, fighterVerts: 0, ms: 0, cap: 0 };
  // --- 1.5.4 bombers: TRUE per-plane trails. Every Fortress (4 engines) leaves world-space points as it flies; they stay in the
  // air mass (stream aft by the distance flown, swing with the formation's turn), so the trails curve when the box turns for home.
  const CB_PTS = 72, CB_DT = 0.5, CB_LIFE = 35;
  const bomberR = ribMesh(18 * 4, CB_PTS), conAnchors = [];
  let _cDz = 0, _cDH = 0, _cReset = false;
  function addContrails(group, pts) {
    const arr = [];
    for (const q of pts) {
      const anchor = new THREE.Object3D(); anchor.position.set(q[0], q[1], q[2]); group.add(anchor);
      const c = { anchor, group, on: true, pts: [], acc: 0, seeded: false };
      conAnchors.push(c); arr.push(c);
    }
    group.userData.contrails = arr;
  }
  function stepBomberTrails(dt0) {
    const dt = _cDz / AIR_DRIFT; // air-mass time: trails age with the distance the box has flown (robust to frame pacing, frozen when paused)
    const R = bomberR; rmBegin(R); let r = 0, nv = 0;
    const cs = Math.cos(-_cDH), sn = Math.sin(-_cDH);
    for (const c of conAnchors) {
      const vis = c.on && c.group.visible, P = c.pts;
      if (_cReset) { P.length = 0; c.seeded = false; }
      if (vis) {
        c.anchor.getWorldPosition(_cp);
        if (!c.seeded) { // the formation has been flying straight for a while: lay the history down so the sky is full from the first second
          c.seeded = true; P.length = 0;
          for (let a = CB_LIFE - 0.3; a > 0; a -= CB_DT) P.push({ x: _cp.x + (Math.random() - 0.5) * 0.6, y: _cp.y + (Math.random() - 0.5) * 0.5, z: _cp.z - AIR_DRIFT * a, age: a });
        }
      }
      for (const p of P) {
        p.age += dt;
        if (_cDH) { const x = p.x, z = p.z; p.x = x * cs + z * sn; p.z = -x * sn + z * cs; }
        p.z -= _cDz;
      }
      while (P.length && P[0].age >= CB_LIFE) P.shift();
      if (vis) { c.acc -= dt; if (c.acc <= 0) { c.acc = CB_DT; P.push({ x: _cp.x, y: _cp.y, z: _cp.z, age: 0 }); if (P.length > CB_PTS) P.shift(); } }
      const n = P.length;
      if (n < 2 || r >= R.nRib) continue;
      let vco = 0;
      for (let i = 0; i < n; i++) {
        const p = P[i], pa = P[Math.max(0, i - 1)], pb = P[Math.min(n - 1, i + 1)];
        if (i) vco += Math.hypot(p.x - pa.x, p.y - pa.y, p.z - pa.z) / 36;
        const k = Math.min(1, p.age / CB_LIFE), fadeIn = Math.min(1, Math.max(0, (p.age - 0.2) / 0.7));
        const al = 0.55 * fadeIn * Math.pow(1 - k, 1.5), w = 0.3 + 14 * Math.pow(k, 0.72);
        rmSec(R, r, i, p.x, p.y, p.z, pb.x - pa.x, pb.y - pa.y, pb.z - pa.z, w, 0.0018, 1, 1, 1, al, vco);
      }
      rmLink(R, r, n); r++; nv += n * 2;
    }
    _cReset = false;
    R.used = r; rmEnd(R); conStats.bomberRibs = r; conStats.bomberVerts = nv;
  }
  // --- fighters: thin path ribbons from each fighter's own history
  const CF_P = 56, CF_R = 64;
  const fighterR = ribMesh(CF_R, CF_P), fTrails = new Map(), fFree = [];
  for (let i = CF_R - 1; i >= 0; i--) fFree.push(i);
  function conEmitFighter(e, hpFrac, dt, now) {
    let T = fTrails.get(e.id);
    if (!T) {
      let r = fFree.pop();
      if (r == null) { let oldest = null; for (const [id, q] of fTrails) if (!q.live && (!oldest || q.lastT < oldest.q.lastT)) oldest = { id, q }; if (!oldest) return; r = oldest.q.r; fTrails.delete(oldest.id); }
      T = { r, pts: [], last: 0, pv: null, g: 1, live: true, lastT: now, p51: e.team === "allied" };
      fTrails.set(e.id, T);
    }
    T.live = true; T.lastT = now;
    const vx = e.vx || 0, vy = e.vy || 0, vz = e.vz || 0;
    if (T.pv && dt > 0) { // g-load from the change of the (air-frame) velocity: pulls thicken the trail
      const ax = (vx - T.pv[0]) / dt, ay = (vy - T.pv[1]) / dt, az = (vz - T.pv[2]) / dt;
      const v = Math.hypot(vx, vy, vz + AIR_DRIFT) || 1, along = (ax * vx + ay * vy + az * (vz + AIR_DRIFT)) / v;
      const lat = Math.sqrt(Math.max(0, ax * ax + ay * ay + az * az - along * along));
      T.g += ((1 + lat / 6.5) - T.g) * Math.min(1, dt * 6);
    }
    T.pv = [vx, vy, vz];
    T.last -= dt;
    if (T.last <= 0 && e.alive) {
      T.last = 0.1;
      const gm = Math.min(1, Math.max(0, (T.g - 1.8) / 4.5));
      const hit = hpFrac < 0.99;
      T.pts.push({ x: e.x, y: e.y, z: e.z, age: 0, wm: 1 + 1.3 * gm, am: (1 + 0.8 * gm) * (hpFrac <= 0.4 ? 0.25 : hit ? 0.55 : 1) });
      if (T.pts.length > CF_P) T.pts.shift();
    }
  }
  function updateFighterTrails(dt, activeIds) {
    const R = fighterR; rmBegin(R); let live = 0, nv = 0;
    for (const [id, T] of fTrails) {
      T.live = activeIds.has(id);
      const P = T.pts, life = T.p51 ? 8.5 : 6.5;
      { const cs = Math.cos(-_cDH), sn = Math.sin(-_cDH); for (const p of P) { p.age += dt; if (_cDH) { const x = p.x, z = p.z; p.x = x * cs + z * sn; p.z = -x * sn + z * cs; } p.z -= _cDz; } }
      while (P.length && P[0].age >= life) P.shift();
      if (P.length < 2) { if (!T.live && !P.length) { fFree.push(T.r); fTrails.delete(id); } continue; }
      const A0 = T.p51 ? 0.7 : 0.4, W0 = T.p51 ? 0.55 : 0.4, W1 = T.p51 ? 3.1 : 2.2, col = T.p51 ? 1 : 0.94;
      let vcoord = 0, n = P.length;
      for (let i = 0; i < n; i++) {
        const p = P[i], a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
        if (i) vcoord += Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z) / 14;
        const k = p.age / life, w = (W0 + (W1 - W0) * Math.sqrt(k)) * p.wm;
        const al = A0 * p.am * Math.pow(1 - k, 1.25) * Math.min(1, p.age / 0.12 + 0.3) * (i === n - 1 && T.live ? 0.6 : 1);
        rmSec(R, T.r, i, p.x, p.y, p.z, b.x - a.x, b.y - a.y, b.z - a.z, w, 0.0011, col, col, T.p51 ? 1 : 0.98, al, vcoord);
      }
      rmLink(R, T.r, n); live++; nv += n * 2;
    }
    rmEnd(R); conStats.fighterRibs = live; conStats.fighterVerts = nv;
  }
  let _conT = pnow(), _conActive = new Set(), _conDtLast = 0.016;
  function updateContrails() {
    if (window.__FG_NOCON) { bomberR.m.visible = fighterR.m.visible = false; return; } // test toggle
    const t0 = performance.now();
    const now = pnow(), dt = Math.min(0.1, Math.max(0, (now - _conT) / 1000)); _conT = now; _conDtLast = dt || 0.016;
    stepBomberTrails(dt);
    updateFighterTrails(dt, _conActive); _conActive = new Set();
    conStats.verts = bomberR.ni / 3 + fighterR.ni / 3;
    conStats.ms += (performance.now() - t0 - conStats.ms) * 0.05;
  }
  for (const g of friendlyPool) addContrails(g, NACELLE_X.map((nx) => [nx * B17_VIS, -0.01 * B17_VIS, -0.05 * B17_VIS]));
  // own-ship trails omitted: from the turret they fan across the whole view
  if (false) addContrails(ownShip, [[8.3, -2.3, -2.5], [4.3, -2.5, -3.0], [-4.3, -2.5, -3.0], [-8.3, -2.3, -2.5]]);

  let _lastT = pnow();
  const _v = new THREE.Vector3();
  let _odo = null, _hd = 0;
  function syncMission(opts) {
    const now = pnow();
    let dt = Math.min(0.05, (now - _lastT) / 1000);
    _lastT = now;
    // 1.6.1: under freeze / harness advance, drive ground FX + bombs from __FG_SIMT so they match game.js
    if (window.__FG_FREEZE && window.__FG_SIMT != null) {
      const prev = syncMission._simT; syncMission._simT = window.__FG_SIMT;
      if (prev != null) dt = Math.min(0.25, Math.max(0, window.__FG_SIMT - prev));
    }
    // --- ground frame from the game's odometer (world units): moves at the box's true ground speed ---
    const geo = opts.geo || { x: 0, z: 0, rot: 0 }; _geoNow = geo;
    groundFrame.position.set(CAM.x + (geo.x - CAM.x) / EARTH_K, GROUND_Y, CAM.z + (geo.z - CAM.z) / EARTH_K);
    groundFrame.rotation.y = geo.rot || 0;
    // --- clouds + flak: stationary in the air → stream aft by the distance flown, swing with the turn ---
    const odo = opts.odo || 0;
    let dz = _odo == null ? 0 : odo - _odo;
    if (dz < 0 || dz > 400) { dz = 0; _cReset = true; if (typeof crashReset === "function" && CR.nSc + CR.sites.length) crashReset(); } // new mission / big jump
    _odo = odo;
    const hd = opts.heading || 0;
    let dH = hd - _hd; _hd = hd;
    if (Math.abs(dH) > 0.5) dH = 0;
    _cDz = dz; _cDH = dH;
    const c = Math.cos(-dH), s = Math.sin(-dH);
    const rot = (o) => { const x = o.position.x, z = o.position.z; o.position.x = x * c + z * s; o.position.z = -x * s + z * c; };
    for (const g of cloudClusters) {
      if (dH) rot(g);
      g.position.z -= dz;
      if (g.position.z < -2600 || Math.abs(g.position.x) > 6000 || g.position.z > 9000) resetCloud(g, false);
    }
    for (const sp of lowDeck) {
      if (dH) rot(sp);
      sp.position.z -= dz;
      if (sp.position.z < -8000 || Math.abs(sp.position.x) > 14000 || sp.position.z > 16000) resetLow(sp, false);
      const u = sp.userData.under; if (u) { u.position.x = sp.position.x; u.position.z = sp.position.z; }
    }
    if (dH) for (const gg of friendlyPool) { const ds = gg.userData.dets; if (!ds) continue; for (const grp of ds) { if (grp.userData.dead) continue; const u = grp.userData; rot(grp); const vx = u.vx, vz = u.vz; u.vx = vx * c + vz * s; u.vz = -vx * s + vz * c; grp.rotateOnWorldAxis(_yAxis, -dH); } } // 1.5.8: falling pieces are in the air mass too
    if (dH) for (const f of flakPool) { const x = f.x, z = f.z; f.x = x * c + z * s; f.z = -x * s + z * c; }
    updateFlak(!!opts.flakOn, dt, dz);
    updateFlakBursts(opts.flakBursts);
    updateRockets(opts.rockets);
    updateDebris(dz);
    updateFlakDebris(dz);
    updateChutes3D(opts.chutes);
    // sun + sky stay fixed in the world: rotate with −heading in the box frame
    const sd = sunDir0.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -hd);
    skyU.uSun.value.copy(sd);
    sun.position.copy(sd).multiplyScalar(100);
    skyMesh.position.copy(camera.position);
    townBombing(opts, dt);
    // Friendlies
    const fr = opts.friendlies || [];
    const bySlot = new Array(friendlyPool.length).fill(null);
    for (let j = 0; j < fr.length; j++) {
      const s = fr[j].slot != null ? fr[j].slot : j;
      if (s >= 0 && s < bySlot.length) bySlot[s] = fr[j];
    }
    { // 1.5.8: only the nearest few wrecks get smoke trails / flame tongues (cheap LOD + a hard cap on simultaneous wrecks)
      const wr = [];
      for (let q = 0; q < friendlyPool.length; q++) { const gg = friendlyPool[q], ff = bySlot[q]; gg.userData.trailOn = false; if ((ff && ff.spiraling && ff.health >= 0) || (gg.userData.dets && gg.userData.dets.some((d) => !d.userData.dead))) wr.push([gg.position.distanceTo(camera.position), gg]); }
      wr.sort((a, b) => a[0] - b[0]); for (let q = 0; q < wr.length && q < WRECK_TRAILS; q++) wr[q][1].userData.trailOn = true;
      detStats.live = wr.length; if (wr.length > detStats.maxLive) detStats.maxLive = wr.length;
    }
    const _st = window.__FG_SIMT || 0; const sdt = _detT == null ? dt : Math.max(0, Math.min(2.5, _st - _detT)); _detT = _st;
    let i = 0;
    for (; i < friendlyPool.length; i++) {
      const g = friendlyPool[i];
      const f = bySlot[i];
      if (f && f.blownApart && !f._fxDone) { // 1.3.8: direct 88 mm hit — the Fortress is blown apart
        f._fxDone = true;
        const P = new THREE.Vector3(f.x, f.y, f.z);
        for (let k = 0; k < 4; k++) spawnKillFx(P.clone().add(new THREE.Vector3((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 10)), { vx: 0, vy: -3, vz: -8 });
        if (window.FGAudio && window.FGAudio.boom) window.FGAudio.boom(f.x, f.y, f.z, true);
      }
      if (!f || f.health < 0) { g.visible = false; if (g.userData.dets && g.userData.dets.length && updateDetB17(g, sdt, i, g.userData.trailOn) === 0) restoreB17(g); continue; } // the hull is gone (crashed) but its pieces keep falling to their own impacts
      if (g.userData.dets && g.userData.dets.length && !f.spiraling) restoreB17(g);
      g.visible = true;
      g.position.set(f.x, f.y, f.z);
      if (g.userData.bay) g.userData.bay.set(f.bayOpen || 0);
      const yaw = f.yaw || 0;
      const pitch = f.spiraling ? -0.35 - Math.min(0.5, (f.spiralT || 0) * 0.08) : 0;
      g.rotation.set(0, 0, 0);
      g.rotation.order = "YXZ";
      g.rotation.y = yaw;
      g.rotation.x = -pitch;
      g.rotation.z = -(f.bank || 0);
      { // 1.4.1: each ship's own small yaw/pitch shimmer (the slot bob + roll come from game.js) + distance haze
        const W = g.userData.wob, tt = (window.__FG_SIMT || 0);
        if (W && !f.spiraling) { g.rotation.x += Math.sin(tt * W.fp * 6.283 + W.ph) * 0.009; g.rotation.y += Math.sin(tt * W.fy * 4.1 + W.ph * 1.7) * 0.007; }
        if (g.userData.hazeMats) b17Haze(g, g.position.distanceTo(camera.position));
      }
      const engs = g.userData.engines;
      g.updateMatrixWorld(true);
      if (f.spiraling) {
        if (!(g.userData.dets && g.userData.dets.length)) {
          if (f.deathKind === "wing" || f.deathKind === "tail" || f.deathKind === "break") detachB17(g, f);
          else if (f.deathKind === "fire" && f.shedAt != null && (f.spiralT || 0) >= f.shedAt) { detachPiece(g, f, "tail", 0); f.shed = true; }
        }
        updateDetB17(g, sdt, i, g.userData.trailOn);
      }
      for (let k = 0; k < 4; k++) {
        const eng = engs[k];
        const st = f.engines && f.engines[k];
        const fire = st ? st.fire : 0;
        const burning = fire > 0.3 || (f.spiraling && k % 2 === 0);
        eng.fire.visible = burning;
        if (burning) {
          const s = (0.9 + fire * 1.3) * (0.85 + Math.random() * 0.3);
          eng.fire.scale.set(s, s, 1);
        }
        const dead = (st && st.out) || (f.spiraling && k % 2 === 0);
        eng.disc.visible = !dead;
        eng.blades.visible = !!dead;
        if (g.userData.contrails) g.userData.contrails[k].on = !dead && !f.spiraling;
        if (!dead) eng.disc.rotation.z += dt * 31;
        if (burning && (!f.spiraling || g.userData.trailOn)) { eng.anchor.getWorldPosition(_v); engineFireFx(_v, Math.min(1, fire + (f.spiraling ? 0.4 : 0)), dt, eng.fx || (eng.fx = { t: 0 })); } // 1.5.4 flame tongue + fragments
        const smoking = (fire > 0.12 || (st && st.out) || f.spiraling) && (!f.spiraling || g.userData.trailOn);
        if (smoking) {
          eng.lastEmit -= dt;
          if (eng.lastEmit <= 0) { // 1.4.0: a continuous trail (ribbon) instead of spaced puffs
            eng.anchor.getWorldPosition(_v);
            const dark = burning || f.spiraling;
            { const wsx = f.spiraling ? Math.min(8, 1 + g.position.distanceTo(camera.position) / 800) : 1; ribbonEmit("b" + i + "_" + k + "_" + (f.id != null ? f.id : ""), _v, { w0: (dark ? 1.0 : 0.6) * wsx, w1: (dark ? (f.spiraling ? 12 : 8) : 3.2) * wsx, life: dark ? (burning ? 4.6 : 3.2) * (f.spiraling ? 1.5 : 1) : 2.4, a: dark ? 0.62 : 0.3, col: dark ? [0.13, 0.125, 0.12] : [0.4, 0.4, 0.39], drift: 55 }); }
            if (f.spiraling && Math.random() < 0.3) emitSmoke(_v, true, true);
            eng.lastEmit = 0.05;
          }
        }
      }
    }
    updateSmoke(dt); updateFlames(dt); updateWreckPuffs(dt); if (!window.__FG_FREEZE) updateBombs(dt); // 1.6.1: under freeze, game.js testBombAdvance owns the sim-clock step
    updateRibbons(dt);
    updateContrails();
  }

  let turretScene = null;
  let ready = false;
  let modelsReady = false;
  let muzzleLights = [];

  const loader = new GLTFLoader();

  // ===== 1.3.2: twin-gun recoil groups, barrel-tip muzzle flashes, muzzle positions =====
  const gunGroups = []; // [{ group, rest: Vector3, tipLocal: Vector3 (group space), flash, light }]
  const flashTex = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const x = c.getContext("2d");
    x.translate(64, 64);
    x.globalCompositeOperation = "lighter";
    // spikes
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + (i % 2) * 0.2;
      const len = i % 2 ? 40 : 60;
      x.save(); x.rotate(a);
      const g = x.createLinearGradient(0, 0, len, 0);
      g.addColorStop(0, "rgba(255,240,200,0.95)");
      g.addColorStop(0.5, "rgba(255,170,60,0.55)");
      g.addColorStop(1, "rgba(255,90,10,0)");
      x.fillStyle = g;
      x.beginPath(); x.moveTo(0, -6); x.lineTo(len, 0); x.lineTo(0, 6); x.closePath(); x.fill();
      x.restore();
    }
    const core = x.createRadialGradient(0, 0, 0, 0, 0, 30);
    core.addColorStop(0, "rgba(255,255,240,1)");
    core.addColorStop(0.35, "rgba(255,210,120,0.85)");
    core.addColorStop(1, "rgba(255,110,20,0)");
    x.fillStyle = core;
    x.beginPath(); x.arc(0, 0, 30, 0, Math.PI * 2); x.fill();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  // 1.3.9 worn gunmetal: object-space value noise breaks up roughness (oily smears vs dry, rubbed metal)
  // and the base colour (bluing worn through to grey steel on edges/high spots); barrels + jackets darken
  // toward heat-blued steel and finally glow dull red at the muzzle end under sustained fire.
  const gunHeat = { value: 0 };
  function gunWear(mat, heatK) {
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uHeat = gunHeat; sh.uniforms.uHeatK = { value: heatK };
      sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vOP;").replace("#include <begin_vertex>", "#include <begin_vertex>\nvOP = position;");
      sh.fragmentShader = sh.fragmentShader.replace("#include <common>", `#include <common>
varying vec3 vOP; uniform float uHeat; uniform float uHeatK;
float gwH(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float gwN(vec3 p){ vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(gwH(i), gwH(i + vec3(1,0,0)), f.x), mix(gwH(i + vec3(0,1,0)), gwH(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(gwH(i + vec3(0,0,1)), gwH(i + vec3(1,0,1)), f.x), mix(gwH(i + vec3(0,1,1)), gwH(i + vec3(1,1,1)), f.x), f.y), f.z); }`)
        .replace("#include <map_fragment>", `#include <map_fragment>
float gwA = gwN(vOP * 38.0) * 0.6 + gwN(vOP * 140.0) * 0.4;
float gwB = gwN(vOP * 9.0 + 3.1);
diffuseColor.rgb *= 0.78 + 0.42 * gwA;
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.30, 0.31, 0.32), smoothstep(0.78, 0.95, gwA) * 0.35);
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.55, 0.52, 0.62), uHeat * uHeatK * 0.8);`)
        .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor * (0.55 + 0.9 * gwB) + 0.08 * gwA, 0.08, 1.0);`)
        .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
totalEmissiveRadiance += vec3(0.35, 0.08, 0.02) * smoothstep(0.92, 1.0, uHeat) * uHeatK * smoothstep(0.55, 0.95, gwN(vOP * 3.0)) * 0.18;`);
    };
    mat.customProgramCacheKey = () => "gunwear" + heatK;
  }
  // 3D brass + links: each shot kicks a case out of the bottom of the receiver and a link out beside it
  const EJ_N = 0, ejPool = []; // 1.5.9: 3D ejected cases + links REMOVED (EJ_N 56 -> 0, ejectFrom is a no-op): in the aft / side views they stream from the receivers at the bottom centre and read as a trail of brown/orange and dark SQUARES
  const caseGeo = new THREE.CylinderGeometry(0.0105, 0.0105, 0.099, 10);
  const linkGeo = new THREE.BoxGeometry(0.03, 0.006, 0.022);
  const caseMat = new THREE.MeshPhysicalMaterial({ color: 0xb8964c, metalness: 0.9, roughness: 0.3, clearcoat: 0.3, envMapIntensity: 0.8, emissive: 0x1a1206, emissiveIntensity: 0.15 });
  const linkMat = new THREE.MeshStandardMaterial({ color: 0x2a2d31, metalness: 0.85, roughness: 0.4, emissive: 0x0a0c0e, emissiveIntensity: 0.2 });
  for (let i = 0; i < EJ_N; i++) { const m = new THREE.Mesh(i % 2 ? linkGeo : caseGeo, i % 2 ? linkMat : caseMat); m.visible = false; m.frustumCulled = false; scene.add(m); ejPool.push({ m, life: 0, v: new THREE.Vector3(), w: new THREE.Vector3() }); }
  let ejIdx = 0;
  const _ejQ = new THREE.Quaternion(), _ejV = new THREE.Vector3();
  function ejectFrom(gg, sgn) {
    if (EJ_N === 0) return;
    for (let k = 0; k < 2; k++) {
      // even slots = cases, odd = links
      let p = ejPool[ejIdx];
      if ((ejIdx % 2 === 0) !== (k === 0)) { ejIdx = (ejIdx + 1) % EJ_N; p = ejPool[ejIdx]; }
      ejIdx = (ejIdx + 1) % EJ_N;
      _ejV.copy(gg.ejectLocal); gg.group.localToWorld(_ejV);
      p.m.position.copy(_ejV);
      camera.getWorldQuaternion(_ejQ);
      const isLink = p.m.geometry === linkGeo;
      p.v.set(sgn * (isLink ? 1.1 + Math.random() * 0.7 : 0.2 + Math.random() * 0.3), -(1.6 + Math.random() * 0.9), -(0.4 + Math.random() * 0.5)).applyQuaternion(_ejQ);
      p.w.set((Math.random() - 0.5) * 50, (Math.random() - 0.5) * 50, (Math.random() - 0.5) * 50);
      p.m.quaternion.copy(_ejQ);
      p.life = 0.9;
      p.m.visible = true;
    }
  }
  let _ejT = 0;
  function updateEject() {
    const now = window.__FG_SIMT || 0, dt = Math.min(0.05, Math.max(0, now - _ejT)); _ejT = now;
    if (dt <= 0) return;
    for (const p of ejPool) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.m.visible = false; continue; }
      p.v.y -= 9.0 * dt;       // falls
      p.v.z -= 22 * dt;        // and the slipstream tears it aft
      p.m.position.addScaledVector(p.v, dt);
      p.m.rotation.x += p.w.x * dt; p.m.rotation.y += p.w.y * dt; p.m.rotation.z += p.w.z * dt;
    }
  }
  // heat shimmer: a refracting (transmission) sheet above each hot barrel with a scrolling noise normal map
  const shimmerTex = (() => {
    const N = 128, c = document.createElement("canvas"); c.width = N; c.height = N; const x = c.getContext("2d"), im = x.createImageData(N, N);
    const h = (i, j) => { const v = Math.sin(i * 0.19 + Math.sin(j * 0.13) * 2.1) + Math.sin(j * 0.31 + Math.sin(i * 0.07) * 3.0) * 0.8 + Math.sin((i + j) * 0.11) * 0.6; return v; };
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const dx = h(i + 1, j) - h(i - 1, j), dy = h(i, j + 1) - h(i, j - 1), o = (j * N + i) * 4; im.data[o] = 128 + dx * 60; im.data[o + 1] = 128 + dy * 60; im.data[o + 2] = 255; im.data[o + 3] = 255; }
    x.putImageData(im, 0, 0); const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  })();
  const shimmers = [];
  // heat haze: faint wavy rising streaks (additive, very low alpha) over the jackets
  const hazeTex = (() => {
    const W = 64, H = 256, c = document.createElement("canvas"); c.width = W; c.height = H; const x = c.getContext("2d");
    x.clearRect(0, 0, W, H); x.lineWidth = 1.2;
    for (let k = 0; k < 14; k++) { const x0 = 4 + Math.random() * (W - 8), ph = Math.random() * 6, a = 0.25 + Math.random() * 0.4; x.strokeStyle = `rgba(255,255,255,${a})`; x.beginPath(); for (let y = 0; y <= H; y += 4) { const xx = x0 + Math.sin(y * 0.07 + ph) * 3 + Math.sin(y * 0.19 + ph * 2) * 1.5; y ? x.lineTo(xx, y) : x.moveTo(xx, y); } x.stroke(); }
    const g = x.createLinearGradient(0, 0, W, 0); g.addColorStop(0, "rgba(0,0,0,1)"); g.addColorStop(0.25, "rgba(0,0,0,0)"); g.addColorStop(0.75, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,1)");
    x.globalCompositeOperation = "destination-out"; x.fillStyle = g; x.fillRect(0, 0, W, H);
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  })();
  // 1.3.9 RING SIGHT on the guns (replaces the floating HUD reticle): a ring-and-bead sight on a post clamped
  // to a bar between the two barrel jackets. The ring's centre is on the sight line (camera axis), i.e. exactly
  // where the rounds cross at 320 u. Outer ring ≈2.5° radius (a 109's span at ~140 u), a finer inner ring at
  // ≈1.0°, four short spokes; the centre stays clear. A pale inner hairline keeps it legible on dark ground.
  const SIGHT_Z = -0.9, SIGHT_R = 0.9 * Math.tan(2.8 * Math.PI / 180);
  const sightGroup = new THREE.Group();
  {
    const steel = new THREE.MeshBasicMaterial({ color: 0x131517 }); // unlit: a crisp dark silhouette, never tinted by the muzzle flash
    const pale = new THREE.MeshBasicMaterial({ color: 0xe6dcb4, transparent: true, opacity: 0.55, depthWrite: false });
    const add = (geo, mat, x, y, z, rx, ry, rz) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx || 0, ry || 0, rz || 0); m.renderOrder = 6; sightGroup.add(m); return m; };
    add(new THREE.TorusGeometry(SIGHT_R, 0.0028, 8, 128), steel, 0, 0, 0);
    add(new THREE.TorusGeometry(SIGHT_R - 0.0032, 0.0007, 6, 128), pale, 0, 0, 0.0005);
    const r2 = 0.9 * Math.tan(1.05 * Math.PI / 180);
    add(new THREE.TorusGeometry(r2, 0.0014, 6, 96), steel, 0, 0, 0);
    add(new THREE.TorusGeometry(r2 - 0.0017, 0.0005, 6, 96), pale, 0, 0, 0.0005);
    for (let k = 0; k < 4; k++) { // spokes outer → inner ring, leaving the centre open
      const a = k * Math.PI / 2, L = SIGHT_R - r2, rm = (SIGHT_R + r2) / 2;
      add(new THREE.BoxGeometry(0.0022, L, 0.0022), steel, Math.sin(a) * rm, Math.cos(a) * rm, 0, 0, 0, -a);
    }
    // V-bracket: two short struts from the ring (4 and 8 o'clock) down to the muzzle ends of the jackets
    // (where they meet the barrels on screen), so the lower centre stays open and nothing crosses the receivers
    for (const sx of [-1, 1]) {
      const ax = sx * SIGHT_R * Math.sin(Math.PI / 3), ay = -SIGHT_R * Math.cos(Math.PI / 3);
      const bx = sx * 0.9 * Math.tan(3.9 * Math.PI / 180), by = -0.9 * Math.tan(5.6 * Math.PI / 180), L = Math.hypot(bx - ax, by - ay);
      add(new THREE.SphereGeometry(0.0045, 8, 6), steel, bx, by, 0.004); // clamp
      add(new THREE.BoxGeometry(0.0035, L, 0.0035), steel, (ax + bx) / 2, (ay + by) / 2, 0.004, 0, 0, Math.atan2(-(bx - ax), by - ay));
    }
    add(new THREE.SphereGeometry(0.0022, 8, 6), steel, 0, -SIGHT_R + 0.0005, 0); // bead at 6 o'clock on the ring
  }
  sightGroup.position.set(0, 0.02, SIGHT_Z + 0.05); // cancels the anchor's rest offset (y −0.02, z −0.05) → ring centre on the camera axis
  // 1.4.0: the iron ring sight is removed (floating 2D reflector reticle in game.js instead); sightGroup kept unattached
  function setupGunGroups() {
    if (!turretScene) return;
    scene.updateMatrixWorld(true);
    const meshes = [];
    turretScene.traverse((o) => { if (o.isMesh && o.visible) meshes.push(o); });
    const L = new THREE.Group(), R = new THREE.Group();
    turretScene.add(L); turretScene.add(R);
    scene.updateMatrixWorld(true);
    const bx = new THREE.Box3(), ctr = new THREE.Vector3();
    for (const o of meshes) {
      bx.setFromObject(o); bx.getCenter(ctr);
      turretAnchor.worldToLocal(ctr);
      (ctr.x < 0 ? L : R).attach(o);
    }
    scene.updateMatrixWorld(true);
    // 1.3.9: the two ammo belts are ~100 small meshes — merge them per gun and per material (link / case /
    // bullet) into 3 static meshes each, so the full belts cost 6 draw calls on a phone instead of ~108
    for (const grp of [L, R]) {
      const buckets = {};
      grp.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(grp.matrixWorld).invert();
      grp.traverse((o) => { if (o.isMesh && /^link/i.test(o.name || "") && o.geometry && o.geometry.attributes.normal) { const k = /case/i.test(o.name) ? "case" : /bullet/i.test(o.name) ? "bullet" : "link"; (buckets[k] = buckets[k] || []).push(o); } });
      for (const k in buckets) {
        const list = buckets[k]; const pos = [], nor = [];
        const m4 = new THREE.Matrix4(), n3 = new THREE.Matrix3();
        for (const o of list) {
          const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
          m4.multiplyMatrices(inv, o.matrixWorld); n3.getNormalMatrix(m4);
          const pa = g.attributes.position, na = g.attributes.normal, vv = new THREE.Vector3();
          for (let i = 0; i < pa.count; i++) { vv.fromBufferAttribute(pa, i).applyMatrix4(m4); pos.push(vv.x, vv.y, vv.z); vv.fromBufferAttribute(na, i).applyMatrix3(n3).normalize(); nor.push(vv.x, vv.y, vv.z); }
        }
        const mg = new THREE.BufferGeometry();
        mg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); mg.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
        const mat = Array.isArray(list[0].material) ? list[0].material[0] : list[0].material;
        const mm = new THREE.Mesh(mg, mat); mm.name = "Belt_" + k;
        grp.add(mm);
        for (const o of list) { o.visible = false; if (o.parent) o.parent.remove(o); }
      }
    }
    scene.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    for (const grp of [L, R]) {
      // Barrel tip = the most-forward vertices (camera looks down -Z in anchor space)
      let minZ = 1e9;
      const pts = [];
      grp.traverse((o) => {
        if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
        const pa = o.geometry.attributes.position;
        const step = Math.max(1, Math.floor(pa.count / 4000));
        for (let i = 0; i < pa.count; i += step) {
          v.fromBufferAttribute(pa, i);
          o.localToWorld(v);
          turretAnchor.worldToLocal(v);
          pts.push(v.x, v.y, v.z);
          if (v.z < minZ) minZ = v.z;
        }
      });
      let sx = 0, sy = 0, n = 0;
      for (let i = 0; i < pts.length; i += 3) {
        if (pts[i + 2] < minZ + 0.03) { sx += pts[i]; sy += pts[i + 1]; n++; }
      }
      const tipA = new THREE.Vector3(n ? sx / n : (grp === L ? -0.3 : 0.3), n ? sy / n : -0.5, minZ < 1e8 ? minZ - 0.02 : -1.6);
      const tipW = turretAnchor.localToWorld(tipA.clone());
      const tipLocal = grp.worldToLocal(tipW.clone());
      const flash = new THREE.Sprite(new THREE.SpriteMaterial({
        map: flashTex, transparent: true, depthWrite: false, depthTest: false,
        blending: THREE.AdditiveBlending, opacity: 1,
      }));
      flash.renderOrder = 999;
      flash.position.copy(tipLocal);
      flash.visible = false;
      grp.add(flash);
      const light = new THREE.PointLight(0xff9a40, 0, 3.5, 2);
      light.position.copy(tipLocal);
      grp.add(light);
      muzzleLights.push(light);
      // eject port = under the receiver's rear half (group space)
      const rb = new THREE.Box3(); grp.traverse((o) => { if (o.isMesh && /receiver/i.test(o.name || "")) rb.expandByObject(o); });
      if (rb.isEmpty()) grp.traverse((o) => { if (o.isMesh) rb.expandByObject(o); });
      const ec = new THREE.Vector3(); rb.getCenter(ec); ec.y = rb.min.y; ec.z = (ec.z + rb.max.z) * 0.5;
      const ejectLocal = grp.worldToLocal(ec.clone());
      // shimmer sheet along the jacket, just above it, facing the eye
      const tb = new THREE.Box3(); grp.traverse((o) => { if (o.isMesh && /jacket/i.test(o.name || "")) tb.expandByObject(o); });
      let shim = null;
      if (!tb.isEmpty()) {
        const sz = new THREE.Vector3(); tb.getSize(sz); const cc = new THREE.Vector3(); tb.getCenter(cc);
        const mat = new THREE.MeshBasicMaterial({ map: hazeTex, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, color: 0xfff4e0 });
        shim = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(0.06, sz.x * 2.2), Math.max(0.3, sz.z)), mat);
        shim.rotation.x = -Math.PI / 2 + 0.25;
        const wc = cc.clone(); wc.y = tb.max.y + 0.035;
        shim.position.copy(grp.worldToLocal(wc));
        shim.visible = false; shim.renderOrder = 5;
        grp.add(shim); shimmers.push(shim);
      }
      gunGroups.push({ group: grp, rest: grp.position.clone(), tipLocal, flash, light, ejectLocal, shim, lastRec: 0, lastF: 0 });
    }
    // 1.3.7: pull the twin guns in toward the sight line so the view runs straight down them
    for (const gg of gunGroups) { const sgn = gg.tipLocal.x + gg.group.position.x < 0 ? 1 : -1; gg.group.position.x += sgn * GUN_INSET; gg.rest.copy(gg.group.position); }
  }
  // ===== 1.4.0: TURRET OVERLAY PASS =====
  // Guns, sight box, sill/ring and dome frame live on layer OVL and are drawn in a second pass after a depth clear,
  // so they always render on top of our own airframe (no more guns sinking into the fuselage when looking down),
  // while pitch stays unlimited (straight down, and you can still shoot your own ship).
  function toOverlay(root) { root.traverse((o) => { o.layers.set(OVL); }); }
  for (const L of [hemi, sun, fill, turretFill, muzzleStrobe, turretKey, gunSpec, viewRim, viewRim2]) L.layers.enable(OVL);
  for (const e of ejPool) e.m.layers.set(OVL);
  // enclosed flexible feed chutes (ribbed, dull) from each gun's feed side, curving down and out of view
  function addFlexChutes() {
    const c = document.createElement("canvas"); c.width = 64; c.height = 256; const x = c.getContext("2d");
    x.fillStyle = "#3a3f36"; x.fillRect(0, 0, 64, 256);
    for (let yy = 0; yy < 256; yy += 8) { x.fillStyle = "rgba(0,0,0,0.45)"; x.fillRect(0, yy, 64, 2); x.fillStyle = "rgba(255,255,255,0.08)"; x.fillRect(0, yy + 2, 64, 1); }
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(1, 6);
    const mat = new THREE.MeshStandardMaterial({ color: 0x9a9f94, map: tex, metalness: 0.25, roughness: 0.85, envMapIntensity: 0.2 });
    for (const gg of gunGroups) {
      const b = new THREE.Box3(); gg.group.traverse((o) => { if (o.isMesh && /feedchute/i.test(o.name || "")) b.expandByObject(o); });
      if (b.isEmpty()) continue;
      const ctr = new THREE.Vector3(); b.getCenter(ctr); gg.group.worldToLocal(ctr);
      const sg = ctr.x < 0 ? -1 : 1; // outboard side (group space ≈ anchor space, unrotated)
      const pts = [ctr.clone(), ctr.clone().add(new THREE.Vector3(sg * 0.08, -0.06, 0.05)), ctr.clone().add(new THREE.Vector3(sg * 0.14, -0.26, 0.2)), ctr.clone().add(new THREE.Vector3(sg * 0.12, -0.6, 0.35))];
      const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.045, 10, false), mat);
      tube.name = "FlexChute"; gg.group.add(tube);
    }
  }
  // Turret structure fixed to the turret (yaw only): sill + ring, heavy right frame, thin left strut, angled brace,
  // overhead arch. It pitches opposite to the view (stays level with the ship) for look-up and a little look-down;
  // past ~8° down it slides away downward so unlimited look-down stays clear.
  const cage = new THREE.Group();
  camera.add(cage);
  const cageTex = (() => { // unrolled sill band: painted green frame, top rail with bolts, placards, brass plate
    const W = 1024, H = 300, c = document.createElement("canvas"); c.width = W; c.height = H; const x = c.getContext("2d");
    let sd = 11; const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
    x.fillStyle = "#1f3a31"; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 1800; i++) { const v = rnd(); x.fillStyle = v < 0.5 ? "rgba(0,0,0,0.10)" : "rgba(160,200,180,0.06)"; x.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 5, 1 + rnd() * 2); }
    // top rail (lighter, worn edge) + shadow line under it
    const rg = x.createLinearGradient(0, 0, 0, 30); rg.addColorStop(0, "#5d7a6c"); rg.addColorStop(0.35, "#2e4d41"); rg.addColorStop(1, "#1a3129");
    x.fillStyle = rg; x.fillRect(0, 0, W, 30);
    x.fillStyle = "rgba(0,0,0,0.55)"; x.fillRect(0, 30, W, 4);
    for (let i = 0; i < 60; i++) { x.fillStyle = "rgba(190,200,190,0.35)"; x.fillRect(rnd() * W, rnd() * 6, 4 + rnd() * 20, 1); } // edge wear
    const bolt = (bx, by, r) => { const g = x.createRadialGradient(bx - r * 0.3, by - r * 0.3, 0, bx, by, r); g.addColorStop(0, "#c9cfc6"); g.addColorStop(0.5, "#6f7a72"); g.addColorStop(1, "#1a2420"); x.fillStyle = g; x.beginPath(); x.arc(bx, by, r, 0, Math.PI * 2); x.fill(); };
    for (let bx = 18; bx < W; bx += 44) bolt(bx, 16, 5);
    // panel seams
    x.strokeStyle = "rgba(0,0,0,0.5)"; x.lineWidth = 2;
    for (const sx of [150, 360, 664, 874]) { x.beginPath(); x.moveTo(sx, 34); x.lineTo(sx, H); x.stroke(); for (let by = 52; by < H; by += 40) bolt(sx + 8, by, 3.5); }
    // placards (white data cards with typed lines), a round brass plate, a yellow/black warning sticker
    const card = (px, py, w, h, rot) => {
      x.save(); x.translate(px, py); x.rotate(rot || 0);
      x.fillStyle = "rgba(0,0,0,0.35)"; x.fillRect(3, 3, w, h);
      x.fillStyle = "#e9e7de"; x.fillRect(0, 0, w, h);
      x.fillStyle = "#b8b4a6"; x.fillRect(0, 0, w, 7);
      x.fillStyle = "rgba(40,40,60,0.75)";
      for (let ly = 13; ly < h - 4; ly += 6) { let lx = 5; while (lx < w - 10) { const lw = 6 + rnd() * 22; x.fillRect(lx, ly, Math.min(lw, w - 6 - lx), 1.6); lx += lw + 4; } }
      x.strokeStyle = "rgba(90,90,100,0.6)"; x.lineWidth = 1; x.strokeRect(0.5, 0.5, w - 1, h - 1);
      x.restore();
    };
    card(560, 40, 150, 58, -0.01); card(716, 38, 118, 64, 0.012); card(250, 42, 120, 54, 0.02); card(880, 46, 92, 50, 0); card(60, 44, 100, 52, -0.015);
    { const bx = 470, by = 66, r = 24; const g = x.createRadialGradient(bx - 8, by - 8, 2, bx, by, r); g.addColorStop(0, "#f0d58a"); g.addColorStop(0.55, "#b08a3a"); g.addColorStop(1, "#5a4418"); x.fillStyle = g; x.beginPath(); x.arc(bx, by, r, 0, Math.PI * 2); x.fill();
      x.strokeStyle = "rgba(60,40,10,0.8)"; x.lineWidth = 1.5; x.beginPath(); x.arc(bx, by, r - 5, 0, Math.PI * 2); x.stroke();
      x.fillStyle = "rgba(70,50,15,0.7)"; for (let k = 0; k < 3; k++) x.fillRect(bx - 12, by - 6 + k * 6, 24, 1.5); }
    x.save(); x.translate(600, 112); x.rotate(-0.03); x.fillStyle = "#e3c32a"; x.fillRect(0, 0, 120, 34);
    x.fillStyle = "#111"; x.font = "bold 13px sans-serif"; x.fillText("WATCH YOUR", 8, 14); x.fillText("HEAD!", 30, 29); x.restore();
    // scuffs lower down
    for (let i = 0; i < 40; i++) { x.strokeStyle = "rgba(170,190,175,0.12)"; x.lineWidth = 1; const sx = rnd() * W, sy = 120 + rnd() * 170; x.beginPath(); x.moveTo(sx, sy); x.lineTo(sx + (rnd() - 0.5) * 60, sy + (rnd() - 0.5) * 8); x.stroke(); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    t.wrapS = THREE.RepeatWrapping; t.repeat.x = -1; t.offset.x = 1; // seen from inside
    return t;
  })();
  const CAGE_R = 0.62, SILL_Y = -0.165, SILL_H = 0.32; // sill top ≈ 13.6° below the eye (bottom ~18 % of a landscape phone)
  const paint = new THREE.MeshStandardMaterial({ color: 0x2a4a3e, roughness: 0.6, metalness: 0.25, envMapIntensity: 0.4 });
  const paintDark = new THREE.MeshStandardMaterial({ color: 0x1c2f28, roughness: 0.65, metalness: 0.25, envMapIntensity: 0.35 });
  const boltMat = new THREE.MeshStandardMaterial({ color: 0x9aa39c, roughness: 0.35, metalness: 0.85, envMapIntensity: 0.6 });
  {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(CAGE_R, CAGE_R + 0.02, SILL_H, 64, 1, true, Math.PI - 1.45, 2.9),
      new THREE.MeshStandardMaterial({ map: cageTex, roughness: 0.62, metalness: 0.2, envMapIntensity: 0.35, side: THREE.BackSide }));
    band.position.y = SILL_Y - SILL_H / 2; cage.add(band);
    const lip = new THREE.Mesh(new THREE.TorusGeometry(CAGE_R - 0.005, 0.017, 8, 72, Math.PI * 0.92), paint);
    lip.rotation.set(-Math.PI / 2, 0, Math.PI * 0.04); lip.position.y = SILL_Y; cage.add(lip);
    const shelf = new THREE.Mesh(new THREE.RingGeometry(CAGE_R - 0.075, CAGE_R, 72, 1, Math.PI * 0.04, Math.PI * 0.92), paintDark);
    shelf.rotation.x = -Math.PI / 2; shelf.position.y = SILL_Y - 0.004; cage.add(shelf);
    // bolt heads along the lip's top
    const bg = new THREE.CylinderGeometry(0.0055, 0.0055, 0.006, 8);
    for (let k = 0; k < 34; k++) { const a = Math.PI * (0.06 + 0.88 * k / 33); const b = new THREE.Mesh(bg, boltMat); b.position.set(Math.cos(a) * (CAGE_R - 0.04), SILL_Y + 0.004, -Math.sin(a) * (CAGE_R - 0.04)); cage.add(b); }
  }
  const beam = (p0, p1, w, d, mat, bolts) => { // box beam p0 → p1, w across the view, d deep
    const a = new THREE.Vector3(...p0), b = new THREE.Vector3(...p1), L = a.distanceTo(b);
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, L, d), mat);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    // face the eye: spin about the beam axis so the wide face looks at the origin
    const mid = m.position.clone(), ax = b.clone().sub(a).normalize();
    const toEye = mid.clone().negate(); toEye.addScaledVector(ax, -toEye.dot(ax)).normalize();
    const cur = new THREE.Vector3(0, 0, 1).applyQuaternion(m.quaternion); cur.addScaledVector(ax, -cur.dot(ax)).normalize();
    const ang = Math.atan2(new THREE.Vector3().crossVectors(cur, toEye).dot(ax), cur.dot(toEye));
    m.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(ax, ang));
    cage.add(m);
    if (bolts) { const bg = new THREE.SphereGeometry(0.0052, 8, 6); for (let k = 1; k <= bolts; k++) { const t = k / (bolts + 1); const bb = new THREE.Mesh(bg, boltMat); bb.position.copy(a).lerp(b, t).addScaledVector(toEye, d * 0.5 + 0.002); bb.scale.set(1, 1, 0.6); cage.add(bb); } }
    return m;
  };
  // heavy frame, right side (dark-green, bolted) — leans out as it climbs
  beam([0.375, SILL_Y, -0.5], [0.56, 0.62, -0.33], 0.058, 0.04, paint, 7);
  // thin vertical strut, left
  beam([-0.385, SILL_Y, -0.505], [-0.47, 0.78, -0.4], 0.022, 0.02, paintDark, 0);
  // angled brace low on the left (bolted)
  beam([-0.31, SILL_Y, -0.55], [-0.405, SILL_Y + 0.15, -0.495], 0.02, 0.018, paint, 2);
  // overhead arch (only seen when looking well up)
  const arch = new THREE.Mesh(new THREE.TorusGeometry(CAGE_R, 0.012, 8, 64, Math.PI), paint);
  { arch.position.set(0, SILL_Y, -0.22); arch.scale.set(1, 1.05, 1); cage.add(arch);
  }
  toOverlay(cage);
  const cageE = new THREE.Euler();
  function updateCage(pitch, hidden) {
    // past ~22° of look-down the ring has slid fully out of view: hide it so the airframe below reads cleanly
    // 1.4.1: the turret structure never disappears. Level with the ship for look-up; looking down, the sill, frame and brace ride with the view (the gunner's head goes down with the
    // guns), keeping the same framing at every pitch down to straight down — the centre stays clear.
    cage.visible = !hidden;
    arch.visible = pitch > -0.12; // only ever seen overhead
    const p = Math.max(pitch, 0);
    cage.rotation.set(-p, 0, 0);
    cage.position.y = 0;
  }
  // sight / ammo box on the gun mount (moves with the guns), low and right of centre so the middle stays clear
  // 1.4.1: a real piece of kit, not a black slab — a smaller olive-drab ammunition box (as on the Sperry mount)
  // with pressed ribs, a hinged lid with a latch, a stencilled data plate, a feed-chute throat and a worn edge.
  const sightBox = new THREE.Group();
  {
    const stencil = (() => {
      const c = document.createElement("canvas"); c.width = 256; c.height = 128; const x = c.getContext("2d");
      x.fillStyle = "#4a5236"; x.fillRect(0, 0, 256, 128);
      let sd = 5; const r = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
      for (let i = 0; i < 900; i++) { x.fillStyle = r() < 0.5 ? "rgba(0,0,0,0.12)" : "rgba(210,215,190,0.07)"; x.fillRect(r() * 256, r() * 128, 1 + r() * 4, 1 + r() * 2); }
      x.strokeStyle = "rgba(0,0,0,0.35)"; x.lineWidth = 3; for (const yy of [30, 98]) { x.beginPath(); x.moveTo(0, yy); x.lineTo(256, yy); x.stroke(); }
      x.fillStyle = "rgba(225,220,190,0.8)"; x.font = "bold 20px monospace"; x.fillText("CAL .50", 64, 58); x.font = "bold 13px monospace"; x.fillText("M2 LINKED  400 RDS", 44, 80);
      x.fillStyle = "#c9c3a6"; x.fillRect(8, 40, 40, 44); x.fillStyle = "rgba(40,40,50,0.7)"; for (let yy = 48; yy < 80; yy += 6) x.fillRect(12, yy, 32, 1.5); // data plate
      for (let i = 0; i < 60; i++) { x.fillStyle = "rgba(180,185,170,0.45)"; x.fillRect(r() * 256, r() < 0.5 ? r() * 4 : 124 + r() * 4, 3 + r() * 14, 1); } // worn edges
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
    })();
    const odBox = new THREE.MeshStandardMaterial({ color: 0x9aa088, map: stencil, roughness: 0.62, metalness: 0.28, envMapIntensity: 0.35 });
    const odPlain = new THREE.MeshStandardMaterial({ color: 0x454c33, roughness: 0.6, metalness: 0.3, envMapIntensity: 0.35 });
    const steelD = new THREE.MeshStandardMaterial({ color: 0x2c2e2c, roughness: 0.45, metalness: 0.8, envMapIntensity: 0.5 });
    const W = 0.13, Hh = 0.062, D = 0.1;
    const body = new THREE.Mesh(new THREE.BoxGeometry(W, Hh, D), [odPlain, odPlain, odPlain, odPlain, odBox, odPlain]); sightBox.add(body);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(W + 0.006, 0.008, D + 0.006), odPlain); lid.position.y = Hh / 2 + 0.004; sightBox.add(lid);
    for (const k of [-1, 0, 1]) { const rib = new THREE.Mesh(new THREE.BoxGeometry(0.005, Hh * 0.8, 0.004), odPlain); rib.position.set(k * 0.042, 0, D / 2 + 0.002); sightBox.add(rib); }
    const latch = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.02, 0.006), steelD); latch.position.set(0.0, Hh / 2 - 0.004, D / 2 + 0.005); sightBox.add(latch);
    const hinge = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, W * 0.9, 8), steelD); hinge.rotation.z = Math.PI / 2; hinge.position.set(0, Hh / 2 + 0.004, -D / 2 - 0.002); sightBox.add(hinge);
    const throat = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.022, 0.03), steelD); throat.position.set(-W / 2 + 0.03, Hh / 2 + 0.018, -0.01); throat.rotation.z = 0.25; sightBox.add(throat);
    const bg = new THREE.SphereGeometry(0.0035, 6, 5);
    for (const [bx, by] of [[-0.058, 0.024], [0.058, 0.024], [-0.058, -0.024], [0.058, -0.024]]) { const q = new THREE.Mesh(bg, boltMat); q.position.set(bx, by, D / 2 + 0.002); sightBox.add(q); }
    sightBox.position.set(0.29, -0.228, -0.5); sightBox.rotation.set(0.2, -0.42, 0.02);
    camera.add(sightBox); toOverlay(sightBox);
  }
  // 1.6.1 Cheyenne twin .50s (camera-locked): perforated jackets + red tips, track aim; muzzleOut/flash/tracers from tips.
  const tailFrame = new THREE.Group(); // kept name for visibility toggle
  camera.add(tailFrame); tailFrame.visible = false;
  const tailGuns = [];
  {
    const steel = new THREE.MeshStandardMaterial({ color: 0x1a1c18, roughness: 0.45, metalness: 0.7 });
    const red = new THREE.MeshStandardMaterial({ color: 0xc4281e, roughness: 0.4, metalness: 0.35, emissive: 0x4a0808, emissiveIntensity: 0.25 });
    const flashTex = (() => {
      const c = document.createElement("canvas"); c.width = 64; c.height = 64; const x = c.getContext("2d");
      const g = x.createRadialGradient(32, 32, 0, 32, 32, 30); g.addColorStop(0, "rgba(255,240,180,1)"); g.addColorStop(0.35, "rgba(255,140,40,0.7)"); g.addColorStop(1, "rgba(255,80,0,0)");
      x.fillStyle = g; x.fillRect(0, 0, 64, 64);
      return new THREE.CanvasTexture(c);
    })();
    for (const side of [-1, 1]) {
      const g = new THREE.Group();
      // jacket (perforated look via dark rings)
      const jacket = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.024, 0.55, 10), steel);
      jacket.rotation.x = Math.PI / 2; jacket.position.set(0, 0, -0.35); g.add(jacket);
      for (let k = 0; k < 8; k++) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.003, 6, 12), new THREE.MeshStandardMaterial({ color: 0x0c0e0a, roughness: 0.8, metalness: 0.4 }));
        ring.position.set(0, 0, -0.12 - k * 0.055); g.add(ring);
      }
      // barrel tip + red jacket end
      const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.018, 0.12, 8), red);
      tip.rotation.x = Math.PI / 2; tip.position.set(0, 0, -0.68); g.add(tip);
      const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0, -0.75); g.add(muzzle);
      const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
      flash.position.set(0, 0, -0.78); flash.scale.set(0.12, 0.12, 1); flash.visible = false; g.add(flash);
      // rest pose: low-center in view, side by side, running aft (cam −Z)
      g.position.set(side * 0.055, -0.16, -0.55);
      g.rotation.set(0.04, 0, 0);
      tailFrame.add(g);
      tailGuns.push({ group: g, muzzle, flash, rest: g.position.clone(), lastRec: 0 });
    }
    // small housing under sill
    const house = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.14), new THREE.MeshStandardMaterial({ color: 0x2a2e22, roughness: 0.7, metalness: 0.25 }));
    house.position.set(0, -0.22, -0.48); tailFrame.add(house);
    toOverlay(tailFrame);
  }

  const _mw = new THREE.Vector3();
  const muzzleOut = [{ x: 0, y: 0, z: 0, sx: 0, sy: 0 }, { x: 0, y: 0, z: 0, sx: 0, sy: 0 }];
  function updateGuns(opts) {
    const rec = opts.recoilLR || [0, 0];
    const fl = opts.flashLR || [0, 0];
    for (let i = 0; i < gunGroups.length; i++) {
      const gg = gunGroups[i];
      // barrel + receiver slide straight back along the bore, then run out
      gg.group.position.set(gg.rest.x, gg.rest.y + rec[i] * 0.004, gg.rest.z + rec[i] * 0.12);
      gg.group.rotation.set(rec[i] * 0.018, 0, (i ? -1 : 1) * rec[i] * 0.006); // 1.3.9: muzzle climb + a little twist on each kick
      if (rec[i] > gg.lastRec + 0.4) { // a round just fired on this gun
        ejectFrom(gg, gg.ejectLocal.x + gg.group.position.x < 0 ? -1 : 1);
        _mw.copy(gg.tipLocal); gg.group.localToWorld(_mw);
        emitSmoke(_mw, false, false, { life: 0.42 + Math.random() * 0.2, s0: 0.05, s1: 0.42 + Math.random() * 0.2, a: 0.22 + 0.2 * (opts.heat || 0), vz: -16, color: 0xc4c0b6 });
      }
      gg.lastRec = rec[i];
      const f = fl[i] || 0;
      gg.flash.visible = f > 0.3;
      if (gg.flash.visible) {
        // 1.3.3: small, brief, see-through (≈12–20 CSS px on a phone)
        const s = (0.13 + Math.random() * 0.05) * (0.6 + 0.4 * f);
        gg.flash.scale.set(s, s, 1);
        gg.flash.material.rotation = Math.random() * Math.PI;
        gg.flash.material.opacity = 0.35 + 0.4 * f;
      }
      gg.light.intensity = f * 1.2;
      if (gg.shim) { // shimmer fades in once the barrels are hot and lingers while they cool
        const h = opts.heat || 0, on = h > 0.3;
        gg.shim.visible = on;
        if (on) { const t = pnow() * 0.001; gg.shim.material.map.offset.set(Math.sin(t * 1.7 + i) * 0.04, -t * 0.6); gg.shim.material.opacity = 0.16 * Math.min(1, (h - 0.3) / 0.5); }
      }
    }
    gunHeat.value += ((opts.heat || 0) - gunHeat.value) * 0.08;
    updateEject();
    camera.updateMatrixWorld(true);
    let strobeI = fl[1] > fl[0] ? 1 : 0;
    const atTail = (opts.station === "tail");
    if (atTail && tailGuns.length) {
      for (let i = 0; i < 2; i++) {
        const tg = tailGuns[i], rec = (opts.recoilLR || [0, 0])[i] || 0, fl = (opts.flashLR || [0, 0])[i] || 0;
        tg.group.position.set(tg.rest.x, tg.rest.y + rec * 0.003, tg.rest.z + rec * 0.04);
        tg.flash.visible = fl > 0.3;
        if (tg.flash.visible) { const s = (0.14 + Math.random() * 0.06) * (0.55 + 0.45 * fl); tg.flash.scale.set(s, s, 1); tg.flash.material.opacity = 0.4 + 0.45 * fl; }
        tg.muzzle.getWorldPosition(_mw);
        muzzleOut[i].x = _mw.x; muzzleOut[i].y = _mw.y; muzzleOut[i].z = _mw.z;
        if (i === strobeI) { muzzleStrobe.position.copy(_mw); camera.worldToLocal(muzzleStrobe.position); muzzleStrobe.position.z += 0.1; }
        _mw.project(camera);
        muzzleOut[i].sx = (_mw.x + 1) * 0.5 * window.innerWidth;
        muzzleOut[i].sy = (1 - _mw.y) * 0.5 * window.innerHeight;
      }
    } else {
      for (let i = 0; i < gunGroups.length && i < 2; i++) {
        const gg = gunGroups[i];
        _mw.copy(gg.tipLocal);
        gg.group.localToWorld(_mw);
        muzzleOut[i].x = _mw.x; muzzleOut[i].y = _mw.y; muzzleOut[i].z = _mw.z;
        if (i === strobeI) { muzzleStrobe.position.copy(_mw); camera.worldToLocal(muzzleStrobe.position); muzzleStrobe.position.z += 0.15; }
        _mw.project(camera);
        muzzleOut[i].sx = (_mw.x + 1) * 0.5 * window.innerWidth;
        muzzleOut[i].sy = (1 - _mw.y) * 0.5 * window.innerHeight;
      }
    }
  }

  // ===== 1.5.2 P-51D Mustang — procedural model (no free GLB with a usable licence/format was available) =====
  // Native units like the 109 GLB (it is drawn at ×1.3): span 5.8, length 5.0. Nose = local −Z, up = +Y, starboard = +X.
  function buildP51Model() {
    const g = new THREE.Group(); g.name = "P51D"; g.userData.procedural = true;
    // 1.5.2 fix: bright natural-metal silver. Low metalness (no env map in the scene → high metalness renders near-black) + a self-lit emissive floor.
    const nmf = (o) => new THREE.MeshStandardMaterial(Object.assign({ color: 0xd8d8d2, metalness: 0.12, roughness: 0.5, emissive: 0xb4b4ae, emissiveIntensity: 0.5, envMapIntensity: 0.3 }, o || {}));
    const M = nmf(), Mdark = nmf({ color: 0x55574f, metalness: 0.2, roughness: 0.55, emissive: 0x0a0a0a, emissiveIntensity: 0.3 }), Mred = nmf({ color: 0xe0b020, metalness: 0.1, roughness: 0.5, emissive: 0x6a5008, emissiveIntensity: 0.4 }), Mod = nmf({ color: 0x5c6636, metalness: 0.1, roughness: 0.6, emissive: 0x20260c, emissiveIntensity: 0.4 });
    const Mglass = new THREE.MeshStandardMaterial({ color: 0xa8d4ea, metalness: 0.0, roughness: 0.05, transparent: true, opacity: 0.38, depthWrite: false, emissive: 0x2a4a5c, emissiveIntensity: 0.5 });
    const add = (geo, mat, name, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.name = name || ""; m.position.set(x || 0, y || 0, z || 0); g.add(m); return m; };
    // fuselage loft: sections along z (nose −z → tail +z); each {z, w (half width), t (top), b (bottom), y (centre)}
    function loft(secs, seg) {
      const pos = [], idx = [];
      for (const s of secs) for (let i = 0; i < seg; i++) { const a = i / seg * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a); pos.push(s.w * c, s.y + (sn > 0 ? s.t : s.b) * sn, s.z); }
      for (let k = 0; k < secs.length - 1; k++) for (let i = 0; i < seg; i++) { const a = k * seg + i, b = k * seg + (i + 1) % seg, c = (k + 1) * seg + i, d = (k + 1) * seg + (i + 1) % seg; idx.push(a, c, b, b, c, d); }
      const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals(); return geo;
    }
    const fus = loft([
      { z: -2.30, w: 0.05, t: 0.05, b: 0.05, y: 0 }, { z: -2.12, w: 0.30, t: 0.27, b: 0.26, y: 0.02 }, { z: -1.75, w: 0.40, t: 0.36, b: 0.34, y: 0.04 },
      { z: -1.2, w: 0.44, t: 0.42, b: 0.30, y: 0.06 }, { z: -0.6, w: 0.43, t: 0.44, b: 0.32, y: 0.08 }, { z: 0.1, w: 0.40, t: 0.40, b: 0.30, y: 0.07 },
      { z: 0.8, w: 0.33, t: 0.30, b: 0.24, y: 0.06 }, { z: 1.5, w: 0.22, t: 0.22, b: 0.17, y: 0.07 }, { z: 2.1, w: 0.11, t: 0.14, b: 0.10, y: 0.09 }, { z: 2.52, w: 0.04, t: 0.07, b: 0.05, y: 0.10 },
    ], 14);
    add(fus, M, "fuselage");
    // wing: straight taper, squared-off tips, laminar-flow thin section; slight dihedral
    function prism(x0, x1, le0, te0, le1, te1, t0, t1, y0, y1) { // x0 root → x1 tip, z of leading/trailing edge at each end
      const v = [[x0, y0 + t0, le0], [x0, y0 + t0, te0], [x1, y1 + t1, te1], [x1, y1 + t1, le1], [x0, y0 - t0, le0], [x0, y0 - t0, te0], [x1, y1 - t1, te1], [x1, y1 - t1, le1]];
      const pos = []; for (const q of v) pos.push(...q);
      const idx = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2];
      const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals(); return geo;
    }
    for (const sd of [1, -1]) {
      add(prism(sd * 0.3, sd * 2.9, -0.62, 0.62, -0.18, 0.28, 0.065, 0.025, -0.12, -0.04), M, sd > 0 ? "wing_r" : "wing_l");
      add(prism(sd * 0.1, sd * 1.0, 1.58, 2.18, 1.7, 2.1, 0.03, 0.02, 0.1, 0.1), M, "tailplane");
    }
    // wing-root fairing + belly radiator scoop (the P-51's signature chin under the aft cockpit)
    add(new THREE.BoxGeometry(0.46, 0.2, 0.9), M, "radiator", 0, -0.33, 0.55);
    add(new THREE.BoxGeometry(0.34, 0.12, 0.14), Mdark, "radiator_inlet", 0, -0.30, 0.09);
    add(new THREE.BoxGeometry(0.34, 0.12, 0.5), M, "chin_scoop", 0, -0.30, -1.55);
    // vertical fin with dorsal fillet (big), rudder
    {
      const s = new THREE.Shape(); s.moveTo(0, 0); s.lineTo(0.35, 0); s.lineTo(1.0, 0.82); s.lineTo(1.18, 0.82); s.lineTo(1.12, 0); s.lineTo(1.5, 0); s.lineTo(0, 0);
      // profile in (z, y): fillet starts at z=0.35 on the spine and sweeps up to the fin tip near z≈2.28
      const f = new THREE.Shape(); f.moveTo(0.35, 0.0); f.lineTo(1.55, 0.14); f.lineTo(2.0, 0.93); f.lineTo(2.34, 0.93); f.lineTo(2.44, 0.1); f.lineTo(2.38, 0.0); f.lineTo(0.35, 0.0);
      const geo = new THREE.ExtrudeGeometry(f, { depth: 0.07, bevelEnabled: false });
      geo.rotateY(-Math.PI / 2); // extrude axis → x; shape x → z, shape y → y
      geo.translate(-0.035, 0, 0);
      const fin = new THREE.Mesh(geo, M); fin.name = "fin"; fin.position.set(0, 0.16, 0); g.add(fin);
    }
    // bubble canopy (D-model): a tall teardrop on a low rear deck
    const can = add(new THREE.SphereGeometry(0.5, 16, 12), Mglass, "canopy_glass", 0, 0.42, 0.12); can.scale.set(0.34, 0.3, 0.98);
    add(new THREE.BoxGeometry(0.1, 0.06, 0.4), M, "windscreen_frame", 0, 0.5, -0.5);
    // spinner (red marker), four-blade prop, small blur disc
    const spin = add(new THREE.ConeGeometry(0.2, 0.52, 14), M, "spinner", 0, 0.03, -2.5); spin.rotation.x = -Math.PI / 2;
    add(new THREE.CylinderGeometry(0.31, 0.31, 0.09, 16, 1, true), Mred, "nose_band", 0, 0.03, -2.12).rotation.x = Math.PI / 2; // small yellow squadron nose band
    add(new THREE.BoxGeometry(0.3, 0.025, 0.95), Mod, "antiglare_panel", 0, 0.45, -1.2).rotation.x = -0.1; // olive-drab anti-glare panel ahead of the windscreen
    for (let k = 0; k < 4; k++) { const bl = add(new THREE.BoxGeometry(0.1, 1.5, 0.025), Mdark, "propblade" + k, 0, 0.03, -2.58); bl.rotation.z = k * Math.PI / 4 + 0.35; bl.scale.set(1, 1, 1); }
    // wing guns (3 per side), exhaust stacks
    for (const sd of [1, -1]) {
      for (let k = 0; k < 3; k++) add(new THREE.CylinderGeometry(0.018, 0.018, 0.5, 6), Mdark, "gun", sd * (1.0 + k * 0.18), -0.1, -0.7).rotation.x = Math.PI / 2;
      for (let k = 0; k < 6; k++) add(new THREE.BoxGeometry(0.05, 0.06, 0.12), Mdark, "exhaust", sd * 0.4, 0.12, -1.6 + k * 0.2);
    }
    // markings: US star-and-bar roundels (wing top port / underside starboard, fuselage sides), invasion stripes
    function tex(draw, w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; draw(c.getContext("2d"), w, h); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; }
    const roundelTex = tex((cx, w, h) => {
      cx.clearRect(0, 0, w, h); const c = w * 0.5 - 2, R = w * 0.5 - 2;
      const bar = (rr, col) => { cx.fillStyle = col; cx.fillRect(w * 0.5 + R * 0.55, h * 0.5 - R * 0.17 - rr, R * 0.72 + rr, R * 0.34 + rr * 2); cx.fillRect(w * 0.5 - R * 1.27 - rr, h * 0.5 - R * 0.17 - rr, R * 0.72 + rr, R * 0.34 + rr * 2); };
      cx.fillStyle = "#f2f2ec"; cx.beginPath(); cx.arc(w / 2, h / 2, R * 0.55 + 1, 0, 6.2832); cx.fill();
      cx.fillStyle = "#1c3a82"; cx.beginPath(); cx.arc(w / 2, h / 2, R * 0.5, 0, 6.2832); cx.fill();
      bar(3, "#1c3a82"); bar(0, "#f2f2ec");
      cx.fillStyle = "#f6f6f0"; cx.beginPath();
      for (let i = 0; i < 10; i++) { const r = i % 2 ? R * 0.2 : R * 0.45, a = -Math.PI / 2 + i * Math.PI / 5; cx.lineTo(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r); } cx.closePath(); cx.fill();
    }, 256, 256);
    const stripeTex = (vert) => tex((cx, w, h) => { const n = 5; for (let i = 0; i < n; i++) { cx.fillStyle = i % 2 ? "#14140f" : "#f1f1ea"; if (vert) cx.fillRect(i * w / n, 0, w / n + 1, h); else cx.fillRect(0, i * h / n, w, h / n + 1); } }, 160, 160);
    const decalMat = (t) => new THREE.MeshStandardMaterial({ map: t, transparent: true, roughness: 0.6, metalness: 0.1, emissive: 0x303030, emissiveIntensity: 0.25, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide });
    const decal = (w, h, mat, x, y, z, rx, ry) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat); m.position.set(x, y, z); m.rotation.set(rx || 0, ry || 0, 0); m.userData.decal = true; m.userData.noHit = true; g.add(m); return m; };
    const RM = decalMat(roundelTex), SMh = decalMat(stripeTex(false)), SMv = decalMat(stripeTex(true));
    decal(0.78, 0.78, RM, -1.8, -0.022, 0.05, -Math.PI / 2, 0);      // port wing, top
    decal(0.78, 0.78, RM, 1.8, -0.122, 0.05, Math.PI / 2, 0);        // starboard wing, underside
    decal(0.52, 0.52, RM, 0.327, 0.08, 0.9, 0, Math.PI / 2);         // fuselage sides
    decal(0.52, 0.52, RM, -0.327, 0.08, 0.9, 0, -Math.PI / 2);
    for (const sd of [1, -1]) {                                       // invasion stripes: spanwise bands over the inner wings, vertical bands round the aft fuselage
      decal(0.7, 0.9, SMh, sd * 1.0, -0.04, 0.02, -Math.PI / 2, 0);
      decal(0.6, 0.34, SMv, sd * 0.2, 0.09, 1.62, 0, sd * Math.PI / 2).scale.set(1, 1, 1);
    }
    return g;
  }

  // ===== 1.5.2 WGr.21 rockets: a dark tube, a hot flare, and a thick white smoke ribbon that hangs in the air =====
  const rktPool = [];
  for (let i = 0; i < 20; i++) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 2.6, 8), new THREE.MeshStandardMaterial({ color: 0x4a4d40, metalness: 0.4, roughness: 0.5 }));
    body.userData.noHit = true; g.add(body);
    const fl = new THREE.Sprite(new THREE.SpriteMaterial({ map: fireTex, color: 0xffd890, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.95 }));
    fl.position.y = -1.5; fl.scale.set(3.6, 3.6, 1); g.add(fl);
    g.visible = false; scene.add(g);
    rktPool.push({ g, fl, id: -1 });
  }
  const _rkUp = new THREE.Vector3(0, 1, 0), _rkD = new THREE.Vector3(), _rkP = new THREE.Vector3();
  function updateRockets(list) {
    list = list || [];
    const ids = new Set(); for (const r of list) ids.add(r.id);
    for (const P of rktPool) if (P.id >= 0 && !ids.has(P.id)) { P.id = -1; P.g.visible = false; }
    for (const r of list) {
      let P = rktPool.find((q) => q.id === r.id) || rktPool.find((q) => q.id < 0);
      if (!P) continue;
      P.id = r.id; P.g.visible = true;
      P.g.position.set(r.x, r.y, r.z);
      _rkD.set(r.vx, r.vy, r.vz + AIR_DRIFT).normalize();
      P.g.quaternion.setFromUnitVectors(_rkUp, _rkD);
      const f = 3.2 + Math.random() * 1.4; P.fl.scale.set(f, f, 1);
      _rkP.set(r.x, r.y, r.z);
      ribbonEmit("rk" + r.id, _rkP, { w0: 0.9, w1: 6.5, life: 4.2, a: 0.85, col: [0.93, 0.93, 0.9], drift: AIR_DRIFT });
    }
  }

  function cloneFighter(kind) {
    const src = prototypes[kind] || prototypes["109"];
    if (!src) return null;
    const mesh = src.clone(true);
    mesh.userData.isP51 = (kind === "p51");
    mesh.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = false;
        o.receiveShadow = false;
        if (o.material) {
          o.material = o.material.clone();
          if ("envMapIntensity" in o.material) o.material.envMapIntensity = 0.8;
        }
      }
    });
    // World-ish readable scale (mesh span ~4.6–4.8u ≈ phone 35ft×~25). NOT 7–20× face-huggers.
    mesh.scale.setScalar(kind === "110" ? 2.45 : kind === "190" ? 2.15 : 2.0);
    if (kind === "p51" && !src.userData.procedural) { // 1.5.0: no P-51 model (1.5.2: the procedural P-51D model skips this) — the 109 mesh painted natural metal (spec: 0xC5C2B4, metalness 0.55, roughness 0.38)
      mesh.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          const nm = ((m.name || "") + " " + (o.name || "")).toLowerCase();
          if (m.transparent || (m.opacity != null && m.opacity < 0.95) || /glass|canop|wind|prop|disc|spinner|hub|tire|wheel|gear/.test(nm)) continue;
          if (m.color) m.color.setHex(0xC5C2B4);
          if ("metalness" in m) m.metalness = 0.55;
          if ("roughness" in m) m.roughness = 0.38;
          if ("map" in m && m.map) { m.map = null; m.needsUpdate = true; }
          if (m.emissive) m.emissive.setHex(0x1a1a18);
          m.userData = m.userData || {}; m.userData.nmf = true;
        }
      });
    }
    // contact-ish blob under the fighter (grounds 3D vs photo sky)
    if (!mesh.userData.blob) {
      const c = document.createElement("canvas");
      c.width = 64; c.height = 64;
      const cx = c.getContext("2d");
      const g = cx.createRadialGradient(32, 32, 6, 32, 32, 30);
      g.addColorStop(0, "rgba(18,14,10,0.40)");
      g.addColorStop(1, "rgba(18,14,10,0)");
      cx.fillStyle = g;
      cx.fillRect(0, 0, 64, 64);
      const tex = new THREE.CanvasTexture(c);
      const blob = new THREE.Mesh(
        new THREE.PlaneGeometry(2.1, 1.25),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.5, fog: true })
      );
      blob.rotation.x = -Math.PI / 2;
      blob.position.y = -0.42;
      blob.userData.isShadow = true;
      blob.visible = false;
      mesh.add(blob);
      mesh.userData.blob = blob;
    }
    // 1.3.9 LOD: remember each material's own look so the crossfade / small-size darkening can
    // be applied and undone every frame; add a constant-pixel-width dark outline hull (fades out
    // once the model is bigger than ~25 px on screen).
    const fmats = [], olMeshes = [];
    mesh.traverse((o) => {
      if (!o.isMesh || !o.material || o.userData.isShadow || o.userData.isOutline) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        m.userData.op0 = m.opacity; m.userData.tr0 = m.transparent;
        fmats.push({ m, op: m.opacity, tr: m.transparent, col: m.color ? m.color.clone() : null, env: m.envMapIntensity, emi: m.emissiveIntensity });
      }
      const nm = ((o.name || "") + " " + mats.map((x) => x.name || "").join(" ")).toLowerCase();
      if (o.visible && !nm.includes("disc") && !mats.some((x) => x.transparent && x.opacity < 0.5)) olMeshes.push(o);
    });
    const olMat = new THREE.ShaderMaterial({
      uniforms: { uW: { value: 0.6 }, uPPR: { value: 900 }, uOp: { value: 0 }, uC: { value: new THREE.Color(0x121310) } },
      vertexShader: "uniform float uW; uniform float uPPR; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vec3 n = normalize(normalMatrix * normal); mv.xyz += n * (uW * max(0.5, -mv.z) / uPPR); gl_Position = projectionMatrix * mv; }",
      fragmentShader: "uniform vec3 uC; uniform float uOp; void main(){ gl_FragColor = vec4(uC, uOp);\n#include <colorspace_fragment>\n}",
      side: THREE.BackSide, transparent: true, depthWrite: false,
    });
    for (const o of olMeshes) {
      if (!o.geometry.attributes.normal) continue;
      const ol = new THREE.Mesh(o.geometry, olMat);
      ol.userData.isOutline = true; ol.userData.noHit = true;
      ol.visible = false; ol.renderOrder = 1;
      o.add(ol);
    }
    mesh.userData.fmats = fmats; mesh.userData.olMat = olMat; mesh.userData.olMeshes = olMeshes;
    mesh.visible = false;
    scene.add(mesh);
    return mesh;
  }

  // Outline: collect meshes first so we never traverse into newly added outlines
  function addOutline(root, color = 0x0a0a08, scale = 1.035) {
    const meshes = [];
    root.traverse((o) => {
      if (!o.isMesh || !o.geometry || o.userData.isOutline) return;
      const n = (o.name || "").toLowerCase();
      // Never outline prop discs / glass — BackSide scale makes a black sky blob
      if (n.includes("prop") || n.includes("disc") || n.includes("glass") || n.includes("canopy") || n.includes("spinner")) return;
      meshes.push(o);
    });
    for (const o of meshes) {
      const ol = new THREE.Mesh(
        o.geometry,
        new THREE.MeshBasicMaterial({ color, side: THREE.BackSide })
      );
      ol.userData.isOutline = true;
      ol.scale.set(scale, scale, scale);
      o.add(ol);
    }
  }


  function toPhong(mat, opts = {}) {
    if (!mat) return mat;
    const color = mat.color ? mat.color.clone() : new THREE.Color(0x888888);
    const map = mat.map || null;
    const phong = new THREE.MeshPhongMaterial({
      color,
      map,
      shininess: opts.shininess != null ? opts.shininess : 55,
      specular: new THREE.Color(opts.specular != null ? opts.specular : 0x555555),
      transparent: !!mat.transparent,
      opacity: mat.opacity != null ? mat.opacity : 1,
      side: mat.side != null ? mat.side : THREE.FrontSide,
      depthWrite: mat.depthWrite !== false,
      emissive: mat.emissive ? mat.emissive.clone() : new THREE.Color(0x000000),
      emissiveIntensity: mat.emissiveIntensity || 0,
    });
    if (map) {
      phong.map.colorSpace = THREE.SRGBColorSpace;
      phong.map.anisotropy = 4;
      phong.map.needsUpdate = true;
    }
    return phong;
  }

  function convertTreeToPhong(root, opts = {}) {
    root.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      if (o.userData.isOutline) return;
      if (Array.isArray(o.material)) {
        o.material = o.material.map((m) => toPhong(m, opts));
      } else {
        o.material = toPhong(o.material, opts);
      }
    });
  }

    function hashName(n) {
    let h = 0;
    for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) | 0;
    return h;
  }

  async function loadModels() {
    // XHR (not fetch) so file:///android_asset GLBs load on WebView
    const load = (url) =>
      new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.responseType = "arraybuffer";
        xhr.onload = () => {
          if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) {
            const path = url.replace(/[^/]+$/, "");
            try {
              loader.parse(xhr.response, path, resolve, reject);
            } catch (e) {
              reject(e);
            }
          } else {
            reject(new Error("XHR " + xhr.status + " " + url));
          }
        };
        xhr.onerror = () => reject(new Error("XHR error " + url));
        xhr.send();
      });
    try {
      const [turretGltf, bf, fw] = await Promise.all([
        load("assets/models/turret_interior.glb").then(g => { console.log("[World3D] turret ok"); return g; }),
        load("assets/models/fighter_bf109.glb").then(g => { console.log("[World3D] bf109 ok"); return g; }),
        load("assets/models/fighter_fw190.glb").then(g => { console.log("[World3D] fw190 ok"); return g; }),
      ]);

      turretScene = turretGltf.scene;
      // Push assembly forward so receivers/belts stay in front of near-plane;
      // slight tip so jacket TOP (holes) faces camera, not edge-on bore view only.
      turretScene.rotation.set(0.035, 0, 0); // 1.3.7: bores parallel to the sight line → barrels vanish at the reticle (0.10 tip pointed them ~5° high)
      turretScene.position.set(0, GUN_Y, GUN_Z);
      turretScene.scale.setScalar(1.0);
      turretScene.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        const n = (o.name || "").toLowerCase();
        // Hide non-gun clutter + stiff ammo-link belt (yellow chain). Keep receivers/jackets/feed.
        // Brass eject is screen-space particles — Link*Case/Bullet read as cardboard chains.
        // 1.3.1: NON-obstructive — keep only the twin .50s themselves (no struts, ammo cans,
        // crossbar, ring gear, dome ring, feed chutes, spade grips, cradles).
        const base = n.replace(/-?1$/, "").replace(/-1_|1_/, "_");
        // 1.3.9: the full Sperry twin-.50 kit back in view — charging handles, spade grips, feed chutes/covers,
        // trunnions and the linked belts running into the feed (ammo cans / floor / dome ring stay hidden)
        const keep = /^(barrel|jacket|jacketcap|hider|muzzle|bore|receiver|rectop|buffer|buffercap|sideplate|charge|chargeknob|spade|feedchute|feedcover|trunnion|trunblock)$/.test(base); // 1.4.0: open link belts gone — enclosed flexible chutes instead
        if (!keep) {
          o.visible = false;
          return;
        }
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const gun = /receiver|rectop|feed|buffer|jacket|barrel|muzzle|hider|charge|sideplate|trunnion|bore|link|trun/.test(n);
        const steel = gun || /cool|ringgear|cross/.test(n);
        o.material = mats.map((src) => {
          // Dark blued steel for guns
          const color = src.color ? src.color.clone() : new THREE.Color(steel ? 0x2a3038 : 0x3a4228);
          if (steel && !src.map) color.setHex(0x2c323a);
          const opts = {
            color,
            map: src.map || null,
            metalness: steel ? 0.92 : 0.20,
            roughness: steel ? 0.32 : 0.60,
            envMapIntensity: steel ? 0.35 : 0.12,
            emissive: new THREE.Color(steel ? 0x0c1014 : 0x080a06),
            emissiveIntensity: steel ? 0.08 : 0.03,
          };
          if (src.normalMap) opts.normalMap = src.normalMap;
          if (src.roughnessMap) opts.roughnessMap = src.roughnessMap;
          const mat = steel ? new THREE.MeshPhysicalMaterial(Object.assign(opts, { clearcoat: 0.45, clearcoatRoughness: 0.22 })) : new THREE.MeshStandardMaterial(opts);
          if (steel) gunWear(mat, /jacket|barrel|muzzle|hider|bore/.test(n) ? 1 : 0);
          if (mat.map) {
            mat.map.colorSpace = THREE.SRGBColorSpace;
            mat.map.anisotropy = 8;
            mat.map.needsUpdate = true;
          }
          if (/link/.test(n) && !/case/.test(n) && !/bullet/.test(n)) {
            mat.color.setHex(0x6a5420);
            mat.metalness = 0.78;
            mat.roughness = 0.40;
            mat.map = null;
          }
          if (/ammo/.test(n) && !/link/.test(n)) {
            mat.color.setHex(0x2e3a22);
            mat.metalness = 0.18;
            mat.roughness = 0.62;
          }
          if (/spade|rubber/.test(n)) {
            mat.color.setHex(0x0c0c0c);
            mat.metalness = 0.05;
            mat.roughness = 0.92;
          }
          if (/feedchute|feedcover/.test(n)) { // 1.4.0: dull painted sheet steel, not chrome
            mat.color.setHex(0x2b2e2b);
            mat.metalness = 0.35;
            mat.roughness = 0.82;
            mat.envMapIntensity = 0.2;
            if (mat.clearcoat != null) mat.clearcoat = 0;
          }
          if (/receiver|rectop|buffer|trunn|sideplate|charge/.test(n)) {
            mat.color.setHex(0x3a424c);
            mat.metalness = 0.9;
            mat.roughness = 0.28;
            mat.envMapIntensity = 0.55;
            mat.map = null;
            mat.emissive = new THREE.Color(0x10151c);
            mat.emissiveIntensity = 0.08;
            if (mat.clearcoat != null) { mat.clearcoat = 0.7; mat.clearcoatRoughness = 0.18; }
          }
          if (/jacket/.test(n) && !/cap/.test(n)) {
            // 1.4.0: dark PARKERIZED jackets (matte grey-black phosphate) like the photos; the real geometry
            // perforations still read because the inner faces are darker still
            mat.color.setHex(0x3d403f);
            mat.metalness = 0.5;
            mat.roughness = 0.7;
            mat.envMapIntensity = 0.3;
            if (mat.clearcoat != null) { mat.clearcoat = 0.08; mat.clearcoatRoughness = 0.6; }
            mat.transparent = false;
            mat.side = THREE.DoubleSide;
            mat.map = null;
            mat.emissive = new THREE.Color(0x141a22);
            mat.emissiveIntensity = 0.09;
            // wear grit — slightly uneven finish
            mat.roughness = 0.66 + (Math.abs(hashName(n)) % 10) * 0.012;
          }
          if (/case/.test(n)) {
            mat.color.setHex(0xe0b84a);
            mat.metalness = 0.95;
            mat.roughness = 0.22;
            mat.envMapIntensity = 0.6;
            mat.map = null;
            mat.emissive = new THREE.Color(0x3a2a08);
            mat.emissiveIntensity = 0.12;
          }
          if (/bullet/.test(n)) {
            mat.color.setHex(0xb07038);
            mat.metalness = 0.9;
            mat.roughness = 0.28;
            mat.map = null;
          }
          return mat;
        });
        if (o.material.length === 1) o.material = o.material[0];
      });
      turretAnchor.add(turretScene);

      setupGunGroups();
      addFlexChutes();
      toOverlay(turretAnchor);
      for (const l of muzzleLights) l.layers.enable(0); // the flash also lights the airframe around the muzzles

      prototypes["109"] = bf.scene;
      prototypes["190"] = fw.scene;
      prototypes["110"] = bf.scene;
      prototypes["p51"] = buildP51Model();

      function punchFighterMats(root, paint) {
        root.traverse((o) => {
          if (!o.isMesh || !o.material || o.userData.isOutline) return;
          const n = (o.name || "").toLowerCase();
          const srcs = Array.isArray(o.material) ? o.material : [o.material];
          const out = srcs.map((src) => {
            const col = src.color ? src.color.clone() : new THREE.Color(paint);
            col.lerp(new THREE.Color(paint), 0.34);
            const opts = {
              color: col,
              map: src.map || null,
              metalness: 0.3,
              roughness: 0.46,
              envMapIntensity: 0.45,
              // 1.3.2: faint sky-fill only; form comes from the sun + hemisphere now
              emissive: new THREE.Color(0x1a2834),
              emissiveIntensity: 0.04,
            };
            if (n.includes("glass") || n.includes("canopy")) {
              opts.color = new THREE.Color(0x6a90a8);
              opts.transparent = true;
              opts.opacity = 0.42;
              opts.metalness = 0.06;
              opts.roughness = 0.12;
              opts.emissive = new THREE.Color(0x102028);
              opts.emissiveIntensity = 0.16;
            } else if (n.includes("prop") || n.includes("disc")) {
              opts.color = new THREE.Color(0xa8a090);
              opts.transparent = true;
              opts.opacity = 0.10;
              opts.metalness = 0.04;
              opts.roughness = 0.9;
              opts.depthWrite = false;
              opts.emissiveIntensity = 0.03;
            } else if (n.includes("spin")) {
              opts.color = new THREE.Color(0x6a1010);
              opts.metalness = 0.42;
              opts.roughness = 0.34;
              opts.emissive = new THREE.Color(0x2a0808);
              opts.emissiveIntensity = 0.10;
            } else if (n.includes("yellow") || n.includes("nose") || n.includes("band")) {
              opts.color = new THREE.Color(0xe8b820);
              opts.metalness = 0.28;
              opts.roughness = 0.38;
              opts.emissive = new THREE.Color(0x4a3208);
              opts.emissiveIntensity = 0.16;
            } else if (n.includes("cross") || n.includes("balken") || n.includes("hinomaru") || n.includes("mark")) {
              opts.emissiveIntensity = Math.max(opts.emissiveIntensity || 0, 0.08);
            }
            const mat = new THREE.MeshStandardMaterial(opts);
            if (mat.map) {
              mat.map.colorSpace = THREE.SRGBColorSpace;
              mat.map.anisotropy = 4;
              mat.map.needsUpdate = true;
            }
            return mat;
          });
          o.material = out.length === 1 ? out[0] : out;
        });
      }

      for (const key of ["109", "190"]) {
        if (!prototypes[key]) continue;
        prototypes[key].traverse((o) => {
          const n = (o.name || "").toLowerCase();
          if (/wheel|gear|strut|tyre|tire|landing|leg|axle|hubcap|backwheel/.test(n)) {
            o.visible = false;
          }
          // glued-on spinner cones sit off the nose after recook — hide
          if (n === "spinner" || n.startsWith("spinner")) {
            o.visible = false;
          }
          // hide any leftover solid prop blades on 190 (keep PropDisc only)
          if (key === "190" && /^prop\d/i.test(o.name) && !n.includes("disc") && !n.includes("hub")) {
            o.visible = false;
          }
        });
      }
      punchFighterMats(prototypes["109"], 0x3a3e30);
      punchFighterMats(prototypes["190"], 0x6e7668);
      // Bake mesh nose (+X authored) → local +Z so sync basis (Z=velocity) flies nose-first.
      // Without this, fighters present wing/belly and read as parked cardboard.
      function bakeNoseToZ(root) {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
        root.traverse((o) => {
          if (!o.isMesh || !o.geometry) return;
          o.geometry = o.geometry.clone();
          o.geometry.applyQuaternion(q);
          o.geometry.computeVertexNormals();
        });
      }
      for (const key of ["109", "190"]) {
        if (prototypes[key]) bakeNoseToZ(prototypes[key]);
      }
      // Force 190 Luftwaffe: strip Zero/hinomaru albedo, RLM grey-green, keep yellow band + crosses
      if (prototypes["190"]) {
        prototypes["190"].traverse((o) => {
          if (!o.isMesh || !o.material) return;
          const n = (o.name || "").toLowerCase();
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          const out = mats.map((m) => {
            if (!m) return m;
            const mn = ((m.name || "") + " " + n).toLowerCase();
            if (mn.includes("prop") || mn.includes("disc")) return m;
            if (mn.includes("yellow") || mn.includes("balken") || mn.includes("kreuz") || mn.includes("cross")) return m;
            // Body / Zero mats → solid RLM 02/71 grey-green (no hinomaru map)
            if (m.map) { m.map = null; m.needsUpdate = true; }
            if (m.color) {
              if (mn.includes("canopy") || mn.includes("glass")) m.color.setHex(0x6a90a8);
              else m.color.setHex(0x6e7668); // cooler Luftwaffe grey, not Zero olive
            }
            if ("metalness" in m) m.metalness = 0.22;
            if ("roughness" in m) m.roughness = 0.55;
            return m;
          });
          o.material = out.length === 1 ? out[0] : out;
        });
      }
      // NO cel outline — it reads as a toy against the photo sky.
      // Rim comes from cool fill + slight emissive in punchFighterMats.

      for (let i = 0; i < 56; i++) {
        const mesh = cloneFighter("109");
        fighterPool.push({ mesh, kind: "109", trail: makeTrail() });
      }
      modelsReady = true;
      console.log("[World3D] models ready");
    } catch (e) {
      console.warn("[World3D] model load failed", e && (e.message || e.stack || String(e)), e);
      // procedural fallback fighters already may be absent — build simple ones
      buildFallbackFighters();
      buildFallbackTurret();
      modelsReady = true;
    }
  }

  function buildFallbackTurret() {
    const g = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0x4a4c44, metalness: 0.85, roughness: 0.4 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a1c16, metalness: 0.8, roughness: 0.45 });
    const olive = new THREE.MeshStandardMaterial({ color: 0x3a4228, metalness: 0.5, roughness: 0.55 });
    // ring
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.05, 8, 40), dark);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -0.55;
    g.add(ring);
    // guns
    for (const sx of [-0.28, 0.28]) {
      const rec = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.45), dark);
      rec.position.set(sx, 0.02, 0.1);
      g.add(rec);
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 1.0, 10), steel);
      bar.rotation.x = Math.PI / 2;
      bar.position.set(sx, 0.02, -0.5);
      g.add(bar);
    }
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.7, 12), olive);
    ped.position.set(0, -0.2, 0.2);
    g.add(ped);
    g.position.set(0, -0.4, 0.2);
    turretAnchor.add(g);
    turretScene = g;
  }

  function buildFallbackFighters() {
    function make(kind) {
      const g = new THREE.Group();
      const col = kind === "190" ? 0x4a5238 : 0x7a6848;
      const mat = new THREE.MeshStandardMaterial({ color: col, metalness: 0.35, roughness: 0.5 });
      const dark = new THREE.MeshStandardMaterial({ color: 0x2a2818, metalness: 0.4, roughness: 0.45 });
      const fus = new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 1.6, 6, 12), mat);
      fus.rotation.z = Math.PI / 2;
      g.add(fus);
      const wing = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.06, 3.2), mat);
      g.add(wing);
      const nose = new THREE.Mesh(
        new THREE.ConeGeometry(0.22, 0.5, 10),
        new THREE.MeshStandardMaterial({ color: 0xb8860b, metalness: 0.4, roughness: 0.4 })
      );
      nose.rotation.z = -Math.PI / 2;
      nose.position.x = -1.1;
      g.add(nose);
      const can = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0xa8d0e8, metalness: 0.1, roughness: 0.15, transparent: true, opacity: 0.7 })
      );
      can.position.set(-0.1, 0.18, 0);
      can.scale.set(1.4, 0.9, 0.7);
      g.add(can);
      const vstab = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.55, 0.05), dark);
      vstab.position.set(0.95, 0.25, 0);
      g.add(vstab);
      // cross
      const kw = new THREE.MeshBasicMaterial({ color: 0xe8e8e0 });
      const kb = new THREE.MeshBasicMaterial({ color: 0x111110 });
      for (const z of [-1.0, 1.0]) {
        const k = new THREE.Group();
        k.add(new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.08, 0.35), kw));
        k.add(new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.35, 0.08), kw));
        k.add(new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.04, 0.22), kb));
        k.add(new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.22, 0.04), kb));
        k.position.set(0.05, 0.04, z);
        g.add(k);
      }
      g.scale.setScalar(2.1);
      return g;
    }
    prototypes["109"] = make("109");
    prototypes["190"] = make("190");
    prototypes["110"] = make("109");
    prototypes["p51"] = buildP51Model();
    for (let i = 0; i < 56; i++) {
      const mesh = cloneFighter("109");
      fighterPool.push({ mesh, kind: "109", trail: makeTrail() });
    }
  }

    function applySkyTexture(image) {
    if (!image) return;
    // Use Three.js background shader (equirect). Avoid SphereGeometry UV poles —
    // looking near the nadir on a UV sky sphere causes kaleidoscope/mirror at horizon.
    const bg = new THREE.Texture(image);
    bg.colorSpace = THREE.SRGBColorSpace;
    bg.mapping = THREE.EquirectangularReflectionMapping;
    bg.minFilter = THREE.LinearMipmapLinearFilter;
    bg.magFilter = THREE.LinearFilter;
    bg.generateMipmaps = true;
    bg.anisotropy = 8;
    bg.needsUpdate = true;
    void bg; // 1.3.6: the procedural sky dome replaces the painted equirect (bluer, sharper, rotates with heading)
    // Dim studio env so Standard metals have something to catch — NOT the sky (was washing guns)
    const envC = document.createElement("canvas");
    envC.width = 64; envC.height = 32;
    const ex = envC.getContext("2d");
    const eg = ex.createLinearGradient(0, 0, 0, 32);
    eg.addColorStop(0, "#c8d4e0");
    eg.addColorStop(0.45, "#8a9098");
    eg.addColorStop(1, "#3a3428");
    ex.fillStyle = eg;
    ex.fillRect(0, 0, 64, 32);
    const envTex = new THREE.CanvasTexture(envC);
    envTex.mapping = THREE.EquirectangularReflectionMapping;
    envTex.colorSpace = THREE.SRGBColorSpace;
    envTex.needsUpdate = true;
    scene.environment = envTex;
    scene.fog = new THREE.Fog(SKY_HORIZON.getHex(), 3500, 52000);
    haze.visible = false; // 1.3.1: farmland + fog own the horizon now
  }

  // 1.3.9: pixel-ratio cap raised 1.5 → 2.0 (sharper far fighters / thin tracers on phones); if the
  // first ~2 s of flying average slower than 22 ms/frame it drops back to 1.5 once, for good.
  let prCap = 2.0, prT = 0, prN = 0, prSum = 0, prDone = false;
  function prWatch() {
    const now = pnow();
    if (prDone || window.__FG_PR) { prT = now; return; }
    if (prT) { const dt = now - prT; if (dt < 250) { prSum += dt; prN++; } }
    prT = now;
    if (prN >= 120) {
      prDone = true;
      if (prSum / prN > 22 && (window.devicePixelRatio || 1) > 1.5) { prCap = 1.5; resize(); }
    }
  }
  function resize() {
    const w = window.innerWidth,
      h = window.innerHeight;
    // 1.4.0-web: also a pixel budget (~3.2 MP drawn) so big desktop windows / 4K screens stay smooth; phones are under it
    const budget = Math.sqrt(3.2e6 / Math.max(1, w * h));
    renderer.setPixelRatio(window.__FG_PR || Math.max(0.75, Math.min(window.devicePixelRatio || 1, prCap, budget)));
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }

  // ===== 1.5.4 FIGHTER MUZZLE FLASHES — P-51 six wing guns, 190 wing-root/outer cannon + cowl MGs, 109 cowl MGs + nose cannon.
  // A global pool of additive sprites (cap 30, one draw call each only while a gun is firing). e.mf > 0 = firing this instant. =====
  const _mzList = [];
  const MZ_N = 30, mzPool = []; let mzPrev = 0;
  const MZ_GUNS = { // [x as fraction of the half-span, forward fraction of the length from the nose, size k]
    p51: [[-0.30, 0.34, 1], [-0.38, 0.34, 1], [-0.46, 0.34, 1], [0.30, 0.34, 1], [0.38, 0.34, 1], [0.46, 0.34, 1]],
    "190": [[-0.17, 0.30, 1.25], [0.17, 0.30, 1.25], [-0.42, 0.32, 1.25], [0.42, 0.32, 1.25], [-0.05, 0.05, 0.8], [0.05, 0.05, 0.8]],
    "109": [[-0.04, 0.12, 0.9], [0.04, 0.12, 0.9], [0, 0.0, 1.3]],
  };
  const mzBox = {}, _mzv = new THREE.Vector3(), _mzB = new THREE.Box3();
  function mzLocalBox(mesh, kind) {
    if (mzBox[kind]) return mzBox[kind];
    const p = mesh.position.clone(), q = mesh.quaternion.clone(), sc = mesh.scale.clone();
    mesh.position.set(0, 0, 0); mesh.quaternion.identity(); mesh.scale.set(1, 1, 1); mesh.updateMatrixWorld(true);
    _mzB.setFromObject(mesh); const b = _mzB.clone();
    mesh.position.copy(p); mesh.quaternion.copy(q); mesh.scale.copy(sc); mesh.updateMatrixWorld(true);
    return (mzBox[kind] = b);
  }
  function muzzleFlashes(list) { // list: [e, mesh, kind, dist] firing this frame
    let used = 0;
    for (let li = 0; li < list.length; li += 4) {
      const e = list[li], mesh = list[li + 1], kind = list[li + 2], dist = list[li + 3];
      const G = MZ_GUNS[kind]; if (!G) continue;
      const bx = mzLocalBox(mesh, kind), hs = (bx.max.x - bx.min.x) * 0.5, len = bx.max.z - bx.min.z, cy = (bx.max.y + bx.min.y) * 0.5;
      mesh.updateMatrixWorld(true);
      for (let gi = 0; gi < G.length; gi++) {
        if (used >= MZ_N) break;
        if (Math.random() > 0.62) continue; // each gun cycles ~13 rd/s: not every gun shows on every frame
        const g = G[gi];
        let sp = mzPool[used];
        if (!sp) { sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, color: 0xffe8b0 })); sp.renderOrder = 6; scene.add(sp); mzPool[used] = sp; }
        _mzv.set(g[0] * hs, cy - 0.03 * len, bx.min.z + g[1] * len - 0.05 * len); mesh.localToWorld(_mzv);
        sp.position.copy(_mzv);
        const sz = Math.max(1.3, dist * 0.0042) * g[2] * (0.75 + Math.random() * 0.6);
        sp.scale.set(sz, sz, 1); sp.material.rotation = Math.random() * 6.28; sp.material.opacity = 0.55 + 0.4 * Math.random(); sp.visible = true;
        used++;
      }
    }
    for (let i = used; i < mzPrev; i++) if (mzPool[i]) mzPool[i].visible = false;
    mzPrev = used; mzStats.n = used;
  }
  const mzStats = { n: 0 };
  function ensureKind(slot, kind) {
    const k = kind === "110" ? "109" : kind;
    if (slot.kind === k && slot.mesh) return;
    if (slot.mesh) scene.remove(slot.mesh);
    slot.mesh = cloneFighter(k);
    slot.kind = k;
    if (kind === "110" && slot.mesh) slot.mesh.scale.setScalar(2.45);
  }

  // 1.3.3: kill blast + tumbling debris for bandits
  const _spinQ = new THREE.Quaternion();
  const debrisMat = new THREE.MeshStandardMaterial({ color: 0x3a3d34, roughness: 0.7, metalness: 0.4 });
  const debrisGeo = [new THREE.BoxGeometry(1.2, 0.12, 0.6), new THREE.BoxGeometry(0.5, 0.4, 0.5), new THREE.BoxGeometry(1.8, 0.1, 0.35)];
  const debris = [];
  for (let i = 0; i < 40; i++) {
    const m = new THREE.Mesh(debrisGeo[i % 3], debrisMat);
    m.visible = false; scene.add(m);
    debris.push({ m, life: 0, v: new THREE.Vector3(), w: new THREE.Vector3() });
  }
  let debrisIdx = 0;
  const blasts = [];
  for (let i = 0; i < 6; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: fireTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    s.visible = false; scene.add(s);
    blasts.push({ s, life: 0 });
  }
  let blastIdx = 0, _dbT = pnow();
  function spawnKillFx(pos, e) {
    const b = blasts[blastIdx]; blastIdx = (blastIdx + 1) % blasts.length;
    b.s.position.copy(pos); b.life = 0.45; b.s.visible = true;
    for (let i = 0; i < 9; i++) {
      const d = debris[debrisIdx]; debrisIdx = (debrisIdx + 1) % debris.length;
      d.m.position.copy(pos);
      d.v.set((e.vx || 0) * 0.5 + (Math.random() - 0.5) * 40, (e.vy || 0) * 0.3 + Math.random() * 20 - 4, (e.vz || 0) * 0.5 + (Math.random() - 0.5) * 40);
      d.w.set(Math.random() * 12, Math.random() * 12, Math.random() * 12);
      d.m.scale.setScalar(0.8 + Math.random() * 1.2);
      d.life = 2.2 + Math.random();
      d.m.visible = true;
    }
    for (let i = 0; i < 5; i++) emitSmoke(pos, true, true, { life: 3.5, s0: 3, s1: 14, a: 0.75 });
  }
  function updateDebris() {
    const now = pnow();
    const dt = Math.min(0.05, (now - _dbT) / 1000); _dbT = now;
    for (const d of debris) {
      if (d.life <= 0) continue;
      d.life -= dt;
      if (d.life <= 0) { d.m.visible = false; continue; }
      d.v.y -= 18 * dt;
      d.m.position.addScaledVector(d.v, dt);
      d.m.rotation.x += d.w.x * dt; d.m.rotation.y += d.w.y * dt; d.m.rotation.z += d.w.z * dt;
    }
    for (const b of blasts) {
      if (b.life <= 0) continue;
      b.life -= dt;
      if (b.life <= 0) { b.s.visible = false; continue; }
      const k = 1 - b.life / 0.45;
      const s = 6 + k * 16;
      b.s.scale.set(s, s, 1);
      b.s.material.opacity = (1 - k) * 0.95;
    }
  }
  const _rollQ = new THREE.Quaternion();
  const _camFallE = new THREE.Euler();
  const _zAxis = new THREE.Vector3(0, 0, 1);
  const _fw = new THREE.Vector3(), _up = new THREE.Vector3(), _rt = new THREE.Vector3(), _m4 = new THREE.Matrix4();
  // 1.3.9 ONE ANGULAR-SIZE RULE for far fighters. Sizes are in phone device px (CSS px × DPR).
  //  • the model is drawn at true scale inside LOD_NEAR; between LOD_NEAR and LOD_FAR it crossfades
  //    (opacity) into a round soft dot; beyond LOD_FAR only the dot is drawn.
  //  • the dot's diameter is the 109's equivalent-area disc (≈2.4 u) at its true angular size,
  //    floored at DOT_FLOOR px; below the floor it keeps DOT_FLOOR px and its alpha falls with the
  //    square of the true size (constant "ink"), so it fades out instead of staying a fixed blob.
  //  • dot colour = dark airframe mixed toward the fog colour with the scene's own linear fog
  //    factor, i.e. the same haze curve the mesh gets from the Fog.
  //  • small models get silhouette darkening + a 0.75 px dark outline, fading out 12→25 px span.
  const LOD_NEAR = 700, LOD_FAR = 1400, SPECK_MAX = 12000, SPECK_N = 64;
  const DOT_FLOOR = 1.75, DOT_EQ = 2.4, SPAN = 6.24;
  const SPECK_FROM = LOD_FAR; // kept for the debug hooks
  const _dark = new THREE.Color(0x15171a);
  function devPxPerRad() { return (window.innerHeight || 400) * (window.devicePixelRatio || 1) / (2 * Math.tan(camera.fov * Math.PI / 360)); }
  function lodMeshW(d) { const t = Math.min(1, Math.max(0, (LOD_FAR - d) / (LOD_FAR - LOD_NEAR))); return t * t * (3 - 2 * t); }
  function fogF(d) { const f = scene.fog; return f ? Math.min(1, Math.max(0, (d - f.near) / (f.far - f.near))) : 0; }
  const _tmpC = new THREE.Color();
  function applyFighterLook(mesh, w, sizeK, dist) {
    const u = mesh.userData;
    if (!u.fmats) return;
    const st = w.toFixed(3) + "|" + sizeK.toFixed(3);
    if (u._lookSt !== st) {
      u._lookSt = st;
      for (const f of u.fmats) {
        const m = f.m;
        const tr = f.tr || w < 0.999;
        if (m.transparent !== tr) { m.transparent = tr; m.needsUpdate = true; }
        m.opacity = f.op * w;
        m.depthWrite = !f.tr;
        if (f.col) m.color.copy(f.col).lerp(_tmpC.copy(_dark).convertSRGBToLinear(), (u.isP51 ? 0.06 : 0.55) * sizeK); // P-51s stay silver at range
        if (f.env != null) m.envMapIntensity = f.env * (1 - 0.8 * sizeK);
        if (f.emi != null) m.emissiveIntensity = f.emi * (1 - (u.isP51 ? 0.1 : 1) * sizeK);
      }
    }
    const op = (u.isP51 ? 0.45 : 0.85) * sizeK * w;
    if (u.isP51) u.olMat.uniforms.uC.value.setHex(0x6a6e70);
    u.olMat.uniforms.uOp.value = op;
    const pr = renderer.getPixelRatio(), dpr = window.devicePixelRatio || 1;
    u.olMat.uniforms.uW.value = Math.max(0.55, 0.75 * pr / dpr); // render px
    u.olMat.uniforms.uPPR.value = devPxPerRad() * pr / dpr;
    const on = op > 0.01;
    if (u._olOn !== on) { u._olOn = on; for (const o of u.olMeshes) for (const c of o.children) if (c.userData.isOutline) c.visible = on; }
  }
  const speckList = [];
  const speckGeo = new THREE.BufferGeometry();
  speckGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SPECK_N * 3), 3));
  speckGeo.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(SPECK_N), 1));
  speckGeo.setAttribute("aCol", new THREE.BufferAttribute(new Float32Array(SPECK_N * 4), 4));
  speckGeo.setDrawRange(0, 0);
  const speckMat = new THREE.ShaderMaterial({
    vertexShader: "attribute float aSize; attribute vec4 aCol; varying vec4 vC; void main(){ vC = aCol; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = aSize; }",
    // round, soft-edged: flat core to r≈0.35 then a smooth falloff to the rim
    fragmentShader: "varying vec4 vC; void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; float a = vC.a * (1.0 - smoothstep(0.35, 1.0, r)); if (a < 0.004) discard; gl_FragColor = vec4(vC.rgb, a);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}",
    depthTest: true, depthWrite: false, transparent: true,
  });
  const specks = new THREE.Points(speckGeo, speckMat);
  specks.frustumCulled = false;
  specks.renderOrder = -1; // first of the transparent pass: clouds and smoke blend over the dots
  scene.add(specks);
  // 1.4.1: sun glint on distant 109s as they roll — a separate additive point laid over the dark dot (the dot itself
  // is never lightened, so it can't vanish against the sky the way the 1.3.8 dot glint did)
  const GL_N = 64, glGeo = new THREE.BufferGeometry();
  glGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(GL_N * 3), 3));
  glGeo.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(GL_N), 1));
  glGeo.setAttribute("aCol", new THREE.BufferAttribute(new Float32Array(GL_N * 4), 4));
  glGeo.setDrawRange(0, 0);
  const glMat = new THREE.ShaderMaterial({
    vertexShader: "attribute float aSize; attribute vec4 aCol; varying vec4 vC; void main(){ vC = aCol; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = aSize; }",
    fragmentShader: "varying vec4 vC; void main(){ vec2 q = gl_PointCoord - 0.5; float r = length(q) * 2.0; float core = exp(-r * r * 9.0); float star = exp(-abs(q.x) * 40.0) * exp(-abs(q.y) * 5.0) + exp(-abs(q.y) * 40.0) * exp(-abs(q.x) * 5.0); float a = vC.a * (core + 0.35 * star) * (1.0 - smoothstep(0.8, 1.0, r)); if (a < 0.004) discard; gl_FragColor = vec4(vC.rgb * a, a);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}",
    depthTest: true, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending,
  });
  const glints = new THREE.Points(glGeo, glMat); glints.frustumCulled = false; glints.renderOrder = 0; scene.add(glints);
  const glPrev = new Map(); const glStats = { n: 0, max: 0 };
  const _hz = new THREE.Color();
  const speckStats = [];
  // ink of the soft profile relative to a hard disc of the same size (∫ profile over the disc)
  const SOFT_INK = (() => { let s = 0, n = 0; for (let i = 0; i < 200; i++) { const r = (i + 0.5) / 200; const t = Math.min(1, Math.max(0, (r - 0.35) / 0.65)); s += (1 - t * t * (3 - 2 * t)) * r; n += r; } return s / n; })();
  function eqDiam(e, base, d) { // equivalent-area disc diameter (u) of this fighter as seen from the camera now
    const A = fighterAreas(e.type);
    if (!A || e.hx == null || e.ux == null) return DOT_EQ * base / 1.3;
    const lx = (e.x - camera.position.x) / d, ly = (e.y - camera.position.y) / d, lz = (e.z - camera.position.z) / d;
    const hx = e.hx, hy = e.hy, hz = e.hz, hl = Math.hypot(hx, hy, hz) || 1;
    const ux = e.ux, uy = e.uy, uz = e.uz;
    const sx = uy * hz - uz * hy, sy = uz * hx - ux * hz, sz = ux * hy - uy * hx, sl = Math.hypot(sx, sy, sz) || 1;
    const area = (A.side * Math.abs(lx * sx + ly * sy + lz * sz) / sl + A.top * Math.abs(lx * ux + ly * uy + lz * uz) + A.front * Math.abs(lx * hx + ly * hy + lz * hz) / hl) * base * base;
    return 2 * Math.sqrt(area / Math.PI);
  }
  function dotFor(d, base, e) {
    const ppr = devPxPerRad();
    const trueDev = (e ? eqDiam(e, base, d) : DOT_EQ * base / 1.3) / d * ppr;
    const D = Math.max(DOT_FLOOR, trueDev);
    const a = Math.min(1, (trueDev / DOT_FLOOR) ** 2);
    return { trueDev, D, a };
  }
  function updateSpecks(opts) {
    const pos = speckGeo.attributes.position.array, sz = speckGeo.attributes.aSize.array, col = speckGeo.attributes.aCol.array;
    const pr = renderer.getPixelRatio(), dpr = window.devicePixelRatio || 1;
    _hz.copy(scene.fog ? scene.fog.color : SKY_HORIZON).convertSRGBToLinear();
    const t = pnow() * 0.001;
    const sd = skyU.uSun.value;
    let n = 0;
    speckStats.length = 0;
    for (let i = 0; i < speckList.length && n < SPECK_N; i += 3) {
      const e = speckList[i], d = speckList[i + 1], wDot = speckList[i + 2];
      if (d > SPECK_MAX) continue;
      const base = e.type === "190" ? 1.4 : e.type === "110" ? 1.6 : 1.3;
      const dot = dotFor(d, base, e);
      // render-px sprite: big enough that the soft disc is really round; alpha compensates so the
      // integrated darkness equals a hard dot of diameter D·a^(1/2)
      const want = dot.D * pr / dpr;
      const S = Math.max(4.0, want / Math.sqrt(SOFT_INK)); // ≥4 render px: the soft disc's coverage no longer depends on sub-pixel position (no far-dot twinkle)
      let alpha = dot.a * wDot * Math.min(1, (want * want) / (S * S * SOFT_INK));
      const ff = fogF(d);
      let r = 0.035, g = 0.037, b = 0.04;
      if (e.type === "p51") { r = 0.9; g = 0.92; b = 0.95; } // 1.5.2: friendly specks are silver, Germans stay dark
      // 1.3.9: no dot glint any more. A near-white flash on a 2 px dark dot made it vanish against the sky for a
      // few frames (read as a pop in the flyby); the 3D model keeps its real specular sun highlights.
      col[n * 4] = r + (_hz.r - r) * ff; col[n * 4 + 1] = g + (_hz.g - g) * ff; col[n * 4 + 2] = b + (_hz.b - b) * ff; col[n * 4 + 3] = alpha;
      pos[n * 3] = e.x; pos[n * 3 + 1] = e.y; pos[n * 3 + 2] = e.z;
      sz[n] = S;
      speckStats.push({ id: e.id, d: Math.round(d), devPx: +dot.D.toFixed(2), trueDev: +dot.trueDev.toFixed(2), a: +alpha.toFixed(3), wDot: +wDot.toFixed(3), fog: +ff.toFixed(3) });
      n++;
    }
    speckGeo.setDrawRange(0, n);
    speckGeo.attributes.position.needsUpdate = true; speckGeo.attributes.aSize.needsUpdate = true; speckGeo.attributes.aCol.needsUpdate = true;
    { // glints
      const gp = glGeo.attributes.position.array, gs = glGeo.attributes.aSize.array, gc = glGeo.attributes.aCol.array;
      let g = 0, gmax = 0; const now = t;
      const sx = sd.x, sy = sd.y, sz2 = sd.z;
      for (let i = 0; i < speckList.length && g < GL_N; i += 3) {
        const e = speckList[i], d = speckList[i + 1];
        if (d < 480 || d > SPECK_MAX || e.ux == null || e.id == null) continue;
        const cx = (camera.position.x - e.x) / d, cy = (camera.position.y - e.y) / d, cz = (camera.position.z - e.z) / d;
        let hx = sx + cx, hy = sy + cy, hz = sz2 + cz; const hl = Math.hypot(hx, hy, hz) || 1; hx /= hl; hy /= hl; hz /= hl;
        const nu = e.ux * hx + e.uy * hy + e.uz * hz;
        const spec = Math.pow(Math.max(0, nu), 90) + 0.5 * Math.pow(Math.max(0, -nu), 90); // wing tops (and the canopy) flash; the pale undersides less
        const pv = glPrev.get(e.id); let rate = 0;
        if (pv && now > pv.t) rate = Math.acos(Math.max(-1, Math.min(1, pv.x * e.ux + pv.y * e.uy + pv.z * e.uz))) / Math.max(0.016, now - pv.t);
        glPrev.set(e.id, { x: e.ux, y: e.uy, z: e.uz, t: now });
        const k = spec * Math.min(1, 0.25 + rate * 0.7) * (1 - fogF(d) * 0.6);
        if (k < 0.04) continue;
        gmax = Math.max(gmax, k);
        gp[g * 3] = e.x; gp[g * 3 + 1] = e.y; gp[g * 3 + 2] = e.z;
        gs[g] = (7 + 9 * k) * pr / dpr;
        gc[g * 4] = 1.0; gc[g * 4 + 1] = 0.94; gc[g * 4 + 2] = 0.8; gc[g * 4 + 3] = Math.min(1, k * 1.4);
        g++;
      }
      if (glPrev.size > 200) glPrev.clear();
      glGeo.setDrawRange(0, g); glStats.n = g; glStats.max = +gmax.toFixed(3);
      glGeo.attributes.position.needsUpdate = true; glGeo.attributes.aSize.needsUpdate = true; glGeo.attributes.aCol.needsUpdate = true;
    }
    speckList.length = 0;
  }
  const slotOf = new Map();
  const slotUsed = new Array(64).fill(false);
  function sync(enemiesArr, gunnerState, opts = {}) {
    const shake = gunnerState.shake || 0;
    const recoil = gunnerState.recoil || 0;
    // Cycle 136: MotA-hard fire shake on the GL camera
    const sx = (Math.sin(pnow() * 0.097) * 0.095 + Math.sin(pnow() * 0.171) * 0.048) * shake;
    const sy = (Math.cos(pnow() * 0.113) * 0.072 + Math.sin(pnow() * 0.203) * 0.038) * shake;
    const FALL = opts.fall;
    if (FALL && FALL.eye) camera.position.set(FALL.eye.x + sx, FALL.eye.y + sy, FALL.eye.z);
    else {
      const se = opts.stationEye || { x: 0, y: 0, z: 0 };
      camera.position.set(CAM.x + se.x + sx + (gunnerState.kx || 0), CAM.y + se.y + sy + (gunnerState.ky || 0) + recoil * 0.07 + (gunnerState.lift || 0), CAM.z + se.z); // 1.6.1: station eye (top / tail)
    }
    _lift = FALL ? 0 : (gunnerState.lift || 0); _liftP = FALL ? 0 : (gunnerState.liftP || 0);
    const FC = window.__FG_FREECAM; // test hook only: {x,y,z,yaw,pitch} free camera for stills
    if (FC) camera.position.set(FC.x, FC.y, FC.z);
    const yaw = FC ? FC.yaw : gunnerState.yaw;
    const pitch = FC ? FC.pitch : gunnerState.pitch + (FALL ? 0 : (gunnerState.liftP || 0)); // the nose comes up a touch as the load goes
    const look = new THREE.Vector3(
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(yaw) * Math.cos(pitch)
    );
    if (opts.fov && Math.abs(camera.fov - opts.fov) > 0.01) {
      camera.fov = opts.fov;
      camera.updateProjectionMatrix();
    }
    // 1.3.5: explicit yaw/pitch Euler (YXZ) — no lookAt/up-vector singularity at ±90° pitch;
    // same basis as game.js lookBasis (forward = look, right = (−cos yaw, 0, sin yaw)).
    void look;
    camera.rotation.order = "YXZ";
    camera.rotation.set(pitch, yaw + Math.PI, 0);
    // 1.3.3: airframe roll about the longitudinal axis (world +Z); own B-17 rolls with it
    if (FALL && FALL.phase === "fall" && FALL.ship) { // riding the spinning ship down
      _rollQ.setFromEuler(_camFallE.set(FALL.ship.pd || 0, FALL.ship.yaw || 0, -(FALL.ship.roll || 0), "YXZ"));
    } else _rollQ.setFromAxisAngle(_zAxis, -(opts.roll || 0));
    camera.quaternion.premultiply(_rollQ);
    if (ownShip) updateOwnShip(opts);
    { // 1.3.8: under our own canopy
      const inChute = !!(FALL && FALL.phase === "chute");
      CR.chuteRich = inChute; // 1.6.1: richer crash/ground FX only in parachute view
      const atTail = (opts.station === "tail");
      CR.tailDim = atTail;
      // 1.6.1 MASTER: Cheyenne look is the 2D overlay; hide Sperry mount + old 3D tunnel frame at tail
      turretAnchor.visible = !inChute && !window.__FG_FREECAM && !atTail;
      updateCage(pitch, inChute || !!window.__FG_FREECAM || atTail); if (window.__FG_FREECAM) arch.visible = false;
      sightBox.visible = !inChute && !window.__FG_FREECAM && !atTail;
      if (tailFrame) tailFrame.visible = atTail && !inChute && !window.__FG_FREECAM; // 3D twin .50s
      // 1.6.1: at the Cheyenne opening, hide extreme aft tip skin once tagged so we look OUT (not into a tunnel)
      if (ownShip) {
        if (!ownShip.userData._tailTagged) {
          ownShip.userData._tailTagged = true;
          ownShip.traverse((o) => {
            if (!o.isMesh || !o.geometry || o.userData.part || o.userData.noHit) return;
            if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
            const cz = o.geometry.boundingSphere.center.z + o.position.z;
            if (cz < -12.9) o.userData._tailHide = true; // clear Cheyenne opening (eye aft of rudder)
          });
        }
        ownShip.traverse((o) => { if (o.userData._tailHide) o.visible = !atTail; });
      }
      ownChute.visible = inChute;
      if (inChute) {
        ownChute.position.copy(camera.position);
        ownChute.rotation.set(0, 0, -(FALL.sway || 0) * 0.8);
        { const dv = camera.getWorldDirection(_legDir); const hd = Math.atan2(dv.x, dv.z); const L = ownChute.userData.legs; let dd = hd - L.rotation.y; dd = Math.atan2(Math.sin(dd), Math.cos(dd)); L.rotation.y += dd * Math.min(1, 0.06 + Math.abs(dd) * 0.08); }
        const open = (FALL.chuteT || 0) > 1.3;
        ownChute.userData.dome.visible = open; ownChute.userData.streamer.visible = !open && (FALL.chuteT || 0) > 0.5;
        if (open) { const k = Math.min(1, ((FALL.chuteT || 0) - 1.3) / 1.0); ownChute.userData.dome.scale.set(2.9 * (0.25 + 0.75 * k), 1.9 * (1.6 - 0.6 * k), 2.9 * (0.25 + 0.75 * k)); }
      }
    }

    // 1.3.2: whole mount only trembles slightly; per-barrel recoil is in updateGuns
    turretAnchor.position.z = -0.05 + recoil * 0.015;
    turretAnchor.position.y = -0.02 - recoil * 0.006;
    turretAnchor.rotation.x = -recoil * 0.004;
    turretAnchor.rotation.z = sx * 0.25;

    const muzzle = opts.muzzle || 0;
    // warm interior kick on fire (subtle — the flash itself is at the barrel tips)
    muzzleStrobe.intensity = muzzle * 1.6; // 1.4.0: 6 → 1.6 (it lit the whole jacket + sight box orange)
    turretFill.intensity = 0.45 + muzzle * 0.7; // 1.4.0: 3 → 0.7 (the kick turned the sill and sight box orange)
    turretFill.color.setHex(muzzle > 0.08 ? 0xffa060 : 0xffe8c8);
    updateGuns(opts);

    // Rotate sky with yaw so equirect feels locked to world… actually sky sphere is world-fixed — good.
    // Equirect background doesn't rotate with camera look — Three.js scene.background equirect is view-dependent correctly.

    syncMission(opts);

    // 1.3.2: each bandit keeps its own mesh for life (no mesh reshuffle → no attitude snaps)
    _mzList.length = 0;
    const live = new Set();
    const shown = (e) => e.alive || e.flash > 0 || (e.wreckT || 0) > 0;
    for (const e of enemiesArr) {
      if (!shown(e)) continue;
      if (e.id) live.add(e.id);
    }
    for (const [id, si] of slotOf) if (!live.has(id)) { slotOf.delete(id); slotUsed[si] = false; }
    for (const e of enemiesArr) {
      if (!shown(e)) continue;
      let si = slotOf.get(e.id);
      if (si == null) {
        si = slotUsed.indexOf(false);
        if (si < 0 || si >= fighterPool.length) continue;
        slotUsed[si] = true;
        slotOf.set(e.id, si);
        if (fighterPool[si].mesh) { const fm = fighterPool[si].mesh; fm.userData._q = null; for (const d of fm.userData.decals || []) fm.remove(d); fm.userData.decals = []; }
      }
      const slot = fighterPool[si];
      if (!slot.mesh) continue;
      ensureKind(slot, e.type || "109");
      const mesh = slot.mesh;
      mesh.visible = true;
      mesh.position.set(e.x, e.y, e.z);
      // 1.3.3: damage ladder — hits: sparks (2D) → smoke trail → fire → kill: blast + debris,
      // burning wreck spins into the ground trailing black smoke.
      if (!slot.fire) {
        slot.fire = new THREE.Sprite(new THREE.SpriteMaterial({ map: fireTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
        slot.fire.visible = false;
        scene.add(slot.fire);
      }
      const hpFrac = e.maxHp ? Math.max(0, e.hp) / e.maxHp : 1;
      if (slot.wasAlive && !e.alive) spawnKillFx(mesh.position, e);
      slot.wasAlive = e.alive;
      if (e.alive && e.id) { _conActive.add(e.id); conEmitFighter(e, hpFrac, _conDtLast, pnow()); }
      const onFire = !e.alive || hpFrac <= 0.4;
      slot.fire.visible = onFire;
      if (onFire) {
        slot.fire.position.copy(mesh.position);
        const fs = (e.alive ? 3.0 : 5.5) * (0.75 + Math.random() * 0.5);
        slot.fire.scale.set(fs, fs, 1);
        slot.fire.material.opacity = 0.75 + Math.random() * 0.25;
      }
      slot.smokeT = (slot.smokeT || 0) - 0.016;
      // 1.4.0: continuous smoke trails (ribbons) — light grey when hit, thick black when burning / going down
      if (!e.alive) {
        if (slot.smokeT <= 0) { ribbonEmit("f" + e.id, mesh.position, { w0: 1.3, w1: 10, life: 3.6, a: 0.78, col: [0.08, 0.075, 0.07] }); if (Math.random() < 0.25) emitSmoke(mesh.position, true, true, { life: 3.0, s0: 2.2, s1: 9, a: 0.5 }); slot.smokeT = 0.035; }
      } else if (hpFrac <= 0.4) {
        if (slot.smokeT <= 0) { ribbonEmit("f" + e.id, mesh.position, { w0: 0.9, w1: 7, life: 2.8, a: 0.62, col: [0.14, 0.135, 0.13] }); slot.smokeT = 0.04; }
      } else if (hpFrac < 0.99) {
        if (slot.smokeT <= 0) { ribbonEmit("f" + e.id, mesh.position, { w0: 0.55, w1: 4.5, life: 2.2, a: 0.42, col: [0.62, 0.62, 0.6] }); slot.smokeT = 0.045; }
      }
      const dist = Math.max(1, mesh.position.distanceTo(camera.position));
      // 1.3.6: true scale at every range (9.9 m span) — no far boost. Beyond ~1.5 km a live 109 is a
      // depth-tested speck (see updateSpecks), so it hides behind our own ship, other B-17s and clouds.
      const base = e.type === "190" ? 1.4 : e.type === "110" ? 1.6 : 1.3;
      const wMesh = e.alive ? lodMeshW(dist) : 1;
      if (wMesh <= 0.001) { mesh.visible = false; if (slot.trail) slot.trail.line.visible = false; speckList.push(e, dist, 1); continue; }
      if (wMesh < 0.999) speckList.push(e, dist, 1 - wMesh);
      const spanDev = SPAN * (base / 1.3) / dist * devPxPerRad();
      const sizeK = Math.min(1, Math.max(0, (25 - spanDev) / 13));
      applyFighterLook(mesh, wMesh, sizeK, dist);
      slot.lod = { d: Math.round(dist), wMesh: +wMesh.toFixed(3), spanDev: +spanDev.toFixed(1), sizeK: +sizeK.toFixed(2) };
      mesh.scale.setScalar(base);
      // Attitude straight from the flight model: nose = h (the air/ground velocity direction),
      // canopy = u (the lift vector, so the bank is the real coordinated bank). No smoothing lag.
      if (e.alive && e.ux != null) {
        _fw.set(e.hx, e.hy, e.hz).normalize();
        _up.set(e.ux, e.uy, e.uz);
        _up.addScaledVector(_fw, -_up.dot(_fw)).normalize();
        _rt.crossVectors(_up, _fw); // up × fwd = +X side (port)
        // the 109 GLB's nose is local −Z: local X → starboard (−port), Y → up, Z → −nose
        _m4.makeBasis(_rt.negate(), _up, _fw.clone().negate());
        mesh.quaternion.setFromRotationMatrix(_m4);
        mesh.userData._q = mesh.quaternion.clone();
        mesh.userData._fwd = _fw.clone();
      } else {
        const vel = e.hx != null ? new THREE.Vector3(e.hx, e.hy, e.hz) : new THREE.Vector3(e.vx || 0, e.vy || 0, e.vz || 0);
        let forward;
        if (vel.lengthSq() > 0.01) forward = vel.normalize();
        else forward = mesh.userData._fwd ? mesh.userData._fwd.clone() : new THREE.Vector3(0, -0.25, -1).normalize();
        mesh.userData._fwd = forward.clone();
        const worldUp = new THREE.Vector3(0, 1, 0);
        let right = new THREE.Vector3().crossVectors(worldUp, forward);
        if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
        right.normalize();
        const up = new THREE.Vector3().crossVectors(forward, right).normalize();
        const m = new THREE.Matrix4().makeBasis(right.clone().negate(), up, forward.clone().negate());
        const targetQ = new THREE.Quaternion().setFromRotationMatrix(m);
        targetQ.premultiply(new THREE.Quaternion().setFromAxisAngle(forward, -(e.bank || 0)));
        if (!mesh.userData._q) mesh.userData._q = targetQ.clone();
        mesh.userData._q.slerp(targetQ, 0.25);
        mesh.quaternion.copy(mesh.userData._q);
      }
      if (e.alive && e.mf > 0 && dist < 2600) _mzList.push(e, mesh, slot.kind, dist);
      if (!e.alive) { // spinning wreck
        slot.spin = (slot.spin || 0) + 0.016 * 4;
        mesh.quaternion.multiply(_spinQ.setFromAxisAngle(_zAxis, slot.spin));
      } else slot.spin = 0;
      // Live contrail from sim trail (or velocity fallback)
      const tr = slot.trail;
      if (tr) {
        const pts = (e.trail && e.trail.length > 1) ? e.trail : null;
        const arr = tr.pos;
        let count = 0;
        if (pts) {
          const start = Math.max(0, pts.length - tr.n);
          for (let i = start; i < pts.length; i++) {
            arr[count * 3] = pts[i].x;
            arr[count * 3 + 1] = pts[i].y;
            arr[count * 3 + 2] = pts[i].z;
            count++;
          }
        } else if (false) {
          const vx = e.vx || 0, vy = e.vy || 0, vz = e.vz || 0;
          for (let i = 0; i < 8; i++) {
            const t = i * 0.55;
            arr[i * 3] = e.x - vx * t;
            arr[i * 3 + 1] = e.y - vy * t;
            arr[i * 3 + 2] = e.z - vz * t;
            count++;
          }
        }
        tr.line.geometry.attributes.position.needsUpdate = true;
        tr.line.geometry.setDrawRange(0, count);
        // 1.3.2: faint, and only for distant fighters (no long lines across the glass)
        const far = Math.max(0, Math.min(1, (dist - 160) / 120));
        tr.line.material.opacity = 0.12 * far;
        tr.line.visible = false; // 1.5.3: replaced by the ribbon contrails (updateFighterTrails)
      }

    }
    for (let idx = 0; idx < fighterPool.length; idx++) {
      if (slotUsed[idx]) continue;
      if (fighterPool[idx].mesh) fighterPool[idx].mesh.visible = false;
      if (fighterPool[idx].trail) fighterPool[idx].trail.line.visible = false;
      if (fighterPool[idx].fire) fighterPool[idx].fire.visible = false;
      fighterPool[idx].wasAlive = false;
    }
    muzzleFlashes(_mzList);
    updateSpecks(opts);
    updateDebris();
  }

  // 1.3.7: TRACERS IN 3D — every tracer (ours, the other gunners', the 109s') is a pair of
  // camera-facing quads (glow + core) with a constant on-screen width, depth-tested against the
  // scene so our own airframe, the other Fortresses and the fighters hide what is behind them.
  // Drawn additively after the clouds (renderOrder), so a stream in front of a cloud still shows.
  const TR_MAX = 1600;
  const trPos = new Float32Array(TR_MAX * 8 * 3), trCol = new Float32Array(TR_MAX * 8 * 4);
  const trGeo = new THREE.BufferGeometry();
  trGeo.setAttribute("position", new THREE.BufferAttribute(trPos, 3).setUsage(THREE.DynamicDrawUsage));
  trGeo.setAttribute("aCol", new THREE.BufferAttribute(trCol, 4).setUsage(THREE.DynamicDrawUsage));
  { const idx = new Uint32Array(TR_MAX * 12); for (let i = 0; i < TR_MAX * 2; i++) { const v = i * 4, o = i * 6; idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2; idx[o + 3] = v + 1; idx[o + 4] = v + 3; idx[o + 5] = v + 2; } trGeo.setIndex(new THREE.BufferAttribute(idx, 1)); }
  trGeo.setDrawRange(0, 0);
  const trMat = new THREE.ShaderMaterial({
    vertexShader: "attribute vec4 aCol; varying vec4 vC; void main(){ vC = aCol; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: "varying vec4 vC; void main(){ gl_FragColor = vC; }",
    // 1.3.7: normal (not additive) blending — additive washed every tracer to white against the bright sky
    transparent: true, depthTest: true, depthWrite: false, blending: THREE.NormalBlending, side: THREE.DoubleSide,
  });
  const trMesh = new THREE.Mesh(trGeo, trMat);
  trMesh.frustumCulled = false; trMesh.renderOrder = 50;
  scene.add(trMesh);
  // kinds: 0 our guns, 1 other B-17 gunners, 2 Bf 109 — [core rgb, glow rgb, core px, glow px, core a, glow a, tail keep]
  // 1.5.1: the player's 1.5.0 tracer is the reference. EVERY tracer (own guns, box gunners, 109s, 190s, P-51s) uses the same look.
  // 1.6.0: tracer looks re-measured from the DCS reference clip (ffmpeg frames; 21 streaks): thin hot streak, length/width 5-17 : 1, ~3-5 px thick on a 1430 px frame, flat brightness head-to-tail (no taper), +65 luma core over a +45 halo, near-white core in a saturated rim.
  // Kind 0 (the PLAYER's own guns) is deliberately UNCHANGED. 1 = AI B-17 gunners: slightly more ORANGE than the 1.5.9 yellow; 2 = Bf 109 and 3 = Fw 190: RED; 4 = P-51: ORANGE.
  const TR_KIND = [
    [[1.0, 0.88, 0.46], [1.0, 0.62, 0.14], 1.0, 2.6, 0.9, 0.26, 0.4], // own guns (UNCHANGED since 1.5.1)
    [[1.0, 0.78, 0.28], [1.0, 0.44, 0.04], 1.0, 2.7, 0.92, 0.32, 0.4], // AI box gunners: more orange than the player's yellow
    [[1.0, 0.52, 0.44], [1.0, 0.07, 0.05], 1.1, 3.0, 0.95, 0.42, 0.4], // Bf 109: red (hot white-pink core, red rim)
    [[1.0, 0.52, 0.44], [1.0, 0.07, 0.05], 1.25, 3.2, 0.95, 0.46, 0.4], // Fw 190: red, slightly bolder
    [[1.0, 0.64, 0.24], [1.0, 0.30, 0.02], 1.2, 3.1, 0.95, 0.40, 0.4], // P-51: orange
  ];
  let trBuf = null, trN = 0;
  const _tf = new THREE.Vector3(), _tc = new THREE.Vector3();
  const trStats = { drawn: 0 };
  // 1.3.9: persistence smear — a tracer is a light that the eye integrates over ~60 ms. When the view
  // swings, the part of that trail already "painted" moved with the old view: rotate each tail about the
  // eye by the view rotation of the last TR_BLUR seconds (low-passed, so fire-shake jitter averages out).
  const TR_BLUR = 0.06;
  const TR_FADE0 = 250, TR_FADEL = 1262; // 1.5.5 distance fade: exp(-(d-250)/1262) -> 25 % at 2000 u
  const TR_MINPX = 2.2; // CSS px: minimum on-screen streak length (end-on rounds read as dots)
  const _trQ = new THREE.Quaternion(), _trQprev = new THREE.Quaternion(), _trW = new THREE.Vector3(), _trDq = new THREE.Quaternion(), _trV = new THREE.Vector3();
  let _trT = 0, _trHave = false;
  function trSmearRot() {
    const now = window.__FG_SIMT || 0;
    camera.getWorldQuaternion(_trQ);
    const dt = Math.min(0.1, now - _trT);
    _trT = now;
    if (_trHave && dt > 1e-4) {
      // world-frame rotation from the previous camera to the current one → angular velocity (rad/s)
      _trDq.copy(_trQ).multiply(_trQprev.invert());
      if (_trDq.w < 0) { _trDq.x = -_trDq.x; _trDq.y = -_trDq.y; _trDq.z = -_trDq.z; _trDq.w = -_trDq.w; }
      const ang = 2 * Math.acos(Math.min(1, _trDq.w)), sn = Math.sqrt(Math.max(1e-12, 1 - _trDq.w * _trDq.w));
      _trV.set(_trDq.x / sn, _trDq.y / sn, _trDq.z / sn).multiplyScalar(ang < 1e-6 ? 0 : ang / dt);
      _trW.lerp(_trV, 0.25);
    }
    _trQprev.copy(_trQ); _trHave = true;
    const w = _trW.length(), a = Math.min(0.35, w * TR_BLUR); // cap ≈ 20°
    trStats.viewRateDeg = +(w * 180 / Math.PI).toFixed(1);
    // 1.4.1: NO SMEAR. Rotating each tail about the eye by the view rate made every streak bend and distort
    // while panning (the "painted" tail followed the old view). A tracer is a world-space segment along its own
    // ballistic velocity — completely independent of where the camera points or how fast it turns.
    if (!window.__FG_TR_SMEAR) return null;
    if (a < 1e-5) return null;
    // tail painted TR_BLUR ago sits where the old view put it: rotate by −ω·τ... expressed in the world: the
    // point that is now at u was seen τ ago at camera-local R_prev⁻¹u, i.e. it appears now at R_now R_prev⁻¹ u
    return _trDq.setFromAxisAngle(_trV.copy(_trW).multiplyScalar(1 / w), a);
  }
  function buildTracers() {
    let n = 0;
    const smear = trSmearRot();
    trStats.smearDeg = smear ? +(2 * Math.acos(Math.min(1, smear.w)) * 180 / Math.PI).toFixed(2) : 0;
    if (trBuf && trN) {
      camera.getWorldPosition(_tc); camera.getWorldDirection(_tf);
      const cx = _tc.x, cy = _tc.y, cz = _tc.z, fx = _tf.x, fy = _tf.y, fz = _tf.z;
      const pxPerRad = (window.innerHeight || 400) / (2 * Math.tan(camera.fov * Math.PI / 360));
      const NEAR = 0.6;
      for (let i = 0; i < trN && n < TR_MAX * 2; i++) {
        const o = i * 8;
        let hx = trBuf[o], hy = trBuf[o + 1], hz = trBuf[o + 2], tx = trBuf[o + 3], ty = trBuf[o + 4], tz = trBuf[o + 5];
        const K = TR_KIND[trBuf[o + 6] | 0] || TR_KIND[1], A = trBuf[o + 7];
        if (smear) { _trV.set(tx - _tc.x, ty - _tc.y, tz - _tc.z).applyQuaternion(smear); tx = _tc.x + _trV.x; ty = _tc.y + _trV.y; tz = _tc.z + _trV.z; }
        let dh = (hx - cx) * fx + (hy - cy) * fy + (hz - cz) * fz, dtl = (tx - cx) * fx + (ty - cy) * fy + (tz - cz) * fz;
        if (dh < NEAR && dtl < NEAR) continue;
        if (dh < NEAR) { const k = (NEAR - dh) / (dtl - dh); hx += (tx - hx) * k; hy += (ty - hy) * k; hz += (tz - hz) * k; dh = NEAR; }
        else if (dtl < NEAR) { const k = (NEAR - dtl) / (dh - dtl); tx += (hx - tx) * k; ty += (hy - ty) * k; tz += (hz - tz) * k; dtl = NEAR; }
        // 1.3.9: a round seen end-on (our own stream from behind, a 109's stream coming at us) projects to
        // ~0 px and vanished; the burning tracer base faces the gunner, so it must read as a bright dot.
        // Give every streak at least TR_MINPX of screen length, laid along its (tiny) screen motion.
        {
          const hl = Math.hypot(hx - cx, hy - cy, hz - cz) || 1, tl = Math.hypot(tx - cx, ty - cy, tz - cz) || 1;
          let ux = (hx - cx) / hl - (tx - cx) / tl, uy = (hy - cy) / hl - (ty - cy) / tl, uz = (hz - cz) / hl - (tz - cz) / tl;
          const ul = Math.hypot(ux, uy, uz), sep = ul * pxPerRad;
          if (sep < TR_MINPX) {
            if (ul > 1e-9) { ux /= ul; uy /= ul; uz /= ul; }
            else { const rx = -(hz - cz), rz = hx - cx, rl = Math.hypot(rx, rz) || 1; ux = rx / rl; uy = 0; uz = rz / rl; } // horizontal ⟂ view ray
            const L = TR_MINPX / pxPerRad * hl;
            tx = hx - ux * L; ty = hy - uy * L; tz = hz - uz * L;
            dtl = (tx - cx) * fx + (ty - cy) * fy + (tz - cz) * fz;
          }
        }
        const sx = hx - tx, sy = hy - ty, sz = hz - tz;
        const mx = (hx + tx) * 0.5 - cx, my = (hy + ty) * 0.5 - cy, mz = (hz + tz) * 0.5 - cz;
        let px = sy * mz - sz * my, py = sz * mx - sx * mz, pz = sx * my - sy * mx;
        const pl = Math.hypot(px, py, pz); if (pl < 1e-6) { px = 0; py = 1; pz = 0; } else { px /= pl; py /= pl; pz /= pl; }
        // 1.5.5: DISTANCE FADE for every tracer kind (own, box gunners, 109/190, P-51): full strength inside ~250 u, ~25 % alpha by 2000 u (floor 8 %),
        // and the streak also thins (width x 0.55..1) so far tracers read as faint hairlines instead of bright pins.
        const dMid = Math.hypot(mx, my, mz), isOwnK = (trBuf[o + 6] | 0) === 0;
        // 1.5.8: AI-fighter / gunner tracers thin AND fade much faster with range (faint past ~1 km, a hairline at several km); the player's own guns (kind 0) keep the 1.5.5 curve
        let dFade, wFade;
        if (dMid <= TR_FADE0 || window.__FG_NOTRFADE) { dFade = 1; wFade = 1; }
        else if (isOwnK) { dFade = Math.max(0.08, Math.exp(-(dMid - TR_FADE0) / TR_FADEL)); wFade = 0.55 + 0.45 * dFade; }
        else { const e2 = Math.exp(-(dMid - TR_FADE0) / 1100); dFade = Math.max(0.08, e2); wFade = 0.28 + 0.72 * e2; } // __FG_NOTRFADE disables (A/B stills)
        for (let layer = 0; layer < 2; layer++) {
          const wpx = (layer ? K[2] : K[3]) * wFade, rgb = layer ? K[0] : K[1], a = (layer ? K[4] : K[5]) * A * dFade, keep = layer ? K[6] : 0;
          const wh = 0.5 * wpx * dh / pxPerRad, wt = 0.5 * wpx * dtl / pxPerRad;
          const v = n * 4, p3 = v * 3, c4 = v * 4;
          trPos[p3] = hx - px * wh; trPos[p3 + 1] = hy - py * wh; trPos[p3 + 2] = hz - pz * wh;
          trPos[p3 + 3] = hx + px * wh; trPos[p3 + 4] = hy + py * wh; trPos[p3 + 5] = hz + pz * wh;
          trPos[p3 + 6] = tx - px * wt; trPos[p3 + 7] = ty - py * wt; trPos[p3 + 8] = tz - pz * wt;
          trPos[p3 + 9] = tx + px * wt; trPos[p3 + 10] = ty + py * wt; trPos[p3 + 11] = tz + pz * wt;
          for (let k = 0; k < 4; k++) { const q = c4 + k * 4; trCol[q] = rgb[0]; trCol[q + 1] = rgb[1]; trCol[q + 2] = rgb[2]; trCol[q + 3] = k < 2 ? a : a * keep; }
          n++;
        }
      }
    }
    trStats.drawn = n >> 1;
    trGeo.setDrawRange(0, n * 6);
    trGeo.attributes.position.needsUpdate = true; trGeo.attributes.aCol.needsUpdate = true;
  }
  function setTracers(buf, count) { trBuf = buf; trN = count; }

  // 1.5.2 FLICKER FIX (root cause: ONE depth range for everything — near 0.05 / far 70,000 gives a 24-bit depth buffer ~2 u of
  // resolution at the 1,400 u ground, so the town's roads/rails/roofs/yard/shadow layers (all < 1 u apart) z-fought and crawled
  // frame to frame). The sky + Earth (ground, town, bomb smoke) now draw first in their own pass with near 30 / far 80,000
  // (≈400× finer at the ground), then depth is cleared and the aircraft/clouds/flak draw with near 0.05 / far 14,000.
  const FARL = 2; let _farTag = 0, _frameN = 0;
  function tagFar() { earth.traverse((o) => { o.layers.set(FARL); }); skyMesh.layers.set(FARL); for (const L of [hemi, sun, fill, key2]) L.layers.enable(FARL); }

  function render() {
    prWatch();
    buildTracers();
    if (!window.__FG_NO2PASS) {
      if (_frameN++ % 30 === 0) tagFar();
      camera.near = 30; camera.far = 320000; camera.updateProjectionMatrix();
      camera.layers.set(FARL);
      renderer.render(scene, camera);
      renderer.autoClear = false;
      renderer.clearDepth();
      camera.near = 0.05; camera.far = 30000; camera.updateProjectionMatrix();
      camera.layers.set(0);
      renderer.render(scene, camera);
      renderer.clearDepth();
      camera.layers.set(OVL);
      renderer.render(scene, camera);
      camera.layers.set(0);
      renderer.autoClear = true;
      camera.far = 70000; camera.updateProjectionMatrix();
      return;
    }
    camera.layers.set(0);
    renderer.render(scene, camera);
    // 1.4.0: the turret (guns, sight box, sill, dome frame) in its own pass on top of the airframe
    renderer.autoClear = false;
    renderer.clearDepth();
    camera.layers.set(OVL);
    renderer.render(scene, camera);
    camera.layers.set(0);
    renderer.autoClear = true;
  }

  ready = true;
  const loading = loadModels();

  return {
    get _smokeDbg() { const v = smokePool.filter((p) => p.life > 0); return { n: v.length, sample: v.slice(0, 3).map((p) => ({ x: +p.sp.position.x.toFixed(1), y: +p.sp.position.y.toFixed(1), z: +p.sp.position.z.toFixed(1), o: +p.sp.material.opacity.toFixed(2), s: +p.sp.scale.x.toFixed(2) })) }; },
    get ready() {
      return ready;
    },
    get modelsReady() {
      return modelsReady;
    },
    resize,
    sync,
    render,
    applySkyTexture,
    loading,
    renderer,
    scene,
    camera,
    muzzles: muzzleOut,
    _gunGroups: gunGroups,
    b17Ortho, rayShip, addHole, addTear, clearDamage, rayFighter, addFighterHole, fighterBoundR, fighterDecalInfo, fighterMeshDump,
    decalInfo: (which) => { const g = shipGroup(which); if (!g) return []; g.updateMatrixWorld(true); return (g.userData.decals || []).map((m) => { const p = new THREE.Vector3(); m.getWorldPosition(p); const n = new THREE.Vector3(0, 0, 1).applyQuaternion(m.getWorldQuaternion(new THREE.Quaternion())); return { x: p.x, y: p.y, z: p.z, nx: n.x, ny: n.y, nz: n.z, s: m.scale.x }; }); },
    get flakStats() { return Object.assign({}, flakStats); },
    _ownShip: ownShip,
    _perfDbg: { macroTex, farmTex, ground, town, get walls() { return TS.walls; }, get roofs() { return TS.roofs; } },
    get speckStats() { return speckStats.slice(); },
    dropBombs,
    trailDump: (k) => { const c = conAnchors[k]; return c ? c.pts.map((p) => [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1), +p.age.toFixed(1)]) : null; },
    chuteMeshes: () => { const out = []; ownChute.traverse((o) => { if (o !== ownChute) out.push({ type: o.type, geo: o.geometry ? o.geometry.type : null, vis: o.visible && ownChute.visible, y: +o.position.y.toFixed(2) }); }); return out; },
    get conStats() { return Object.assign({}, conStats); },
    detPieces: () => { const o = []; for (let i = 0; i < friendlyPool.length; i++) { const g = friendlyPool[i]; for (const d of (g.userData.dets || [])) if (!d.userData.dead) { const q = d.position.clone().project(camera); o.push({ slot: i, kind: d.userData.kind, side: d.userData.side, x: d.position.x, y: d.position.y, z: d.position.z, sx: (q.x * 0.5 + 0.5) * innerWidth, sy: (-q.y * 0.5 + 0.5) * innerHeight, d: d.position.distanceTo(camera.position) }); } } return o; },
    projCam: (x, y, z) => { const q = new THREE.Vector3(x, y, z).project(camera); return { sx: (q.x * 0.5 + 0.5) * innerWidth, sy: (-q.y * 0.5 + 0.5) * innerHeight, z: q.z }; },
    crashFx: (x, z, size) => { crashImpact(new THREE.Vector3(x, groundWY(), z), size || 1, "hull"); detStats.crashed.hull++; },
    get decalStats() { return decalStats; }, decalDump() { const o = []; for (const g of [ownShip, ...friendlyPool]) { const L = (g.userData.decals || []).concat(g.userData.tears || []); if (!L.length) continue; g.updateMatrixWorld(true);
      o.push({ vis: g.visible, n: L.length, items: L.map((m) => { const bb = new THREE.Box3().setFromObject(m); const c = bb.getCenter(new THREE.Vector3()); return { v: m.visible, vc: m.geometry.attributes.position.count, x: +c.x.toFixed(2), y: +c.y.toFixed(2), z: +c.z.toFixed(2), sz: +bb.getSize(new THREE.Vector3()).length().toFixed(2) }; }) }); } return o; }, get detStats() { return JSON.parse(JSON.stringify(detStats)); }, get crashStats() { return Object.assign({ decals: Math.min(CR.nSc, CR.SC_N), sites: CR.sites.length, fire: CR.fire.filter((f) => f.life > 0).length, smoke: CR.smoke.filter((p) => p.life > 0).length }, CR.stats); }, groundWY,
    groundBurst: (u, v) => { bombBurst(TOWN_X + TOWN_S * u, TOWN_Z + TOWN_S * v, true); if (TS.nCr < 320) { _tp.set(u, 0.07, v); _tq.identity(); _ts.set(1.2, 1, 1.2); TS.craters.setMatrixAt(TS.nCr++, _tmpM.compose(_tp, _tq, _ts)); TS.craters.count = TS.nCr; TS.craters.instanceMatrix.needsUpdate = true; } },
    townGeom: { X: TOWN_X, Z: TOWN_Z, K: K_LAND, S: TOWN_S, g: BOMB_G, spacing: BOMB_SPACING, wy: CAM.y * (1 - EARTH_K) + EARTH_K * (GROUND_Y + 0.05) },
    townLayout: () => TL,
    townStrike,
    townReset,
    get bombStats() { return Object.assign({}, bombStats, { n: bombs.length, t0: bombs[0] ? +bombs[0].t.toFixed(2) : null, land: (bombStats.land || []).slice(-400) }); },
    bombPositions: () => bombs.filter((b) => b.t >= 0 && !b.landed).slice(0, 40).map((b) => ({ x: +(b._wx || 0).toFixed(1), y: +(b._wy || 0).toFixed(1), z: +(b._wz || 0).toFixed(1), t: +b.t.toFixed(2), y0: +b.y0.toFixed(1) })),

    get glintStats() { return { n: glStats.n, max: glStats.max }; },
    get aiAnchors() { // test hook (1.5.9): per AI ship that has detached pieces: owner (hull / piece key) + world position of every engine fire anchor
      const out = [];
      for (let i = 0; i < friendlyPool.length; i++) {
        const g = friendlyPool[i], ds = g.userData.dets; if (!ds || !ds.length) continue;
        const P = (o) => { o.updateWorldMatrix(true, false); const v = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld); return [+v.x.toFixed(1), +v.y.toFixed(1), +v.z.toFixed(1)]; };
        out.push({ i, hull: P(g), pieces: ds.map((d) => ({ kind: d.userData.kind, side: d.userData.side, dead: d.userData.dead, pos: P(d) })), eng: g.userData.engines.map((E) => ({ own: E.anchor.parent === g ? "hull" : (ds.find((d) => d === E.anchor.parent) ? "piece:" + E.anchor.parent.userData.kind + (E.anchor.parent.userData.side || "") : "other"), vis: E.fire.visible, pos: P(E.anchor) })) });
      }
      return out;
    },
    get ejDbg() { // test hook (1.5.9): active ejected cases / links with their screen position (px of the current viewport)
      const w = window.innerWidth, h = window.innerHeight, o = [];
      for (const p of ejPool) { if (p.life <= 0) continue; const v = p.m.position.clone().project(camera); o.push({ k: p.m.geometry === linkGeo ? "link" : "case", life: +p.life.toFixed(2), x: Math.round((v.x * 0.5 + 0.5) * w), y: Math.round((-v.y * 0.5 + 0.5) * h), z: +v.z.toFixed(3), d: +p.m.position.distanceTo(camera.position).toFixed(2) }); }
      return o;
    },
    get wreckAnchors() { // test hook (1.5.9): world position + owner of every wreck effect anchor on the player's ship
      const own = (o) => (o.parent === wreck.wing ? "wing" : o.parent === wreck.tail ? "tail" : o.parent === ownShip ? "ship" : "other");
      const P = (o) => { o.updateWorldMatrix(true, false); const v = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld); return [+v.x.toFixed(1), +v.y.toFixed(1), +v.z.toFixed(1)]; };
      const it = (o, vis) => ({ own: own(o), pos: P(o), vis: vis == null ? !!o.visible : vis });
      return { ship: P(ownShip), wing: wreck.wing ? P(wreck.wing) : null, tail: wreck.tail ? P(wreck.tail) : null, side: wreck.wingSide, fires: wreck.fires.map((f) => it(f)), srcs: wreck.srcs.map((f) => it(f, true)), engFire: ownEngines.map((E) => it(E.fire)), engSmoke: ownEngines.map((E) => it(E.smokeAt, true)), tailFire: it(ownTail.fire), tailSmoke: it(ownTail.smokeAt, true) };
    },
    get wreckStats() { return { puffs: wpStats.live, fires: wreck.fires.filter((f) => f.visible).length, tail: !!wreck.tail, wing: !!wreck.wing, wingSide: wreck.wingSide, aiDet: friendlyPool.filter((g) => g.userData.det).map((g) => g.userData.det.userData.isWing ? "wing" : "tail") }; },
    lodOf: (id) => { const i = slotOf.get(id); return i == null || !fighterPool[i] ? null : fighterPool[i].lod || null; },
    get pixelRatio() { return renderer.getPixelRatio(); },
    LOD: { LOD_NEAR, LOD_FAR, DOT_FLOOR, DOT_EQ }, fighterAreas,
    setTracers,
    get tracerStats() { return Object.assign({}, trStats); },
    // debug: tint OUR tracers (kind 0) for identification stills; null restores
    tracerTint: (rgb) => { if (!TR_KIND._k0) TR_KIND._k0 = [TR_KIND[0][0], TR_KIND[0][1]]; if (rgb) { TR_KIND[0][0] = rgb; TR_KIND[0][1] = rgb.map((v) => v * 0.7); } else { TR_KIND[0][0] = TR_KIND._k0[0]; TR_KIND[0][1] = TR_KIND._k0[1]; } return true; },
    get b17Stats() { const g = friendlyPool[0]; let meshes = 0, tris = 0; g.traverse((o) => { if (o.isMesh) { meshes++; const gg = o.geometry; tris += (gg.index ? gg.index.count : gg.attributes.position.count) / 3; } }); return { children: g.children.length, meshes, tris: Math.round(tris) }; },
    testBombAdvance(dt, geo) { if (geo) _geoNow = geo; updateBombs(dt); }, // test hook — pass mission.geo so sticks track under advance()
    get flameStats() { return flameStats; },
    get flakStats() { return flakStats; },
    tearInfo(which) { const g = shipGroup(which); if (!g) return []; g.updateMatrixWorld(true); return (g.userData.tears || []).map((m) => { const v = new THREE.Vector3(), n = new THREE.Vector3(0, 0, 1); m.getWorldPosition(v); const q = new THREE.Quaternion(); m.getWorldQuaternion(q); n.applyQuaternion(q); return { x: v.x, y: v.y, z: v.z, nx: n.x, ny: n.y, nz: n.z, s: m.scale.x }; }); },
    get friendlyInfo() { return friendlyPool.map((g, i) => { const v = new THREE.Vector3(); g.getWorldPosition(v); return { i, bay: g.userData.bay ? +g.userData.bay.open.toFixed(2) : null, vis: g.visible, x: v.x, y: v.y, z: v.z, qy: g.quaternion.y, qw: g.quaternion.w }; }); }, // test hook
    get townInfo() { const v = new THREE.Vector3(); town.getWorldPosition(v); return { x: v.x, y: v.y, z: v.z, smoke: impactSmoke.filter((p) => p.life > 0).length }; },
  };
}

// Attach for non-module consumers
window.createWorld3D = createWorld3D;
window.THREE_NS = THREE;
