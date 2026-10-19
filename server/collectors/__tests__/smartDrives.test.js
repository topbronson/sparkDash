import test from "node:test";
import assert from "node:assert/strict";
import { SystemCollector } from "../SystemCollector.js";

const spark = { id: "data-station", platform: "linux", isLocal: false, ssh: { host: "h", user: "u", auth: "key", port: 22 } };
const collector = new SystemCollector(spark);

// Verbatim-style sample from the DS1825xs+ (smartctl 6.5, text mode, no -j support).
const SATA_TEXT = `smartctl 6.5 (build date Sep 26 2022) [x86_64-linux-4.4.302+] (local build)
Copyright (C) 2002-16, Bruce Allen, Christian Franke, www.smartmontools.org

=== START OF INFORMATION SECTION ===
Device Model:     ST18000NM000E-3NW101
Serial Number:    ZX213CNT
Firmware Version: ZZF1
User Capacity:    18,000,207,937,536 bytes [18.0 TB]
Rotation Rate:    7200 rpm

=== START OF READ SMART DATA SECTION ===
SMART overall-health self-assessment test result: PASSED

SMART Attributes Data Structure revision number: 1
Vendor Specific SMART Attributes with Thresholds:
ID# ATTRIBUTE_NAME          FLAG     VALUE WORST THRESH TYPE      UPDATED  WHEN_FAILED RAW_VALUE
  5 Reallocated_Sector_Ct   0x0033   100   100   010    Pre-fail  Always       -       0
  9 Power_On_Hours          0x0032   085   085   000    Old_age  Always       -       13501
 12 Power_Cycle_Count       0x0032   095   095   020    Old_age  Always       -       5857
187 Reported_Uncorrect      0x0032   100   100   000    Old_age  Always       -       0
194 Temperature_Celsius     0x0022   038   045   000    Old_age  Always       -       38 (0 15 0 0 0)
197 Current_Pending_Sector  0x0012   100   100   000    Old_age  Always       -       0
`;

const NVME_TEXT = `Smart Log for NVME device:nvme0n1 namespace-id:ffffffff
critical_warning                    : 0
temperature                         : 25 C
available_spare                     : 100%
available_spare_threshold           : 10%
percentage_used                     : 0%
data_units_read                     : 2,269,771
data_units_written                  : 2,450,607
power_on_hours                      : 12,345
unsafe_shutdowns                    : 42
mn         : SAMSUNG MZVLQ512HBLU-00B
sn         : S6F1NE0R328704
`;

test("smartctl 6.5 text parses into a full drive health record", () => {
  const d = collector._parseSmartctlText(SATA_TEXT, "sata1");
  assert.equal(d.model, "ST18000NM000E-3NW101");
  assert.equal(d.serial, "ZX213CNT");
  assert.equal(d.capacityBytes, 18000207937536);
  assert.equal(d.rpm, 7200);
  assert.equal(d.tempC, 38);
  assert.equal(d.smartPassed, true);
  assert.equal(d.powerOnHours, 13501);
  assert.equal(d.powerCycleCount, 5857);
  assert.equal(d.reallocatedSectors, 0);
  assert.equal(d.pendingSectors, 0);
  assert.equal(d.uncorrectedSectors, 0);
});

test("failing SMART verdict and nonzero sectors flip the health flags", () => {
  const d = collector._parseSmartctlText(
    SATA_TEXT.replace(/test result: PASSED/, "test result: FAIL")
      .replace(/Reallocated_Sector_Ct   0x0033   100   100   010    Pre-fail  Always       -       0/,
               "Reallocated_Sector_Ct   0x0033   100   100   010    Pre-fail  Always  -  112")
      .replace("Current_Pending_Sector  0x0012   100   100   000    Old_age  Always       -       0",
               "Current_Pending_Sector  0x0012   100   100   000    Old_age  Always   -   7"),
    "sata2"
  );
  assert.equal(d.smartPassed, false);
  assert.equal(d.reallocatedSectors, 112);
  assert.equal(d.pendingSectors, 7);
});

test("nvme smart-log parses incl. sysfs model/serial tail", () => {
  const d = collector._parseNvmeSmartLog(NVME_TEXT, "nvme0n1");
  assert.equal(d.kind, "nvme");
  assert.equal(d.model, "SAMSUNG MZVLQ512HBLU-00B");
  assert.equal(d.serial, "S6F1NE0R328704");
  assert.equal(d.tempC, 25);
  assert.equal(d.smartPassed, true);
  assert.equal(d.percentageUsed, 0);
  assert.equal(d.availableSparePct, 100);
  assert.equal(d.powerOnHours, 12345);
});

test("smartctl failure text (no smart data) yields null", () => {
  assert.equal(collector._parseSmartctlText("Smartctl open device: /dev/sata9 failed: No such file\n", "sata9"), null);
  assert.equal(collector._parseNvmeSmartLog("could not identify nvme output", "nvme0n1"), null);
});

test("collectDrives skips local/windows/mac hosts entirely", async () => {
  const local = new SystemCollector({ ...spark, isLocal: true });
  assert.equal(await local.collectDrives(), undefined);
});
