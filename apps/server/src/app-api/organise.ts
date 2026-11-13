// The organising pages' app API (build plan Task 21). Skeleton: the
// implementation follows the failing tests.
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";
import type { createTrash } from "../library/trash.js";

export interface OrganiseDeps {
  db: Kysely<DB>;
  trash: Pick<ReturnType<typeof createTrash>, "trashModel" | "restoreModel" | "emptyTrash">;
}

export async function registerOrganiseApi(
  _app: FastifyInstance,
  _deps: OrganiseDeps | undefined,
): Promise<void> {}
