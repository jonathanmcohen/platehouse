// Read-only queries for the Activity page (app-api/activity.ts; the maintainer,
// 2026-11-19). Nothing here writes. Every query is a count, a group-by or a
// short ordered list with a LIMIT, run once per page load or poll; none
// loops over plates or files.
//
// Two of them read pg-boss's own tables in its schema (BOSS_SCHEMA): the
// live job counts by queue and job kind, and the last run of each
// maintenance task. pg-boss's getQueues() answers per queue only, from
// counts its monitor caches, and the slicer queue holds three kinds of
// work (slices, OpenSCAD renders, STEP conversions) that the page shows
// apart, so the counts come from pgboss.job directly. That query filters on
// the queue name and the live states, which pg-boss's own partial index
// job_i14 (name, state, ...) WHERE state in (created, retry, active,
// failed) covers. The last runs use job_i16 (name, completed_on). pg-boss
// is pinned to an exact version (apps/server/package.json); the
// integration test runs these against the real pg-boss schema, so an
// upgrade that changes it fails there first.
//
// The estimate counts have no index of their own on (printer_id, status):
// the estimates table holds one row per plate, source, printer and Orca
// version (a few thousand rows for a library of 463 plates), so the scan is cheap,
// and adding an index would need a migration this page does not justify.
import { type Kysely, sql } from "kysely";
import type { DB, FileKind } from "../db/types.js";
import { BOSS_SCHEMA } from "../jobs/boss.js";

export interface LibraryCounts {
  models: { live: number; trashed: number };
  /** Files on live models, by kind; every kind is present, 0 when none. */
  files: Record<FileKind, number>;
  /** Plates of files on live models. */
  plates: number;
  /** Blobs whose upload was verified (state 'stored'), trashed models' included: what the bucket holds. */
  blobs: { count: number; bytes: number };
  /** When the newest file arrived, by any route; null with none. */
  lastImportAt: Date | null;
}

export interface EstimateCounts {
  ok: number;
  pending: number;
  running: number;
  failed: number;
  /** Estimates that finished (ok or failed) since the window start. */
  recentFinished: number;
  /** When the first of those finished; null with none. */
  firstRecent: Date | null;
}

/** One group of live pg-boss jobs: a queue, a job kind (or maintenance task) and a state. */
export interface QueueCount {
  queue: string;
  /** data.kind (slicer queue) or data.task (maintenance queue); null when the job names neither. */
  kind: string | null;
  state: "created" | "retry" | "active" | "failed";
  n: number;
}

/** The newest finished run of one maintenance task that pg-boss still keeps. */
export interface LastRun {
  task: string;
  state: "completed" | "failed";
  at: Date;
}

export interface RecentModel {
  id: string;
  name: string;
  createdAt: Date;
  trashed: boolean;
  /** The model was made through the public API with an external reference (the Manyfold import, say). */
  apiRef: boolean;
  /** An ingest job pg-boss still keeps made this model: a web or API upload (the inbox never queues one). */
  uploaded: boolean;
}

export interface FailedEstimate {
  id: string;
  modelId: string;
  modelName: string;
  plateIndex: number;
  plateName: string | null;
  failureCode: number | null;
  failureReason: string | null;
  failureDetail: string | null;
  finishedAt: Date;
}

export interface FailedDerived {
  fileId: string;
  fileName: string;
  kind: FileKind;
  modelId: string;
  modelName: string;
  message: string | null;
  at: Date;
}

const FILE_KINDS: readonly FileKind[] = ["3mf", "stl", "step", "scad"];

export function activityRepo(db: Kysely<DB>) {
  const job = sql.id(BOSS_SCHEMA, "job");

  return {
    async libraryCounts(): Promise<LibraryCounts> {
      const { rows } = await sql<{
        live: number;
        trashed: number;
        plates: number;
        blobs: number;
        bytes: number;
        last: Date | null;
      }>`
        select
          (select count(*)::int from models where trashed_at is null) as live,
          (select count(*)::int from models where trashed_at is not null) as trashed,
          (select count(*)::int
             from plates p
             join files f on f.id = p.file_id
             join models m on m.id = f.model_id
            where m.trashed_at is null) as plates,
          (select count(*)::int from blobs where state = 'stored') as blobs,
          (select coalesce(sum(size), 0)::bigint from blobs where state = 'stored') as bytes,
          (select max(created_at) from files) as last
      `.execute(db);
      const kinds = await sql<{ kind: FileKind; n: number }>`
        select f.kind as kind, count(*)::int as n
          from files f
          join models m on m.id = f.model_id
         where m.trashed_at is null
         group by f.kind
      `.execute(db);
      const files = Object.fromEntries(FILE_KINDS.map((k) => [k, 0])) as Record<FileKind, number>;
      for (const row of kinds.rows) if (row.kind in files) files[row.kind] = row.n;
      const row = rows[0];
      return {
        models: { live: row?.live ?? 0, trashed: row?.trashed ?? 0 },
        files,
        plates: row?.plates ?? 0,
        blobs: { count: row?.blobs ?? 0, bytes: row?.bytes ?? 0 },
        lastImportAt: row?.last ?? null,
      };
    },

    /**
     * Platehouse estimates for one printer on live models, by status, and how
     * many finished since `since`. With orcaVersion, only that Orca version's
     * estimates: an Orca update queues the library again under the new
     * version, and the older rows are history.
     */
    async estimateCounts(
      printerId: string,
      orcaVersion: string | null,
      since: Date,
    ): Promise<EstimateCounts> {
      const version = orcaVersion === null ? sql`` : sql`and e.slicer_version = ${orcaVersion}`;
      const { rows } = await sql<{
        ok: number;
        pending: number;
        running: number;
        failed: number;
        recent: number;
        first: Date | null;
      }>`
        select
          count(*) filter (where e.status = 'ok')::int as ok,
          count(*) filter (where e.status = 'pending')::int as pending,
          count(*) filter (where e.status = 'running')::int as running,
          count(*) filter (where e.status = 'failed')::int as failed,
          count(*) filter (where e.status in ('ok', 'failed') and e.finished_at >= ${since})::int
            as recent,
          min(e.finished_at) filter (where e.status in ('ok', 'failed') and e.finished_at >= ${since})
            as first
          from estimates e
          join plates p on p.id = e.plate_id
          join files f on f.id = p.file_id
          join models m on m.id = f.model_id
         where e.source = 'platehouse'
           and e.printer_id = ${printerId}
           ${version}
           and m.trashed_at is null
      `.execute(db);
      const row = rows[0];
      return {
        ok: row?.ok ?? 0,
        pending: row?.pending ?? 0,
        running: row?.running ?? 0,
        failed: row?.failed ?? 0,
        recentFinished: row?.recent ?? 0,
        firstRecent: row?.first ?? null,
      };
    },

    /** Live pg-boss jobs on the given queues, grouped by queue, job kind and state. */
    async queueCounts(queues: readonly string[]): Promise<QueueCount[]> {
      const { rows } = await sql<QueueCount>`
        select name as queue,
               coalesce(data->>'kind', data->>'task') as kind,
               state::text as state,
               count(*)::int as n
          from ${job}
         where name = any(${[...queues]}::text[])
           -- Written as pg-boss writes its partial index's predicate (the
           -- job_state enum, not text), so the planner can use job_i14.
           and state in ('created', 'retry', 'active', 'failed')
         group by 1, 2, 3
      `.execute(db);
      return rows;
    },

    /** The newest finished run pg-boss still keeps of each task on the maintenance queue. */
    async lastRuns(queue: string): Promise<LastRun[]> {
      const { rows } = await sql<LastRun>`
        select distinct on (data->>'task')
               data->>'task' as task,
               state::text as state,
               completed_on as at
          from ${job}
         where name = ${queue}
           and completed_on is not null
           and state in ('completed', 'failed')
           and data->>'task' is not null
         order by data->>'task', completed_on desc
      `.execute(db);
      return rows;
    },

    /**
     * The newest models, trashed ones included. uploaded looks for an
     * ingest job made no more than a day before the model whose output
     * names it: the job is queued when the upload finishes, before the model
     * row exists, and pg-boss deletes a finished job 7 days after it ends.
     * A file uploaded later into an older model is not counted, since its
     * job is newer than the model.
     */
    async recentModels(ingestQueue: string, limit: number): Promise<RecentModel[]> {
      const { rows } = await sql<{
        id: string;
        name: string;
        created: Date;
        trashed: boolean;
        ref: boolean;
        uploaded: boolean;
      }>`
        select m.id as id,
               m.name as name,
               m.created_at as created,
               m.trashed_at is not null as trashed,
               m.external_ref is not null as ref,
               exists (
                 select 1 from ${job} j
                  where j.name = ${ingestQueue}
                    and j.created_on <= m.created_at
                    and j.created_on >= m.created_at - interval '1 day'
                    and j.output->>'modelId' = m.id::text
               ) as uploaded
          from models m
         order by m.created_at desc, m.id desc
         limit ${limit}
      `.execute(db);
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.created,
        trashed: r.trashed,
        apiRef: r.ref,
        uploaded: r.uploaded,
      }));
    },

    /** Failed Platehouse estimates for one printer (and Orca version) on live models, newest first. */
    async failedEstimates(
      printerId: string,
      orcaVersion: string | null,
      limit: number,
    ): Promise<FailedEstimate[]> {
      let query = db
        .selectFrom("estimates as e")
        .innerJoin("plates as p", "p.id", "e.plateId")
        .innerJoin("files as f", "f.id", "p.fileId")
        .innerJoin("models as m", "m.id", "f.modelId")
        .select([
          "e.id as id",
          "m.id as modelId",
          "m.name as modelName",
          "p.index as plateIndex",
          "p.name as plateName",
          "e.failureCode as failureCode",
          "e.failureReason as failureReason",
          "e.failureDetail as failureDetail",
          "e.finishedAt as finishedAt",
          "e.createdAt as createdAt",
        ])
        .where("e.source", "=", "platehouse")
        .where("e.status", "=", "failed")
        .where("e.printerId", "=", printerId)
        .where("m.trashedAt", "is", null);
      if (orcaVersion !== null) query = query.where("e.slicerVersion", "=", orcaVersion);
      const rows = await query
        .orderBy(sql`coalesce(e.finished_at, e.created_at)`, "desc")
        .orderBy("e.id", "desc")
        .limit(limit)
        .execute();
      return rows.map((r) => ({
        id: r.id,
        modelId: r.modelId,
        modelName: r.modelName,
        plateIndex: r.plateIndex,
        plateName: r.plateName,
        failureCode: r.failureCode,
        failureReason: r.failureReason,
        failureDetail: r.failureDetail,
        finishedAt: r.finishedAt ?? r.createdAt,
      }));
    },

    /**
     * Files on live models whose OpenSCAD render or STEP conversion failed
     * (derived_status 'failed'), newest first. The time is the file row's
     * updated_at, which the render job sets when it records the failure (a
     * later rename moves it too).
     */
    async failedDerived(limit: number): Promise<FailedDerived[]> {
      const rows = await db
        .selectFrom("files as f")
        .innerJoin("models as m", "m.id", "f.modelId")
        .select([
          "f.id as fileId",
          "f.name as fileName",
          "f.kind as kind",
          "m.id as modelId",
          "m.name as modelName",
          "f.derivedMessage as message",
          "f.updatedAt as at",
        ])
        .where("f.derivedStatus", "=", "failed")
        .where("m.trashedAt", "is", null)
        .orderBy("f.updatedAt", "desc")
        .orderBy("f.id", "desc")
        .limit(limit)
        .execute();
      return rows;
    },
  };
}

export type ActivityRepo = ReturnType<typeof activityRepo>;
