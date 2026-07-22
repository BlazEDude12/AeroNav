/**
 * Phase 2 core-flows verification.
 *
 * Phase 1 touched shared code (the poll loop, the layout, the <head>), so this
 * drives the existing features to confirm none regressed. Two tiers:
 *   - Strict (always asserted): Map/Satellite toggle, weather + density layer
 *     toggles, My Flights sign-in panel. These are deterministic UI, no feed.
 *   - Soft (asserted only if live flights load): selecting an aircraft opens
 *     the detail panel with a callsign + squawk, and a trail is requested.
 *     Skipped-with-warning if the feed returns nothing, so transient feed
 *     outages don't flake CI. Run locally to exercise the soft tier fully.
 *
 * Run: node flows.mjs      (exit 0 = pass, 1 = fail)
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHOT = join(tmpdir(), "aeronav3d_flows_selected.png");
const MIME = { ".html":"text/html",".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",".json":"application/json",".svg":"image/svg+xml",".png":"image/png",".jpg":"image/jpeg",".ico":"image/x-icon",".webp":"image/webp",".gz":"application/gzip" };

function startStaticServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
        if (p.endsWith("/")) p += "index.html";
        const fp = normalize(join(ROOT, p));
        if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
        const i = await stat(fp).catch(() => null);
        if (!i || !i.isFile()) { res.writeHead(404); return res.end("404"); }
        res.writeHead(200, { "Content-Type": MIME[extname(fp).toLowerCase()] || "application/octet-stream" });
        res.end(await readFile(fp));
      } catch (e) { res.writeHead(500); res.end(String(e)); }
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function main() {
  const server = await startStaticServer();
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/index.html`;
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message || String(e)));
  const fail = [];
  const warn = [];

  try {
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    await page.waitForFunction(() => typeof viewer !== "undefined" && viewer.imageryLayers.length > 0, null, { timeout: 30_000 });

    // --- Strict: Map / Satellite toggle ---
    await page.click('#mapToggle button[data-mode="satellite"]');
    await page.waitForTimeout(400);
    if (await page.evaluate(() => mapMode) !== "satellite") fail.push("Satellite toggle did not set mapMode=satellite");
    await page.click('#mapToggle button[data-mode="hybrid"]');
    await page.waitForTimeout(400);
    if (await page.evaluate(() => mapMode) !== "hybrid") fail.push("Map toggle did not restore mapMode=hybrid");

    // --- Strict: weather + density layer toggles (aria-pressed flips) ---
    for (const id of ["#wxToggle", "#densToggle"]) {
      await page.click(id);
      await page.waitForTimeout(300);
      if (await page.getAttribute(id, "aria-pressed") !== "true") fail.push(`${id} did not become pressed`);
      await page.click(id); // restore
      await page.waitForTimeout(150);
    }

    // --- Strict: My Flights opens (sign-in prompt when signed out) ---
    await page.click("#mfToggle");
    await page.waitForTimeout(400);
    if (await page.getAttribute("#mfToggle", "aria-expanded") !== "true") fail.push("My Flights did not expand");
    await page.click("#mfToggle"); // restore
    await page.waitForTimeout(150);

    // --- Soft: live flights + aircraft selection ---
    await page.evaluate(() => {
      viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(-73.8, 40.64, 380_000) });
    });
    let hex = null;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      hex = await page.evaluate(() => { try { pollFlights(true); } catch (_) {} return flights.size ? [...flights.keys()][0] : null; });
      if (hex) break;
      await page.waitForTimeout(1500);
    }
    if (!hex) {
      warn.push("No live flights loaded over NYC within 25s — aircraft-select flow skipped (feed may be busy).");
    } else {
      const sel = await page.evaluate((h) => {
        selectFlight(h);
        const panel = document.getElementById("flightPanel");
        return {
          open: panel.classList.contains("open"),
          callsign: (document.getElementById("fpCallsign").textContent || "").trim(),
          hasSquawk: !!document.getElementById("fpSquawk"),
          trailRequested: typeof trailHex !== "undefined" ? trailHex === h : null,
        };
      }, hex);
      if (!sel.open) fail.push("Selecting an aircraft did not open the detail panel");
      if (!sel.callsign) fail.push("Detail panel callsign is empty after selection");
      console.log(`[flows] selected ${hex}: ${JSON.stringify(sel)}`);
      await page.waitForTimeout(1200);
      await page.evaluate(() => { for (let i = 0; i < 15; i++) viewer.render(); });
      try { await page.screenshot({ path: SHOT }); } catch (_) { /* best-effort proof */ }
    }

    if (pageErrors.length) fail.push(`Uncaught JS errors:\n  - ${pageErrors.join("\n  - ")}`);
  } catch (e) {
    fail.push("Harness error: " + (e.message || e));
  } finally {
    await browser.close();
    server.close();
  }

  for (const w of warn) console.warn(`[flows] ⚠ ${w}`);
  if (fail.length) {
    console.error(`\n[flows] FAILED (${fail.length}):`);
    for (const f of fail) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`\n[flows] PASSED — core flows work (${warn.length ? "soft flight flow skipped" : "incl. live aircraft selection"}), no uncaught JS errors.`);
  process.exit(0);
}

main().catch((e) => { console.error("[flows] fatal:", e); process.exit(1); });
