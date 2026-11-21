import { type Kysely, sql } from "kysely";
import { inTransaction } from "../db/kysely.js";
import type { BucketVersioning, DB } from "../db/types.js";

// The single settings row, seeded by migration 0001, and My printers
// (migration 0007): the printers the user owns, in display order. settings
// .printer_id is the default printer, and must be one of My printers.
// settings.printers_version counts the writes to the two together.

export interface Settings {
  /** The default printer: the one pages show first and the public API v1 answers for. */
  printerId: string;
  /** My printers, in display order; never empty, and always holds printerId. */
  myPrinters: string[];
  /**
   * The version of My printers and the default together: every save of
   * either bumps it. A save names the version it was built from.
   */
  printersVersion: number;
  lastOrcaVersion: string | null;
  bucketVersioning: BucketVersioning;
  updatedAt: Date;
}

/** The default printer and My printers change only through savePrinters. */
export type SettingsPatch = Partial<Pick<Settings, "lastOrcaVersion" | "bucketVersioning">>;

/** A whole new My printers list and its default. */
export interface PrintersPatch {
  /** In display order, each printer once. */
  printers: readonly string[];
  /** One of printers. */
  defaultId: string;
  /**
   * The printersVersion the caller built this save from. Given, the save
   * goes ahead only while the stored version is still that one, and is
   * refused with PrintersChanged otherwise: a save built from an older read
   * would undo whatever changed since, to the list or to the default.
   */
  version?: number;
}

/**
 * My printers or the default changed after the read this save was built
 * from (its version is no longer the stored one); nothing changed.
 */
export class PrintersChanged extends Error {
  constructor() {
    super("My printers or the default changed after the read this save was built from");
    this.name = "PrintersChanged";
  }
}

const COLUMNS = [
  "printerId",
  "printersVersion",
  "lastOrcaVersion",
  "bucketVersioning",
  "updatedAt",
] as const;

/** My printers in display order, as one array column. */
const MY_PRINTERS = sql<string[]>`(
  select coalesce(array_agg(printer_id order by position), '{}')
  from user_printers
)`.as("myPrinters");

export function settingsRepo(db: Kysely<DB>) {
  async function get(conn: Kysely<DB> = db): Promise<Settings> {
    return conn
      .selectFrom("settings")
      .select([...COLUMNS, MY_PRINTERS])
      .executeTakeFirstOrThrow();
  }

  return {
    get: () => get(),

    /** Changes only the fields the patch names, and returns the new settings. */
    async update(patch: SettingsPatch): Promise<Settings> {
      return db
        .updateTable("settings")
        .set({
          ...(patch.lastOrcaVersion === undefined
            ? {}
            : { lastOrcaVersion: patch.lastOrcaVersion }),
          ...(patch.bucketVersioning === undefined
            ? {}
            : { bucketVersioning: patch.bucketVersioning }),
          updatedAt: sql`now()`,
        })
        .returning([...COLUMNS, MY_PRINTERS])
        .executeTakeFirstOrThrow();
    },

    /**
     * Replaces My printers with patch.printers, in that order, sets the
     * default and bumps printersVersion, in one transaction, and returns the
     * new settings. A printer kept from the old list keeps its added_at. A
     * default outside the list fails with 23503 and changes nothing. The
     * settings row is locked first, so two saves run one after the other;
     * with patch.version, a save whose version is no longer the stored one
     * is refused with PrintersChanged and changes nothing. The caller checks
     * that the list is not empty and names each printer once.
     */
    async savePrinters(patch: PrintersPatch): Promise<Settings> {
      return inTransaction(db, async (trx) => {
        const locked = await trx
          .selectFrom("settings")
          .select("printersVersion")
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (patch.version !== undefined && locked.printersVersion !== patch.version) {
          throw new PrintersChanged();
        }
        const keep = [...patch.printers];
        if (keep.length === 0) {
          await trx.deleteFrom("userPrinters").execute();
        } else {
          await trx.deleteFrom("userPrinters").where("printerId", "not in", keep).execute();
          // Numbered from 1 in the new order. Two printers may share a
          // position on the way; the unique check waits for the commit.
          for (const [i, printerId] of keep.entries()) {
            await trx
              .insertInto("userPrinters")
              .values({ printerId, position: i + 1 })
              .onConflict((oc) => oc.column("printerId").doUpdateSet({ position: i + 1 }))
              .execute();
          }
        }
        await trx
          .updateTable("settings")
          .set({
            printerId: patch.defaultId,
            printersVersion: sql`printers_version + 1`,
            updatedAt: sql`now()`,
          })
          .execute();
        // The default must be in the list: check it now, inside the
        // transaction, so the caller gets the error from this call.
        await sql`set constraints settings_printer_in_my_printers immediate`.execute(trx);
        return get(trx);
      });
    },
  };
}

export type SettingsRepo = ReturnType<typeof settingsRepo>;
