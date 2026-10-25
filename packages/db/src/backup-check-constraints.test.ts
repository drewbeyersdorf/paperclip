import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { runDatabaseBackup, runDatabaseRestore } from "./backup-lib.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
}, 60_000);

async function fixture() {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-check-backup-");
  cleanups.push(db.cleanup);
  const admin = postgres(db.connectionString, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe('CREATE DATABASE "check_source"');
    await admin.unsafe('CREATE DATABASE "check_restore"');
  } finally {
    await admin.end();
  }
  // The embedded helper's original database includes application migrations.
  // Use empty sibling databases so these fixtures cover only their own schema.
  const sourceUrl = new URL(db.connectionString);
  sourceUrl.pathname = "/check_source";
  const source = postgres(sourceUrl.toString(), { max: 1, onnotice: () => {} });
  const restoreUrl = new URL(db.connectionString);
  restoreUrl.pathname = "/check_restore";
  const target = postgres(restoreUrl.toString(), { max: 1, onnotice: () => {} });
  cleanups.push(async () => { await source.end(); await target.end(); });
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-check-backup-"));
  cleanups.push(() => fs.rmSync(backupDir, { recursive: true, force: true }));
  return { source, target, connectionString: sourceUrl.toString(), restoreUrl: restoreUrl.toString(), backupDir };
}

async function checkCatalog(sql: ReturnType<typeof postgres>) {
  return await sql`
    SELECT n.nspname AS schema_name, t.relname AS table_name, c.conname,
           c.convalidated, c.connoinherit, pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'c' AND n.nspname IN ('public', 'check"scope')
    ORDER BY n.nspname, t.relname, c.conname
  `;
}

describePostgres("table CHECK constraints in JavaScript backups", () => {
  it.each(["javascript", "auto"] as const)(
    "preserves definitions, validation state, and enforcement with %s",
    async (backupEngine) => {
      const { source, target, connectionString, restoreUrl, backupDir } = await fixture();
      const originalPgDump = process.env.PAPERCLIP_PG_DUMP_PATH;
      // The auto case must exercise fallback even on hosts with pg_dump installed.
      process.env.PAPERCLIP_PG_DUMP_PATH = path.join(backupDir, "missing-pg-dump");
      try {
        await source.unsafe(`
          CREATE SCHEMA "check""scope";
          CREATE FUNCTION "check""scope".is_positive(integer) RETURNS boolean
            LANGUAGE sql IMMUTABLE AS 'SELECT $1 > 0';
          CREATE TABLE public.checked_rows (
            amount integer CONSTRAINT "positive""amount" CHECK (amount > 0) NO INHERIT,
            ceiling integer,
            CONSTRAINT bounded_amount CHECK (amount <= ceiling)
          );
          INSERT INTO public.checked_rows VALUES (2, 3);
          CREATE TABLE "check""scope"."checked""rows" (
            amount integer,
            CONSTRAINT plugin_positive CHECK ("check""scope".is_positive(amount))
          );
          INSERT INTO "check""scope"."checked""rows" VALUES (3);
          CREATE TABLE public.historical_rows (amount integer);
          INSERT INTO public.historical_rows VALUES (-1), (2);
          ALTER TABLE public.historical_rows ADD CONSTRAINT future_positive
            CHECK (amount > 0) NOT VALID;
        `);
        const before = await checkCatalog(source);
        expect(before).toHaveLength(4);
        const backup = await runDatabaseBackup({
          connectionString, backupDir, backupEngine,
          retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 },
        });
        await runDatabaseRestore({ connectionString: restoreUrl, backupFile: backup.backupFile });
        expect(await checkCatalog(target)).toEqual(before);
        expect(await target`SELECT amount FROM public.historical_rows ORDER BY amount`)
          .toEqual([{ amount: -1 }, { amount: 2 }]);
        await expect(target`INSERT INTO public.checked_rows VALUES (-1, 3)`)
          .rejects.toMatchObject({ code: "23514", constraint_name: 'positive"amount' });
        await expect(target`INSERT INTO public.checked_rows VALUES (4, 3)`)
          .rejects.toMatchObject({ code: "23514", constraint_name: "bounded_amount" });
        await expect(target.unsafe('INSERT INTO "check""scope"."checked""rows" VALUES (-1)'))
          .rejects.toMatchObject({ code: "23514", constraint_name: "plugin_positive" });
        await expect(target`INSERT INTO public.historical_rows VALUES (-2)`)
          .rejects.toMatchObject({ code: "23514", constraint_name: "future_positive" });
        await expect(target`UPDATE public.historical_rows SET amount = -3 WHERE amount = -1`)
          .rejects.toMatchObject({ code: "23514", constraint_name: "future_positive" });
        await target`INSERT INTO public.checked_rows VALUES (3, 3)`;
        await target`INSERT INTO public.historical_rows VALUES (3)`;
      } finally {
        if (originalPgDump === undefined) delete process.env.PAPERCLIP_PG_DUMP_PATH;
        else process.env.PAPERCLIP_PG_DUMP_PATH = originalPgDump;
      }
    },
    60_000,
  );

  it("keeps constraints when rows are excluded and scopes transforms to the named table", async () => {
    const { source, target, connectionString, restoreUrl, backupDir } = await fixture();
    await source.unsafe(`
      CREATE SCHEMA "check""scope";
      CREATE TABLE public.filtered_rows (amount integer CHECK (amount > 0));
      CREATE TABLE "check""scope".filtered_rows (amount integer CHECK (amount > 0));
      INSERT INTO public.filtered_rows VALUES (1);
      INSERT INTO "check""scope".filtered_rows VALUES (2);
      CREATE TABLE public.redacted_rows (note text CHECK (note IS NULL OR length(note) > 2));
      INSERT INTO public.redacted_rows VALUES ('redact me');
    `);
    const before = await checkCatalog(source);
    const backup = await runDatabaseBackup({
      connectionString, backupDir, backupEngine: "javascript",
      excludeTables: ["filtered_rows"], nullifyColumns: { redacted_rows: ["note"] },
      retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 },
    });
    await runDatabaseRestore({ connectionString: restoreUrl, backupFile: backup.backupFile });
    expect(await checkCatalog(target)).toEqual(before);
    expect(await target`SELECT * FROM public.filtered_rows`).toHaveLength(0);
    expect(await target.unsafe('SELECT * FROM "check""scope".filtered_rows')).toEqual([{ amount: 2 }]);
    expect(await target`SELECT * FROM public.redacted_rows`).toEqual([{ note: null }]);
    await expect(target`INSERT INTO public.filtered_rows VALUES (-1)`).rejects.toMatchObject({ code: "23514" });
  }, 60_000);

  it("fails and rolls back a restore when transformed rows violate a validated CHECK", async () => {
    const { source, target, connectionString, restoreUrl, backupDir } = await fixture();
    await source.unsafe(`
      CREATE TABLE public.required_note (note text CONSTRAINT note_required CHECK (note IS NOT NULL));
      INSERT INTO public.required_note VALUES ('present');
    `);
    const backup = await runDatabaseBackup({
      connectionString, backupDir, backupEngine: "javascript",
      nullifyColumns: { required_note: ["note"] },
      retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 },
    });
    await expect(runDatabaseRestore({ connectionString: restoreUrl, backupFile: backup.backupFile }))
      .rejects.toThrow(/note_required/);
    expect(await target`SELECT to_regclass('public.required_note')::text AS name`).toEqual([{ name: null }]);
    expect(await source`SELECT * FROM public.required_note`).toEqual([{ note: "present" }]);
  }, 60_000);

  it("binds CHECK functions to their original schema when the restore search_path differs", async () => {
    const { source, target, connectionString, restoreUrl, backupDir } = await fixture();
    await source.unsafe(`
      CREATE FUNCTION public.is_positive(integer) RETURNS boolean
        LANGUAGE sql IMMUTABLE AS 'SELECT $1 > 0';
      CREATE TABLE public.checked_rows (amount integer CHECK (public.is_positive(amount)));
      INSERT INTO public.checked_rows VALUES (1);
    `);
    await target.unsafe(`
      CREATE SCHEMA shadow;
      CREATE FUNCTION shadow.is_positive(integer) RETURNS boolean
        LANGUAGE sql IMMUTABLE AS 'SELECT $1 < 0';
    `);
    const backup = await runDatabaseBackup({
      connectionString, backupDir, backupEngine: "javascript",
      retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 },
    });
    const alternatePath = new URL(restoreUrl);
    alternatePath.searchParams.set("options", "-c search_path=shadow,public");
    await runDatabaseRestore({ connectionString: alternatePath.toString(), backupFile: backup.backupFile });
    await expect(target`INSERT INTO public.checked_rows VALUES (-1)`)
      .rejects.toMatchObject({ code: "23514" });
    await target`INSERT INTO public.checked_rows VALUES (2)`;
    const dependencies = await target`
      SELECT n.nspname FROM pg_depend d
      JOIN pg_constraint c ON c.oid = d.objid
      JOIN pg_proc p ON p.oid = d.refobjid
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE d.classid = 'pg_constraint'::regclass AND d.refclassid = 'pg_proc'::regclass
        AND c.conrelid = 'public.checked_rows'::regclass AND p.proname = 'is_positive'
    `;
    expect(dependencies).toEqual([{ nspname: "public" }]);
  }, 60_000);
});
