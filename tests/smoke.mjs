/**
 * Phase 0 smoke test — the regression guard for the 3D render pipeline.
 *
 * This codebase's worst class of bug (a blank globe that renders zero frames)
 * produces NO console errors and looks fine in a static code read — you only
 * catch it by loading the page and looking at the canvas. This test does that
 * automatically: it serves the repo statically, loads index.html in headless
 * Chromium, waits for the globe to paint WITHOUT any interaction, and asserts
 *
 *   1. the globe actually rendered its surface tiles on its own
 *      (viewer.scene.globe.tilesLoaded became true, no click/drag needed), and
 *   2. the #globe canvas is NOT a single flat colour — a blank / all-black
 *      canvas means the imagery layer never painted (sampled from a real
 *      screenshot, so it's immune to WebGL preserveDrawingBuffer quirks), and
 *   3. there were zero uncaught JS errors on the page.
 *
 * Run locally:  node smoke.mjs      (exit 0 = pass, 1 = fail)
 * Runs in CI on every push/PR via .github/workflows/smoke-test.yml.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { PNG } from "pngjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url)); // repo root
const CANVAS_SELECTOR = "#globe .cesium-widget canvas";
const PAINT_TIMEOUT_MS = 30_000;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".ico": "image/x-icon", ".webp": "image/webp", ".gz": "application/gzip",
  ".map": "application/json", ".woff": "font/woff", ".woff2": "font/woff2",
};

function startStaticServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        let pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
        if (pathname.endsWith("/")) pathname += "index.html";
        const filePath = normalize(join(ROOT, pathname));
        if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
        const info = await stat(filePath).catch(() => null);
        if (!info || !info.isFile()) { res.writeHead(404); return res.end("not found"); }
        const body = await readFile(filePath);
        res.writeHead(200, { "Content-Type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream" });
        res.end(body);
      } catch (err) { res.writeHead(500); res.end(String(err)); }
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

/** Analyse a canvas PNG screenshot: colour variety + peak brightness.
 *  A blank/black globe collapses to ~1 quantised colour with maxLum ~0. */
function analysePng(buffer) {
  const png = PNG.sync.read(buffer);
  const { width, height, data } = png;
  const colors = new Set();
  let maxLum = 0;
  let brightPixels = 0;
  const total = width * height;
  const step = Math.max(1, Math.floor(total / 4000)); // sample ~4000 pixels
  let sampled = 0;
  for (let i = 0; i < total; i += step) {
    const o = i * 4;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    // quantise to 5 bits/channel so anti-aliasing noise doesn't inflate variety
    colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
    const lum = (r + g + b) / 3;
    if (lum > maxLum) maxLum = lum;
    if (lum > 30) brightPixels++;
    sampled++;
  }
  return { uniq: colors.size, maxLum: Math.round(maxLum), brightFrac: brightPixels / sampled, sampled };
}

async function main() {
  const server = await startStaticServer();
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/index.html`;
  console.log(`[smoke] serving repo at ${url}`);

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message || String(err)));

  const failures = [];
  try {
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });

    // 1) Wait for the globe to paint its surface tiles on its own — no clicks,
    //    no drags. This is the Phase 1.1 guarantee ("untouched load renders").
    let tilesLoaded = false;
    const deadline = Date.now() + PAINT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      tilesLoaded = await page.evaluate(() =>
        typeof viewer !== "undefined" && viewer.scene.globe.tilesLoaded);
      if (tilesLoaded) break;
      await page.waitForTimeout(500);
    }
    if (!tilesLoaded) {
      failures.push("Globe never finished rendering its surface tiles within " +
        `${PAINT_TIMEOUT_MS / 1000}s without interaction (render loop stalled).`);
    }

    // 2) Screenshot the canvas and confirm it isn't a single flat colour.
    const el = await page.$(CANVAS_SELECTOR);
    if (!el) {
      failures.push(`Canvas element not found (${CANVAS_SELECTOR}).`);
    } else {
      const shot = await el.screenshot({ type: "png" });
      const px = analysePng(shot);
      console.log(`[smoke] canvas pixels: ${JSON.stringify(px)}, tilesLoaded=${tilesLoaded}`);
      if (px.uniq < 8 || px.maxLum <= 30 || px.brightFrac < 0.02) {
        failures.push(
          `Globe canvas looks blank/flat (uniqueColors=${px.uniq}, maxLum=${px.maxLum}, ` +
          `brightFraction=${px.brightFrac.toFixed(3)}). Imagery/render pipeline never painted.`
        );
      }
    }

    // 3) Zero uncaught JS errors.
    if (pageErrors.length) {
      failures.push(`Uncaught JS errors on the page:\n  - ${pageErrors.join("\n  - ")}`);
    }
  } catch (err) {
    failures.push(`Test harness error: ${err.message || err}`);
  } finally {
    await browser.close();
    server.close();
  }

  if (failures.length) {
    console.error(`\n[smoke] FAILED (${failures.length}):`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log("\n[smoke] PASSED — globe painted on its own, no uncaught JS errors.");
  process.exit(0);
}

main().catch((err) => { console.error("[smoke] fatal:", err); process.exit(1); });
