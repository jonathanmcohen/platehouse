// What one Manyfold model needs in Platehouse. Pure: no network, no clock.
import type { NewModel, PlatehouseFile, PlatehouseModel } from "./platehouse.js";

export interface SourceFile {
  url: string;
  filename: string;
  contentUrl: string;
  contentSize: number | null;
}

export interface SourceModel {
  id: string;
  name: string;
  caption: string | null;
  description: string | null;
  creator: string | null;
  license: string | null;
  tags: string[];
  collections: string[];
  files: SourceFile[];
}

export type FilePlan =
  | { action: "import"; file: SourceFile }
  | { action: "present"; file: SourceFile; stored: PlatehouseFile }
  | { action: "skip"; file: SourceFile; reason: string }
  | { action: "fail"; file: SourceFile; reason: string };

export interface ModelPlan {
  /** The model to make, or null when it is already in Platehouse. */
  create: NewModel | null;
  /** Tags an existing model lacks. */
  tags: string[];
  /** Collections an existing model lacks. */
  collections: string[];
  files: FilePlan[];
}

/** The externalRef a Manyfold model is matched by. */
export function externalRefFor(_manyfoldId: string): string {
  throw new Error("not implemented");
}

/** Whether Platehouse takes a file with this name (Task 8's supported types). */
export function importable(_filename: string): boolean {
  throw new Error("not implemented");
}

export function planModel(_source: SourceModel, _existing: PlatehouseModel | undefined): ModelPlan {
  throw new Error("not implemented");
}
