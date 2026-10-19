#!/usr/bin/env node
/**
 * Seed sparkDash's long-horizon drive history from a Synology DSM box.
 *
 * DSM keeps weekly SMART snapshots in /var/log/smart_result/*.txz (one
 * smartctl dump per drive per week, typically 2+ years deep). This imports
 * them into config/drive-history.json so the Storage panel's per-drive
 * sparklines have real history from day one. The collector keeps extending
 * the series from there.
 *
 * Usage: node scripts/import-syno-smart-history.mjs --spark data-station [--force]
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { sshExec } from "../server/collectors/ssh.js";
import { DriveHistory } from "../server/metrics/DriveHistory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const getArg = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const sparkId = getArg("--spark", "data-station");
const force = args.includes("--force");
const baseUrl = getArg("--base", "http://127.0.0.1:5555");

const sparksPath = process.env.SPARKS_JSON_PATH || path.join(ROOT, "config", "sparks.json");
const sparks = JSON.parse(readFileSync(sparksPath, "utf8")).sparks || [];
const spark = sparks.find((s) => s.id === sparkId);
if (!spark) {
  console.error(`Spark "${sparkId}" not found in ${sparksPath}`);
  process.exit(1);
}

// One awk pass per weekly archive: emit date|serial|pending|realloc|uncorr|hours
// for every drive section (each member is a full smartctl dump).
const REMOTE = `
for f in /var/log/smart_result/*.txz; do
  d=$(basename "$f" .txz | cut -d_ -f1)
  xz -dc "$f" 2>/dev/null | tar -xO 2>/dev/null | awk -v d="$d" '
    function flush() { if (serial != "") printf "%s|%s|%s|%s|%s|%s\\n", d, serial, p, r, u, h }
    /^smartctl / { flush(); serial=""; p=""; r=""; u=""; h="" }
    /Serial Number:/ { serial=$NF }
    /197 Current_Pending_Sector/ { p=$NF }
    /^ *5 Reallocated_Sector/ { r=$NF }
    /198 Offline_Uncorrectable/ { u=$NF }
    /Power On Hours/ { h=$NF }
    /Power_On_Hours/ { h=$NF }
    END { flush() }
  '
done`;

console.log(`Reading DSM SMART archives on ${spark.id} (${spark.host || spark.ssh?.host || "?"})...`);
const out = await sshExec(spark, REMOTE, { timeoutMs: 180000 });

// Map serial -> live device name via the running dashboard's SMART strip.
let serialToDev = {};
try {
  const res = await fetch(`${baseUrl}/api/sparks/${encodeURIComponent(sparkId)}/metrics`);
  const body = await res.json();
  for (const d of body?.metrics?.smart || []) if (d.serial) serialToDev[d.serial] = d.device;
} catch (err) {
  console.warn(`Could not read live serial map from ${baseUrl}: ${err.message}`);
}

const toInt = (v) => {
  if (!v) return undefined;
  const n = parseInt(String(v).replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : undefined;
};

const byDevice = {};
let rows = 0;
let skipped = 0;
for (const line of String(out || "").split("\n")) {
  const parts = line.trim().split("|");
  if (parts.length !== 6) continue;
  const [date, serial, p, r, u, h] = parts;
  const t = Date.parse(`${date}T12:00:00Z`);
  if (!Number.isFinite(t) || !serial) {
    skipped++;
    continue;
  }
  const device = serialToDev[serial];
  if (!device) {
    console.warn(`  no live drive matched serial ${serial} — run sparkDash first (or --force after it has sampled once); skipped`);
    skipped++;
    continue;
  }
  const sample = { t };
  const pending = toInt(p);
  const realloc = toInt(r);
  const uncorr = toInt(u);
  const hours = toInt(h);
  if (pending !== undefined) sample.pending = pending;
  if (realloc !== undefined) sample.realloc = realloc;
  if (uncorr !== undefined) sample.uncorrected = uncorr;
  if (hours !== undefined) sample.powerOnHours = hours;
  (byDevice[device] ||= []).push(sample);
  rows++;
}

// Prefer merging through the running server: a live server flushes its own
// in-memory map, which would silently clobber an out-of-band file write.
let viaApi = false;
try {
  for (const [device, samples] of Object.entries(byDevice)) {
    const res = await fetch(`${baseUrl}/api/sparks/${encodeURIComponent(sparkId)}/drive-history/seed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device, samples, force }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    console.log(`  ${device}: ${body.changed ? "seeded" : "unchanged"} → ${body.count} samples total`);
  }
  viaApi = true;
} catch (err) {
  console.warn(`  seed API unavailable (${err.message}) — writing the JSON directly instead`);
}
if (!viaApi) {
  const history = new DriveHistory();
  for (const [device, samples] of Object.entries(byDevice)) {
    const did = history.seed(sparkId, device, samples, { force });
    console.log(`  ${device}: ${did ? "seeded" : "kept existing"} ${samples.length} samples (weekly)`);
  }
  history.flush();
  console.log("NOTE: sparkDash was not reachable — start/RESTART it to pick up the direct file write.");
}
console.log(`Done: ${rows} rows imported, ${skipped} skipped.`);
