import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { DriveHistory, MAX_SAMPLES_PER_DRIVE } from "../DriveHistory.js";

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drivhist-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "drive-history.json");
}

const sata = (over = {}) => ({
  device: "sata2",
  kind: "sata",
  tempC: 40,
  powerOnHours: 1000,
  reallocatedSectors: 0,
  pendingSectors: 421,
  uncorrectedSectors: 421,
  ...over,
});

test("first record appends one sample per drive", () => {
  const h = new DriveHistory("/nonexistent/for-this-test.json");
  h._loaded = true;
  assert.equal(h.record("sp1", [sata(), sata({ device: "sata1" })], 1000), 2);
  const g = h.get("sp1");
  assert.equal(Object.keys(g).sort().join(","), "sata1,sata2");
  assert.deepEqual(g.sata2[0], { t: 1000, pending: 421, realloc: 0, uncorrected: 421, tempC: 40, powerOnHours: 1000 });
});

test("identical readings within a day append nothing", () => {
  const h = new DriveHistory("/x.json");
  h._loaded = true;
  h.record("sp1", [sata()], 0);
  assert.equal(h.record("sp1", [sata({ tempC: 43, powerOnHours: 1001 })], 3600_000), 0);
  assert.equal(h.get("sp1").sata2.length, 1);
});

test("counter changes append immediately; temp-only changes do not", () => {
  const h = new DriveHistory("/x.json");
  h._loaded = true;
  h.record("sp1", [sata()], 0);
  assert.equal(h.record("sp1", [sata({ pendingSectors: 415 })], 60_000), 1);
  assert.equal(h.get("sp1").sata2.length, 2);
  assert.equal(h.get("sp1").sata2[1].pending, 415);
});

test("unchanged counters still get a daily heartbeat", () => {
  const h = new DriveHistory("/x.json");
  h._loaded = true;
  h.record("sp1", [sata()], 0);
  assert.equal(h.record("sp1", [sata()], 23 * 3600_000), 0); // <24h: no point
  assert.equal(h.record("sp1", [sata({ powerOnHours: 1024 })], 25 * 3600_000), 1);
  assert.equal(h.get("sp1").sata2.length, 2);
});

test("ring trims oldest beyond the cap", () => {
  const h = new DriveHistory("/x.json");
  h._loaded = true;
  for (let i = 0; i < MAX_SAMPLES_PER_DRIVE + 10; i++) {
    h.record("sp1", [sata({ pendingSectors: 400 + (i % 500) })], i * 7200_000);
  }
  const s = h.get("sp1").sata2;
  assert.equal(s.length, MAX_SAMPLES_PER_DRIVE);
  assert.equal(s[0].t, 10 * 7200_000);
});

test("seed merges new points, is idempotent, and force replaces", () => {
  const h = new DriveHistory(tmpFile({ after: () => {} }));
  const seeded = h.seed("sp1", "sata2", [
    { t: 2000, pending: 424 },
    { t: 1000, pending: 425, bogus: 1 },
  ]);
  assert.equal(seeded, true);
  const s = h.get("sp1").sata2;
  assert.deepEqual(s.map((x) => x.t), [1000, 2000]);
  assert.equal(s[1].bogus, undefined);
  // Re-seeding the same points changes nothing (idempotent).
  assert.equal(h.seed("sp1", "sata2", [{ t: 2000, pending: 424 }, { t: 1000, pending: 425 }]), false);
  // A genuinely new timestamp merges in (live points win on identical t).
  assert.equal(h.seed("sp1", "sata2", [{ t: 3000, pending: 421 }, { t: 2000, pending: 999 }]), true);
  const m = h.get("sp1").sata2;
  assert.deepEqual(m.map((x) => x.t), [1000, 2000, 3000]);
  assert.equal(m[1].pending, 424); // existing value kept for t=2000
  // Force replaces wholesale.
  assert.equal(h.seed("sp1", "sata2", [{ t: 3000 }], { force: true }), true);
  assert.equal(h.get("sp1").sata2.length, 1);
});

test("stale re-served samples never append (outage must not fabricate points)", () => {
  const h = new DriveHistory("/x.json");
  h._loaded = true;
  h.record("sp1", [sata()], 5000);
  // Collector outage: same last-known-good array, same sample time, re-served for days.
  assert.equal(h.record("sp1", [sata()], 5000), 0);
  assert.equal(h.record("sp1", [sata()], 5000), 0);
  assert.equal(h.get("sp1").sata2.length, 1);
  // Fresh sample (new sample time) past the heartbeat window appends.
  assert.equal(h.record("sp1", [sata()], 5000 + 25 * 3600_000), 1);
});

test("persists via flush and reloads", () => {
  const file = tmpFile({ after: () => {} });
  const h = new DriveHistory(file);
  h._loaded = true;
  h.record("sp1", [sata()], 123);
  h.flush();
  const h2 = new DriveHistory(file);
  h2.load();
  assert.deepEqual(h2.get("sp1").sata2, [{ t: 123, pending: 421, realloc: 0, uncorrected: 421, tempC: 40, powerOnHours: 1000 }]);
});
