import { type Kysely, sql } from "kysely";
import type { BucketVersioning, DB } from "../db/types.js";

// The single settings row, seeded by migration 0001.

export interface Settings {
  printerId: string;
  lastOrcaVersion: string | null;
  bucketVersioning: BucketVersioning;
  updatedAt: Date;
}

export type SettingsPatch = Partial<
  Pick<Settings, "printerId" | "lastOrcaVersion" | "bucketVersioning">
>;

const COLUMNS = ["printerId", "lastOrcaVersion", "bucketVersioning", "updatedAt"] as const;

export function settingsRepo(db: Kysely<DB>) {
  return {
    async get(): Promise<Settings> {
      return db.selectFrom("settings").select(COLUMNS).executeTakeFirstOrThrow();
    },

    /** Changes only the fields the patch names, and returns the new settings. */
    async update(patch: SettingsPatch): Promise<Settings> {
      return db
        .updateTable("settings")
        .set({
          ...(patch.printerId === undefined ? {} : { printerId: patch.printerId }),
          ...(patch.lastOrcaVersion === undefined
            ? {}
            : { lastOrcaVersion: patch.lastOrcaVersion }),
          ...(patch.bucketVersioning === undefined
            ? {}
            : { bucketVersioning: patch.bucketVersioning }),
          updatedAt: sql`now()`,
        })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
    },
  };
}

export type SettingsRepo = ReturnType<typeof settingsRepo>;
