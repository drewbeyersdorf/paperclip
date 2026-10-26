import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseBackupRunHealth, inspectDatabaseBackupHealth } from "../services/database-backup-health.js";

describe("database backup run health", () => {
  let backupDir: string;
  beforeEach(() => {
    backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-backup-run-health-"));
    fs.writeFileSync(path.join(backupDir, "recent.sql.gz"), "existing backup");
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(backupDir, { recursive: true, force: true });
  });

  it("does not invent a run result before this process completes a backup", () => {
    const monitor = createDatabaseBackupRunHealth();
    const health = inspectDatabaseBackupHealth({ enabled: true, backupDir, maxAgeHours: 26, getLastRun: monitor.getLastRun });
    expect(health.lastRun).toBeNull();
    expect(health.status).toBe("ok");
  });

  it("reports success, ENOSPC failure, then recovery even with a fresh older backup", async () => {
    vi.useFakeTimers();
    const monitor = createDatabaseBackupRunHealth();
    const inspect = () => inspectDatabaseBackupHealth({ enabled: true, backupDir, maxAgeHours: 26, getLastRun: monitor.getLastRun });
    vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
    const previousBackupAt = new Date("2026-01-01T23:30:00Z");
    fs.utimesSync(path.join(backupDir, "recent.sql.gz"), previousBackupAt, previousBackupAt);
    await expect(monitor.run("scheduled", async () => "first backup")).resolves.toBe("first backup");
    expect(inspect().lastRun).toEqual({ trigger: "scheduled", status: "succeeded", finishedAt: "2026-01-02T00:00:00.000Z" });
    const failure = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    vi.setSystemTime(new Date("2026-01-02T01:00:00Z"));
    await expect(monitor.run("scheduled", async () => { throw failure; })).rejects.toBe(failure);
    expect(inspect()).toMatchObject({
      status: "warning",
      lastRun: { trigger: "scheduled", status: "failed", finishedAt: "2026-01-02T01:00:00.000Z" },
      warnings: [{ code: "database_backup_run_failed" }],
    });
    vi.setSystemTime(new Date("2026-01-02T02:00:00Z"));
    await monitor.run("manual", async () => "recovery backup");
    expect(inspect()).toMatchObject({ status: "ok", lastRun: { trigger: "manual", status: "succeeded" }, warnings: [] });
  });

  it("keeps a failure visible during a retry and preserves independent failure markers", async () => {
    const monitor = createDatabaseBackupRunHealth();
    await expect(monitor.run("scheduled", async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    let finish!: () => void;
    const pending = monitor.run("manual", () => new Promise<void>((resolve) => { finish = resolve; }));
    expect(monitor.getLastRun()?.status).toBe("failed");
    fs.writeFileSync(path.join(backupDir, "db-backup-to-s3.failure"), "Remote copy failed");
    finish();
    await pending;
    const health = inspectDatabaseBackupHealth({ enabled: true, backupDir, maxAgeHours: 26, getLastRun: monitor.getLastRun });
    expect(health.lastRun?.status).toBe("succeeded");
    expect(health.status).toBe("warning");
    expect(health.warnings).toEqual([{ code: "database_backup_last_failure", message: "Remote copy failed" }]);
  });
});
