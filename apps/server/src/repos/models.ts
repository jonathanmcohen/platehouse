import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";

export interface Model {
  id: string;
  name: string;
  caption: string | null;
  descriptionMd: string | null;
  creatorId: string | null;
  /** The creator's name, or null when the model has no creator. */
  creator: string | null;
  licenseSpdx: string | null;
  licenseNote: string | null;
  externalRef: string | null;
  trashedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewModel {
  id?: string;
  name: string;
  caption?: string | null;
  descriptionMd?: string | null;
  /** A creator name; the creator row is made on first use. */
  creator?: string | null;
  licenseSpdx?: string | null;
  licenseNote?: string | null;
  externalRef?: string | null;
}

export interface SearchQuery {
  q: string;
  limit?: number;
}

export function modelsRepo(_db: Kysely<DB>) {
  return {
    async create(_input: NewModel): Promise<Model> {
      throw new Error("not implemented: models.create");
    },
    async get(_id: string, _opts: { includeTrashed?: boolean } = {}): Promise<Model | undefined> {
      throw new Error("not implemented: models.get");
    },
    async search(_query: SearchQuery): Promise<Model[]> {
      throw new Error("not implemented: models.search");
    },
    async trash(_id: string): Promise<boolean> {
      throw new Error("not implemented: models.trash");
    },
    async restore(_id: string): Promise<boolean> {
      throw new Error("not implemented: models.restore");
    },
    async purgeable(_before: Date): Promise<Model[]> {
      throw new Error("not implemented: models.purgeable");
    },
  };
}

export type ModelsRepo = ReturnType<typeof modelsRepo>;
