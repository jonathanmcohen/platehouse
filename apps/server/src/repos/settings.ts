import type { Kysely } from "kysely";
import type { BucketVersioning, DB } from "../db/types.js";

export interface Settings {
  printerId: string;
  lastOrcaVersion: string | null;
  bucketVersioning: BucketVersioning;
  updatedAt: Date;
}

export type SettingsPatch = Partial<
  Pick<Settings, "printerId" | "lastOrcaVersion" | "bucketVersioning">
>;

export function settingsRepo(_db: Kysely<DB>) {
  return {
    async get(): Promise<Settings> {
      throw new Error("not implemented: settings.get");
    },
    async update(_patch: SettingsPatch): Promise<Settings> {
      throw new Error("not implemented: settings.update");
    },
  };
}

export type SettingsRepo = ReturnType<typeof settingsRepo>;
