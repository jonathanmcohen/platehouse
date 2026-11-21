import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";
import { blobsRepo } from "./blobs.js";
import { collectionsRepo } from "./collections.js";
import { estimatesRepo } from "./estimates.js";
import { filesRepo } from "./files.js";
import { modelsRepo } from "./models.js";
import { platesRepo } from "./plates.js";
import { sessionsRepo } from "./sessions.js";
import { settingsRepo } from "./settings.js";
import { tagsRepo } from "./tags.js";
import { tokensRepo } from "./tokens.js";

// Every repository bound to one executor: the pool, or a transaction, so a
// caller can run several repository calls in one transaction with
// db.transaction().execute(async (trx) => { const repos = createRepos(trx); ... }).
export function createRepos(db: Kysely<DB>) {
  return {
    models: modelsRepo(db),
    files: filesRepo(db),
    plates: platesRepo(db),
    estimates: estimatesRepo(db),
    tags: tagsRepo(db),
    collections: collectionsRepo(db),
    blobs: blobsRepo(db),
    tokens: tokensRepo(db),
    sessions: sessionsRepo(db),
    settings: settingsRepo(db),
  };
}

export type Repos = ReturnType<typeof createRepos>;
