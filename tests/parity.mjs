/**
 * Cross-implementation parity test (Phase 1.13).
 *
 * The README documents an intentional resilience design: three independent
 * upstream proxies (supabase/functions/flights/index.ts, server.py, worker.js)
 * reimplement similar logic in three runtimes so no single one is a point of
 * failure. They must not be merged — but they must not silently DRIFT either.
 *
 * The non-trivial shared logic is normalizing OpenSky's positional state
 * vectors into the aggregators' field names/units. Two implementations do it:
 *   - supabase/functions/flights/index.ts  normalizeOpenSky()
 *   - server.py                            _normalize_opensky()
 * (worker.js is a circle + routes proxy only — it has no OpenSky normalizer,
 *  so it is not part of this comparison.)
 *
 * This test feeds both the same fixtures and asserts equivalent output for
 * hex, flight, lat, lon, alt_baro, gs, track, baro_rate, squawk. Rounded
 * integer fields are compared with a ±1 tolerance because Python's round()
 * uses banker's rounding while JS Math.round() rounds half up — an accepted
 * 1-unit difference, but anything larger (a wrong unit factor, a dropped
 * field, a sign error) fails the build.
 *
 * The TS normalizer is extracted from its source file and run in Node, so the
 * test always checks the real shipped logic (and fails loudly if the source
 * shape changes and needs a fresh extraction). Run: node parity.mjs
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TS_PATH = join(ROOT, "supabase/functions/flights/index.ts");
const PY_HELPER = join(ROOT, "tests/parity_py.py");

/** Build a callable JS copy of the Edge Function's normalizeOpenSky by
 *  extracting it (plus the constants it needs) straight from the .ts source. */
function loadTsNormalizer() {
  const src = readFileSync(TS_PATH, "utf8");
  const osConsts = src.match(/const OS_ICAO[\s\S]*?OS_SQUAWK\s*=\s*\d+;/);
  const unitConsts = src.match(/const M_TO_FT[\s\S]*?MS_TO_FT_MIN\s*=\s*[\d.]+;/);
  const fnMatch = src.match(/function normalizeOpenSky[\s\S]*?\n\}/);
  if (!osConsts || !unitConsts || !fnMatch) {
    throw new Error("Could not extract normalizeOpenSky/constants from index.ts — " +
      "the source shape changed; update tests/parity.mjs extraction.");
  }
  const fn = fnMatch[0].replace(/:\s*unknown\[\]\[\]/, ""); // strip the lone TS type
  // eslint-disable-next-line no-new-func
  return new Function(`${osConsts[0]}\n${unitConsts[0]}\n${fn}\nreturn normalizeOpenSky;`)();
}

function runPyNormalizer(states) {
  const res = spawnSync("python3", [PY_HELPER], {
    input: JSON.stringify(states), encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error("python3 helper failed: " + (res.stderr || res.error || "unknown"));
  }
  return JSON.parse(res.stdout);
}

// OpenSky state vector: [0]icao [1]callsign [5]lon [6]lat [7]baro_alt
// [8]on_ground [9]velocity [10]track [11]vertical_rate [14]squawk (len 17).
function osv(o) {
  const s = new Array(17).fill(null);
  s[0] = o.hex; s[1] = o.cs; s[5] = o.lon; s[6] = o.lat; s[7] = o.alt;
  s[8] = o.ground; s[9] = o.vel; s[10] = o.trk; s[11] = o.vr; s[14] = o.sq;
  return s;
}

const FIXTURES = [
  osv({ hex: "abc123", cs: "UAL123 ", lon: -73.7781, lat: 40.6413, alt: 10668, ground: false, vel: 250, trk: 271.4, vr: 0.3, sq: "1200" }),
  osv({ hex: "def456", cs: "DAL9", lon: -84.4277, lat: 33.6407, alt: 0, ground: true, vel: 5, trk: 90, vr: 0, sq: "2000" }),
  osv({ hex: "789abc", cs: "SWA88", lon: 2.5479, lat: 49.0097, alt: 3000.0, ground: false, vel: 180, trk: 45.7, vr: -12.5, sq: null }),
  osv({ hex: "111222", cs: null, lon: 10, lat: 20, alt: null, ground: false, vel: null, trk: null, vr: null, sq: null }),
  osv({ hex: "999999", cs: "GHOST", lon: null, lat: null, alt: 5000, ground: false, vel: 100, trk: 0, vr: 0, sq: "7700" }), // dropped (no lat/lon)
  osv({ hex: "aa55bb", cs: "  ", lon: 139.7671, lat: 35.6812, alt: 11277.6, ground: false, vel: 257.7, trk: 10.5, vr: 7.62, sq: "7500" }), // .5 track exercises tolerance
];

const NUMERIC = ["alt_baro", "gs", "track", "baro_rate"];
function compare(js, py) {
  const problems = [];
  if (js.length !== py.length) {
    problems.push(`length mismatch: ts=${js.length} py=${py.length}`);
    return problems;
  }
  for (let i = 0; i < js.length; i++) {
    const a = js[i], b = py[i], where = `row ${i} (${a.hex})`;
    if (a.hex !== b.hex) problems.push(`${where}: hex ${a.hex} != ${b.hex}`);
    if (a.flight !== b.flight) problems.push(`${where}: flight ${JSON.stringify(a.flight)} != ${JSON.stringify(b.flight)}`);
    if ((a.squawk ?? null) !== (b.squawk ?? null)) problems.push(`${where}: squawk ${a.squawk} != ${b.squawk}`);
    for (const k of ["lat", "lon"]) {
      if (Math.abs(a[k] - b[k]) > 0.0002) problems.push(`${where}: ${k} ${a[k]} != ${b[k]}`);
    }
    for (const k of NUMERIC) {
      const av = a[k], bv = b[k];
      const aNull = av === null || av === "ground", bNull = bv === null || bv === "ground";
      if (av === "ground" || bv === "ground") {
        if (av !== bv) problems.push(`${where}: ${k} ground mismatch (${av} vs ${bv})`);
      } else if (aNull !== bNull) {
        problems.push(`${where}: ${k} null mismatch (${av} vs ${bv})`);
      } else if (!aNull && Math.abs(av - bv) > 1) {
        problems.push(`${where}: ${k} ${av} != ${bv} (>1 apart)`);
      }
    }
  }
  return problems;
}

function main() {
  let tsOut, pyOut;
  try {
    tsOut = loadTsNormalizer()(FIXTURES);
    pyOut = runPyNormalizer(FIXTURES);
  } catch (err) {
    console.error("[parity] FAILED to run a normalizer:", err.message);
    process.exit(1);
  }
  const problems = compare(tsOut, pyOut);
  console.log(`[parity] compared ${tsOut.length} normalized aircraft across index.ts and server.py`);
  if (problems.length) {
    console.error(`\n[parity] FAILED — normalizers have drifted (${problems.length}):`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log("[parity] PASSED — index.ts and server.py normalize OpenSky identically.");
  process.exit(0);
}

main();
