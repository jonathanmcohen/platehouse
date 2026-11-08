import type { Kysely } from "kysely";
import type { DB, FileKind, ModelFile, ParseStatus } from "../db/types.js";

export interface NewFile {
  id?: string;
  modelId: string;
  blobId: string;
  name: string;
  originalName: string;
  kind: FileKind;
  size: number;
  sha256: Buffer;
  externalRef?: string | null;
  parseStatus?: ParseStatus;
}

export function filesRepo(_db: Kysely<DB>) {
  return {
    async create(_input: NewFile): Promise<ModelFile> {
      throw new Error("not implemented: files.create");
    },
    async get(_id: string): Promise<ModelFile | undefined> {
      throw new Error("not implemented: files.get");
    },
  };
}

export type FilesRepo = ReturnType<typeof filesRepo>;
