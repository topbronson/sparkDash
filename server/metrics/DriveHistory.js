import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWrite } from "../util/atomicWrite.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

const HISTORY_PATH =
  process.env.DRIVE_HISTORY_JSON_PATH || path.join(ROOT, "config", "drive-history.json");

const DAY_MS = 24 * 3600_000;
/** Per-drive ring cap. Daily heartbeats alone give ~5.5 years; bursts trim oldest. */
export const MAX_SAMPLES_PER_DRIVE = 2000;
/** Always keep a point at least this fresh so a flat line still has an endpoint. */
const HEARTBEAT_MS = DAY_MS;

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * The comparable health identity of a sample: slow counters only. tempC and
 * powerOnHours move every hour and must NOT trigger appends — they ride along
 * on change-driven and heartbeat samples.
 */
function keyOf(s) {
  return [s.pending, s.realloc, s.uncorrected, s.availableSparePct, s.percentageUsed]
    .map((v) => (v === null || v === undefined ? "·" : String(v)))
    .join("|");
}

function pruneSample(s) {
  const out = { t: s.t };
  for (const k of ["pending", "realloc", "uncorrected", "tempC", "powerOnHours", "availableSparePct", "percentageUsed"]) {
    if (s[k] !== null && s[k] !== undefined) out[k] = s[k];
  }
  return out;
}

/**
 * Long-horizon per-drive SMART history, one append-only ring per (spark, device).
 *
 * Deliberately separate from UnitHistory: disk health is a slow series (a bad
 * sector count that does not move for two years is the interesting case), so it
 * stores change-driven points plus a daily heartbeat instead of minute buckets,
 * and keeps years rather than 30 days. Persisted to config/drive-history.json;
 * in-memory until the first change, flushed on a trailing debounce.
 */
export class DriveHistory {
  constructor(filePath = HISTORY_PATH) {
    this._file = filePath;
    this._data = {};
    this._loaded = false;
    this._dirty = false;
    this._saveTimer = null;
  }

  load() {
    if (this._loaded) return;
    try {
      if (fs.existsSync(this._file)) {
        const parsed = JSON.parse(fs.readFileSync(this._file, "utf8"));
        if (parsed && typeof parsed === "object") this._data = parsed;
      }
    } catch {
      // Corrupt file: start clean rather than crash the monitor loop. The
      // next successful flush replaces it.
      this._data = {};
    }
    this._loaded = true;
  }

  /** Record one SMART reading round (SystemCollector SmartDrive[]). Returns samples appended. */
  record(sparkId, drives, now = Date.now()) {
    if (!Array.isArray(drives) || drives.length === 0) return 0;
    this.load();
    const byDevice = (this._data[sparkId] ||= {});
    let appended = 0;
    for (const d of drives) {
      if (!d || !d.device) continue;
      const samples = (byDevice[d.device] ||= []);
      const last = samples[samples.length - 1];
      const sample = pruneSample({
        t: now,
        pending: num(d.pendingSectors),
        realloc: num(d.reallocatedSectors),
        uncorrected: num(d.uncorrectedSectors),
        tempC: num(d.tempC),
        powerOnHours: num(d.powerOnHours),
        availableSparePct: num(d.availableSparePct),
        percentageUsed: num(d.percentageUsed),
      });
      if (last && keyOf(last) === keyOf(sample)) {
        // Counters unchanged: keep one point per day, drop the rest.
        if (now - last.t < HEARTBEAT_MS) continue;
      }
      samples.push(sample);
      if (samples.length > MAX_SAMPLES_PER_DRIVE) samples.splice(0, samples.length - MAX_SAMPLES_PER_DRIVE);
      appended++;
    }
    if (appended > 0) this._scheduleSave();
    return appended;
  }

  /** Backfill/merge a series (e.g. from a Synology DSM smart_result archive). force replaces. */
  seed(sparkId, device, samples, { force = false } = {}) {
    this.load();
    const byDevice = (this._data[sparkId] ||= {});
    const cleaned = (samples || [])
      .filter((s) => s && Number.isFinite(s.t) && s.t > 0 && s.t < 4e12)
      .map(pruneSample)
      .sort((a, b) => a.t - b.t);
    let next = cleaned;
    if (!force && Array.isArray(byDevice[device]) && byDevice[device].length > 0) {
      // Merge: archive points first, live points win on identical timestamps.
      const seen = new Map();
      for (const s of cleaned) seen.set(s.t, s);
      for (const s of byDevice[device]) seen.set(s.t, s);
      next = [...seen.values()].sort((a, b) => a.t - b.t);
    }
    next = next.slice(-MAX_SAMPLES_PER_DRIVE);
    const changed = JSON.stringify(next) !== JSON.stringify(byDevice[device] || []);
    byDevice[device] = next;
    if (changed) this._scheduleSave();
    return changed;
  }

  /** { device: samples[] } for one spark (newest last). */
  get(sparkId) {
    this.load();
    return this._data[sparkId] || {};
  }

  /** Test/shutdown helper: write now if anything is pending. */
  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (!this._dirty) return;
    try {
      atomicWrite(this._file, JSON.stringify(this._data), 0o644);
      this._dirty = false;
    } catch (err) {
      console.error("[DriveHistory] save failed:", err.message);
      // Keep the data dirty and retry later; never lose a failed write silently.
      if (!this._saveTimer) {
        this._saveTimer = setTimeout(() => {
          this._saveTimer = null;
          this.flush();
        }, 60000);
        this._saveTimer.unref?.();
      }
    }
  }

  _scheduleSave() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flush();
    }, 5000);
    this._saveTimer.unref?.();
  }
}

/** Process-wide singleton used by SparkMonitor and the API route. */
export const driveHistory = new DriveHistory();
