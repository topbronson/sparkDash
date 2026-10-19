import { test } from "node:test";
import { strict as assert } from "node:assert";
import { SystemCollector } from "../SystemCollector.js";

const MARKER = "---sparkdash-block-io---";
const DF = [
  "Filesystem     Type     1B-blocks         Used     Available Use% Mounted on",
  "/dev/nvme0n1p2 ext4  1000000000000 400000000000  600000000000  40% /",
  "/dev/nvme0n1p1 vfat      536870912     10000000     526870912   2% /boot/efi",
  "/dev/nvme1n1p1 ext4  2000000000000 500000000000 1500000000000  25% /data",
].join("\n");

/** `name` + the kernel's stat fields, where the 3rd is sectors read and the 7th sectors written. */
const stat = (name, read, written) => `${name} 100 0 ${read} 0 50 0 ${written} 0 0 0 0`;
const output = (nvme0, nvme1) =>
  [DF, MARKER, stat("nvme0n1", nvme0.read, nvme0.written), stat("nvme1n1", nvme1.read, nvme1.written), stat("loop0", 1, 1)].join("\n");

const remote = () => new SystemCollector({ id: "worker", isLocal: false, ssh: { host: "10.0.0.2", user: "me" } });

test("remote units report disk read/write speed from the block-device counters", () => {
  const c = remote();
  const first = c._parseRemoteStorage(output({ read: 1000, written: 2000 }, { read: 0, written: 0 }), 10_000);
  assert.deepEqual(first.map((d) => [d.label, d.readSpeed, d.writeSpeed]), [["/", 0, 0], ["/data", 0, 0]]);

  // 5 s later: +20480 sectors read (10 MiB) and +40960 written (20 MiB) on nvme0n1, +2048 read on nvme1n1.
  const second = c._parseRemoteStorage(output({ read: 21_480, written: 42_960 }, { read: 2048, written: 0 }), 15_000);
  const root = second.find((d) => d.label === "/");
  assert.equal(root.readSpeed, 2 * 1024 * 1024);
  assert.equal(root.writeSpeed, 4 * 1024 * 1024);
  const data = second.find((d) => d.label === "/data");
  assert.equal(data.readSpeed, Math.round((2048 * 512) / 5));
  assert.equal(data.writeSpeed, 0);
});

test("a remote unit that returns no counters still lists its disks, at 0", () => {
  const disks = remote()._parseRemoteStorage(DF, 1000);
  assert.equal(disks.length, 2);
  assert.ok(disks.every((d) => d.readSpeed === 0 && d.writeSpeed === 0));
});

test("two mounts on one disk, read within a poll, share its rate instead of the second reading 0", () => {
  const c = remote();
  c._diskRate("nvme0n1", 0, 0, 10_000);
  const a = c._diskRate("nvme0n1", 20_480, 0, 15_000);
  const b = c._diskRate("nvme0n1", 20_480, 0, 15_003);
  assert.equal(a.readSpeed, 2 * 1024 * 1024);
  assert.deepEqual(b, a);
  // The next poll still measures from the first sample of the previous one.
  const next = c._diskRate("nvme0n1", 20_480, 0, 20_000);
  assert.equal(next.readSpeed, 0);
});

test("a counter that went backwards (device reset) reads 0, not a negative speed", () => {
  const c = remote();
  c._diskRate("sda", 5000, 5000, 1000);
  assert.deepEqual(c._diskRate("sda", 10, 10, 6000), { readSpeed: 0, writeSpeed: 0 });
});

// ─── Synology DSM (data-station): LVM-ish cachedev mounts over mdraid ───────────

const DM_MARKER = "---sparkdash-dm-map---";
const MD_MARKER = "---sparkdash-mdstat---";

const SYNO_DF = [
  "Filesystem             Type          1B-blocks          Used     Available Use% Mounted on",
  "/dev/md0               ext4     8191901952   1592176640    6365671424  20% /",
  "/dev/mapper/cachedev_0 btrfs  3829392842752    65327837184 3764065005568  2% /volume2",
  "/dev/mapper/cachedev_1 btrfs 17268860907520  6891123183616 10377737723904 40% /volume1",
  "/dev/mapper/cachedev_1 btrfs 17268860907520  6891123183616 10377737723904 40% /volume1/@appdata/ContainerManager/all_shares/Core",
  "/dev/mapper/cachedev_1 btrfs 17268860907520  6891123183616 10377737723904 40% /volume1/@appdata/ContainerManager/all_shares/web",
  "/dev/loop0             ext4       28311552      1048576      25165824   4% /tmp/SynologyAuthService",
].join("\n");

const SYNO_DM = [
  "dm-0 cache_lv md4,",
  "dm-1 cachedev_0 md2,",
  "dm-2 dm-2 md3,",
  "dm-3 cachedev_1 md1,dm-2,",
  "dm-4 dm-4 md4,",
].join("\n");

const SYNO_MD = [
  "Personalities : [raid1] ",
  "md4 : active raid1 nvme0n1p1[0]",
  "      4194304 blocks [1/1] [U]",
  "md3 : active raid1 sata4p5[0] sata3p5[1]",
  "      8388608 blocks [2/2] [UU]",
  "md2 : active raid1 sata1p5[0] sata2p5[1]",
  "      8388608 blocks [2/2] [UU]",
  "md1 : active raid1 sata4p2[2] sata3p2[3] sata2p2[1]",
  "      2097120 blocks [4/3] [U_U]",
  "md0 : active raid1 sata1p1[0] sata3p1[3] sata4p1[2] sata2p1[1]",
  "      2097120 blocks [4/4] [UUUU]",
  "unused devices: <none>",
].join("\n");

const synoStats = (writes) => [
  stat("md0", 100, 100),
  stat("md1", 100, 100),
  stat("md2", 100, 100),
  stat("md3", 100, 100),
  stat("md4", 100, 100),
  stat("dm-1", 100, 100),
  stat("dm-3", 100, writes),
  stat("dm-4", 100, 100),
  stat("sata1", 0, 0),
  stat("nvme0n1", 0, 0),
].join("\n");

const synoOutput = (writes) =>
  [SYNO_DF, MARKER, synoStats(writes), DM_MARKER, SYNO_DM, MD_MARKER, SYNO_MD].join("\n");

test("Synology volumes: subvolume duplicates and loop mounts collapse to three entries", () => {
  const disks = remote()._parseRemoteStorage(synoOutput(100), 10_000);
  assert.deepEqual(
    disks.map((d) => d.label).sort(),
    ["/", "/volume1", "/volume2"],
  );
});

test("Synology volumes: IO attributes through the dm chain and RAID state attaches per mount", () => {
  const c = remote();
  c._parseRemoteStorage(synoOutput(100), 10_000);
  // dm-3 gains 20480 sectors written over 5 s = 2 MiB/s on /volume1's logical device.
  const disks = c._parseRemoteStorage(synoOutput(20_580), 15_000);
  const v1 = disks.find((d) => d.label === "/volume1");
  assert.equal(v1.writeSpeed, 2 * 1024 * 1024);
  // root on md0 gets its own counters (regression: md names used to mangle to "md").
  assert.deepEqual(
    disks.find((d) => d.label === "/").raid.map((a) => [a.name, a.state]),
    [["md0", "ok"]],
  );
  // volume1 rides cachedev_1 -> dm-3 -> md1 + dm-2 -> md3.
  assert.deepEqual(
    v1.raid.map((a) => [a.name, a.state]),
    [["md3", "ok"], ["md1", "degraded"]],
  );
  // volume2 -> cachedev_0 -> dm-1 -> md2; md4 (cache) is not in that chain.
  assert.deepEqual(
    disks.find((d) => d.label === "/volume2").raid.map((a) => a.name),
    ["md2"],
  );
});

test("mdstat with a missing mirror leg reads degraded", () => {
  const c = remote();
  const arrays = c._parseMdstat([
    "md9 : active raid1 sdb2[1]",
    "      10000 blocks [2/1] [_U]",
    "      [>....................]  recovery =  4.2% (100/10000)",
  ].join("\n"));
  assert.deepEqual(arrays, [
    { name: "md9", level: "raid1", state: "degraded", rebuilding: true, members: ["sdb"] },
  ]);
});
