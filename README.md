# Fortress Gunner (web)

B-17 Flying Fortress top-turret gunner, 1943. Defend the combat box against 44 Bf 109s on the run to the target.
Browser build of the Android game (v1.4.0), served as plain static files: `index.html` is at the root.

**Play:** https://dhbartlett12.github.io/fortress-gunner/

## Controls
**Computer (mouse):**
- Click the view to capture the mouse (Pointer Lock).
- Mouse aims 1:1. Continuous 360° yaw and unlimited look-down.
- Hold the left button to fire.
- Esc releases the mouse.
- `[` / `]` change the mouse sensitivity.
- Keyboard alternative: WASD / arrow keys aim, Space fires.
- Enter ends the mission while you're under the parachute.

**Phone / tablet (touch):**
- Drag anywhere on the right half to aim.
- Hold anywhere on the left half to fire.
- Play in landscape.

No build step and no server code. Three.js is pre-bundled in `world3d.bundle.js`; `world3d.js` is its source.
