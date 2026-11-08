import type { Kysely } from "kysely";
import type { ApiToken, DB } from "../db/types.js";

export interface NewToken {
  name: string;
  prefix: string;
  tokenHash: Buffer;
}

export function tokensRepo(_db: Kysely<DB>) {
  return {
    async create(_input: NewToken): Promise<ApiToken> {
      throw new Error("not implemented: tokens.create");
    },
    async findByHash(_tokenHash: Buffer): Promise<ApiToken | undefined> {
      throw new Error("not implemented: tokens.findByHash");
    },
    async revoke(_id: string): Promise<boolean> {
      throw new Error("not implemented: tokens.revoke");
    },
  };
}

export type TokensRepo = ReturnType<typeof tokensRepo>;
