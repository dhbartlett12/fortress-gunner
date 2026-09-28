# Fortress Gunner — flight model scale

Bomber-relative world: B-17 fixed at origin, **+Z = north (track/nose)**, **+Y = up**, **+X = starboard**.
The Fortress cruises north at constant altitude; cloud scroll simulates that motion.

## Units

| Quantity | Value |
|----------|-------|
| **1 world unit** | **100 feet** |
| B-17 TAS | 280 mph → **4.107 units/s** |
| Bf 109 max ground speed | ~400 mph → **5.867 units/s** |
| Head-on closing (109 diving south + B-17 north) | ~**10.0 units/s** (~680 mph) |
| B-17 altitude (narrative) | 20,000 ft (level bomb run) |
| 109 dive start | ~30,000 ft ahead (+Z ≈ 300) at ~30,000 ft MSL (≈ +100 units above bomber) |

Conversion: `units/s = mph × (5280/3600) / 100`.

## Geometry (single Bf 109 attack run)

1. **Dive** — Spawn high frontal quarter. Narrative table is ~26–34k ft; **phone build compresses to ~10–15k ft ahead / 8–14k ft abeam** and aims the dive at the *opposite* beam so the airplane slashes across the sky instead of sitting as a radial speck.
2. **Attack** — Inside ~6–8k ft, fire a short burst while the silhouette goes head-on → belly as they pull through.
3. **Pull-out** — Near miss (~2–4k ft): high-G pull-up + bank toward the outside wing; convert dive energy.
4. **Breakaway** — Extend to the beam/high-side, climbing away (not despawn).
5. **Rejoin** — Believable turn (~10–18 unit radius ≈ 1–1.8k ft) to a new high perch (frontal / beam / high-side), then dive again.

Multiple bandits use staggered spawn timers so passes overlap without stacking on one clock.

Cloud drift is ~2× true airspeed for phone readability; combat kinematics use the table above.

Phone spawn is **medium** (~10–16k ft ahead, 5.5–11k ft abeam) so fighters close in ~3–5s and make a readable pass (Cycle 134). World3D sync uses near-constant mesh scale (~2.0–2.45, hard cap 3.15) — perspective grows the silhouette, never distance-boosted face-huggers. Dive→attack→pullout→break→rejoin.

## Energy / pull-out (v1.0.7)

- Dive energy rises with dive angle (`pitchAtt`); max ~420 mph equivalent.
- Pull-out bleeds energy into climb — speed cap drops through the wingover so the silhouette slows as it pitches up.
- Beam passes keep more lateral velocity and a shallower dive target so the slash reads across the phone sky.
- Rejoin steers onto the next perch **without teleporting** (safety warp only if lost >26k ft aft).

## Deflection lead (v1.0.8)

- Shared `leadFlightTime(dist) = clamp(dist/580, 0.10, 0.55)` (bullet visual speed 580).
- `leadAimPoint` adds a minimum LOS-tangential offset so the gold pip reads on phone FOV crossing passes (pure 3D intercept was ~1px radial).
- Hitscan + ballistic both require aiming nearer the pip than the airframe when the pip is clearly ahead.
