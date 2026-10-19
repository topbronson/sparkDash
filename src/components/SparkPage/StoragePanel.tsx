import { useState, useCallback, useEffect } from "react";
import type { StorageMetrics, SmartDrive, DriveHistoryMap } from "../../api/types";
import { updateDisabledDevices, refreshSparkMetric, updateSpark, getDriveHistory } from "../../api/client";
import { Panel } from "../ui/Panel";
import { Sparkline } from "../ui/Sparkline";
import { DiskIcon, GearIcon, RotateIcon } from "../ui/icons";
import { formatBytesPerSec, formatGb } from "../../shared/formatBytes";

interface StoragePanelProps {
  storage: StorageMetrics[];
  smart?: SmartDrive[];
  sparkId: string;
  disabledDevices: string[];
  onDisabledChange: (devices: string[]) => void;
  storagePollDisabled?: boolean;
  onStoragePollModeChange?: (disabled: boolean) => void;
}

function UsageBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const barColor = pct > 85 ? "bg-danger" : pct > 60 ? "bg-warning" : "bg-info";
  return (
    <div className="sp-bar">
      <div
        className={`metric-bar-fill sp-bar__fill ${barColor}`}
        style={{ ["--bar-pct" as string]: `${pct}%` }}
      />
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`sp-toggle ${checked ? "is-on" : ""}`}
      aria-pressed={checked}
    />
  );
}

function SettingsButton({
  active,
  onClick,
  disabled,
  label,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      title={active ? "Done" : `${label} settings`}
      onClick={onClick}
      disabled={disabled}
      className={`btn btn--sm btn--ghost ${active ? "is-on" : ""}`}
    >
      <GearIcon />
      <span>{active ? "Done" : "Settings"}</span>
    </button>
  );
}

export function StoragePanel({
  storage,
  smart,
  sparkId,
  disabledDevices,
  onDisabledChange,
  storagePollDisabled = false,
  onStoragePollModeChange,
}: StoragePanelProps) {
  const [showSettings, setShowSettings] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Long-horizon SMART trend for the drive strip (fetched once per spark visit).
  const [driveHist, setDriveHist] = useState<DriveHistoryMap | null>(null);
  const driveCount = smart?.length ?? 0;
  useEffect(() => {
    if (!sparkId || driveCount === 0) return;
    let on = true;
    getDriveHistory(sparkId)
      .then((h) => {
        if (on) setDriveHist(h);
      })
      .catch(() => {
        /* no history endpoint / empty: strip renders without trend */
      });
    return () => {
      on = false;
    };
  }, [sparkId, driveCount]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshSparkMetric(sparkId, "storage");
    } catch (err) {
      console.error("Failed to refresh storage:", err);
    } finally {
      setRefreshing(false);
    }
  }, [sparkId]);

  const handleToggle = async (device: string, disabled: boolean) => {
    const newDisabled = disabled
      ? [...new Set([...disabledDevices, device])]
      : disabledDevices.filter((d) => d !== device);

    setSaving(true);
    try {
      await updateDisabledDevices(sparkId, newDisabled);
      onDisabledChange(newDisabled);
    } catch (err) {
      console.error("Failed to update disabled devices:", err);
    } finally {
      setSaving(false);
    }
  };

  // Settings: full list. Main view: enabled only.
  const visibleDisks = storage.filter(
    (d) => !d.disabled && !disabledDevices.includes(d.device) && !disabledDevices.includes(d.label)
  );

  const totalRead = visibleDisks.reduce((a, d) => a + (d.readSpeed || 0), 0);
  const totalWrite = visibleDisks.reduce((a, d) => a + (d.writeSpeed || 0), 0);

  // mdraid health summary (data-station / any md host): union of arrays behind visible disks.
  const raidArrays = new Map<string, NonNullable<(typeof visibleDisks)[number]["raid"]>[number]>();
  for (const d of visibleDisks) for (const a of d.raid || []) raidArrays.set(a.name, a);
  const raidList = [...raidArrays.values()];
  const raidBad = raidList.filter((a) => a.state !== "ok");
  const raidBusy = raidList.filter((a) => a.rebuilding);

  return (
    <Panel
      title="Storage"
      icon={<DiskIcon />}
      className="panel-storage"
      bodyClassName="sp-stack"
      actions={
        <div className="sp-actions">
          {!showSettings && visibleDisks.length > 0 && (
            <span className="mono sp-muted sp-nowrap sp-actions__lead" title="Combined disk throughput">
              r {formatBytesPerSec(totalRead)} · w {formatBytesPerSec(totalWrite)}
            </span>
          )}
          {!showSettings && raidList.length > 0 && (
            <span
              className="mono sp-nowrap sp-muted"
              title={raidList.map((a) => `${a.name} ${a.level}: ${a.members.join(",")} ${a.state}${a.rebuilding ? " (resync)" : ""}`).join("\n")}
              style={raidBad.length ? { color: "#f87171" } : undefined}
            >
              {raidBad.length
                ? `RAID degraded: ${raidBad.map((a) => a.name).join(", ")}`
                : `RAID ${raidList.map((a) => a.name).join(",")}${raidBusy.length ? " · resync" : ""} ✓`}
            </span>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Refresh storage"
            aria-label="Refresh storage"
            className="btn btn--sm btn--ghost"
          >
            <RotateIcon className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
            <span>{refreshing ? "Refreshing…" : "Refresh"}</span>
          </button>
          <SettingsButton
            active={showSettings}
            onClick={() => setShowSettings(!showSettings)}
            disabled={saving}
            label="Storage"
          />
        </div>
      }
    >
      {showSettings ? (
        <div className="sp-stack">
          <p className="sp-hint">Toggle devices on/off:</p>
          {storage.length === 0 ? (
            <p className="sp-muted">No disks discovered</p>
          ) : (
            storage.map((disk) => {
              const isDisabled =
                disk.disabled === true ||
                disabledDevices.includes(disk.device) ||
                disabledDevices.includes(disk.label);
              return (
                <div
                  key={`${disk.device}:${disk.label}`}
                  className="sp-list-row"
                >
                  <div className="sp-list-row__main">
                    <span className="sp-clip">{disk.device}</span>
                    <span className="sp-muted">({disk.label})</span>
                  </div>
                  <Toggle checked={!isDisabled} onChange={(v) => handleToggle(disk.device, !v)} />
                </div>
              );
            })
          )}

          <div className="sp-section">
            <label className="sp-row">
              <span>Auto-refresh</span>
              <Toggle
                checked={!storagePollDisabled}
                onChange={(on) => {
                  setShowSettings(false);
                  onStoragePollModeChange?.(!on);
                }}
              />
            </label>
            <p className="sp-hint">
              {storagePollDisabled
                ? "Refresh manually using the button above"
                : "Updates every few seconds"}
            </p>
          </div>
        </div>
      ) : (
        <>
          {visibleDisks.length === 0 ? (
            <p className="sp-muted">No mounted disks</p>
          ) : (
            <div className="sp-stack">
              {visibleDisks.map((disk) => {
                return (
                  <div key={`${disk.device}:${disk.label}`}>
                    <div className="sp-lbl">
                      <span className="sp-clip">
                        {disk.label} · {disk.device}
                      </span>
                      <b>
                        {formatGb(disk.used)} / {formatGb(disk.total)}
                      </b>
                    </div>
                    <UsageBar value={disk.used} max={disk.total} />
                    <div className="sp-lbl sp-lbl--sub">
                      <span className="mono">
                        <span className="text-accent">↑</span> {formatBytesPerSec(disk.writeSpeed || 0)}
                        <span className="sp-sep">·</span>
                        <span className="text-accent">↓</span> {formatBytesPerSec(disk.readSpeed || 0)}
                      </span>
                      <span className="mono">
                        {disk.raid && disk.raid.length > 0 && (
                          <>
                            {disk.raid.map((a) => (
                              <span
                                key={a.name}
                                title={`${a.name} ${a.level}: ${a.members.join(",")} ${a.state}`}
                                style={a.state !== "ok" ? { color: "#f87171" } : undefined}
                              >
                                {a.name}
                                {a.state !== "ok" ? " ✗" : a.rebuilding ? "↻" : ""}{" "}
                              </span>
                            ))}
                            <span className="sp-sep">·</span>
                          </>
                        )}
                        {formatGb(disk.available)} free
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {smart && smart.length > 0 && (
            <div className="sp-stack">
              {smart.map((d) => {
                const bad =
                  d.smartPassed === false ||
                  (d.reallocatedSectors ?? 0) > 0 ||
                  (d.pendingSectors ?? 0) > 0 ||
                  (d.uncorrectedSectors ?? 0) > 0;
                const hot = d.tempC !== null && d.tempC >= 55;
                const warm = d.tempC !== null && d.tempC >= 48;
                const capGb = d.capacityBytes ? Math.round(d.capacityBytes / 1e9) : null;
                return (
                  <div key={d.device} className="sp-lbl sp-lbl--sub">
                    <span className="sp-clip mono" title={`${d.model || d.device} · ${d.serial || "no serial"}`}>
                      <span style={bad ? { color: "#f87171" } : undefined}>
                        {d.device} {bad ? "✗" : "✓"}
                      </span>{" "}
                      <span className="sp-muted">{d.model?.split(" ")[0] || d.kind}</span>
                    </span>
                    <span className="mono sp-muted sp-nowrap">
                      {d.tempC !== null && (
                        <span style={hot ? { color: "#f87171" } : warm ? { color: "#fbbf24" } : undefined}>
                          {d.tempC}°C
                        </span>
                      )}
                      {capGb !== null && (
                        <>
                          <span className="sp-sep">·</span>
                          {capGb}GB
                        </>
                      )}
                      {d.powerOnHours !== null && (
                        <>
                          <span className="sp-sep">·</span>
                          {(d.powerOnHours / 8760).toFixed(1)}y
                        </>
                      )}
                      {(d.reallocatedSectors ?? 0) > 0 && (
                        <>
                          <span className="sp-sep">·</span>
                          <span style={{ color: "#f87171" }}>reall {d.reallocatedSectors}</span>
                        </>
                      )}
                      {(d.pendingSectors ?? 0) > 0 && (
                        <>
                          <span className="sp-sep">·</span>
                          <span style={{ color: "#f87171" }}>pend {d.pendingSectors}</span>
                        </>
                      )}
                      {d.percentageUsed != null && (
                        <>
                          <span className="sp-sep">·</span>
                          used {d.percentageUsed}%
                        </>
                      )}
                      {(() => {
                        const hist = driveHist?.[d.device];
                        if (!hist || hist.length < 2) return null;
                        // Pick ONE field per drive (first that exists anywhere), so a
                        // series never mixes units and missing points are gaps, not zeros.
                        const field =
                          d.kind === "nvme"
                            ? hist.some((s) => s.availableSparePct != null)
                              ? "availableSparePct"
                              : hist.some((s) => s.tempC != null)
                                ? "tempC"
                                : null
                            : hist.some((s) => s.pending != null)
                              ? "pending"
                              : hist.some((s) => s.realloc != null)
                                ? "realloc"
                                : null;
                        if (!field) return null;
                        const series = hist
                          .map((s) => s[field])
                          .filter((v): v is number => typeof v === "number");
                        if (series.length < 2) return null;
                        const mn = Math.min(...series);
                        const mx = Math.max(...series);
                        const label =
                          field === "availableSparePct"
                            ? `spare ${mn}–${mx}%`
                            : field === "tempC"
                              ? `${mn}–${mx}°C`
                              : `pend ${mn}–${mx}`;
                        return (
                          <>
                            <span className="sp-sep">·</span>
                            <span
                              title={`${series.length} samples · ${label}`}
                              style={{ verticalAlign: "middle" }}
                            >
                              <Sparkline
                                data={series}
                                width={64}
                                height={16}
                                color={bad ? "#f87171" : "var(--color-accent)"}
                              />
                            </span>
                          </>
                        );
                      })()}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}