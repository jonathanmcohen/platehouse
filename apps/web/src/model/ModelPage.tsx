// The model page (build plan Task 20). Interface stub: the types of the
// model app API's answer and the page's props.
import type { ThreeLoader } from "./Viewer3d";

export type FileKind = "3mf" | "stl" | "step" | "scad";

export type ParseStatus = "pending" | "ok" | "no_plate_data" | "unavailable";

export interface FilamentNumbers {
  slot: number;
  type: string;
  color: string | null;
  grams: number | null;
  profile: string | null;
  profileSource: "bambu" | "generic" | "file" | null;
}

export interface Numbers {
  source: "file" | "platehouse";
  estimateId: string;
  printerId: string;
  printerLabel: string;
  slicer: string | null;
  slicerVersion: string | null;
  processProfile: string | null;
  timeSeconds: number | null;
  weightGrams: number | null;
  filaments: FilamentNumbers[];
}

export interface PlatehouseNumbers extends Numbers {
  state: "current" | "estimating" | "stale";
  staleFor?: string;
}

export interface PlateFailure {
  estimateId: string;
  reason: string;
  words: string;
  detail: string | null;
}

export interface PlateNumbers {
  file?: Numbers;
  platehouse?: PlatehouseNumbers;
  failure?: PlateFailure;
}

export interface ModelPlate {
  id: string;
  index: number;
  name: string | null;
  objectCount: number;
  thumbnail: string | null;
  numbers: PlateNumbers;
}

export interface ProjectFilament {
  slot: number;
  type: string;
  color: string | null;
}

export interface ModelFile {
  id: string;
  name: string;
  kind: FileKind;
  size: number;
  parseStatus: ParseStatus;
  derivedStatus: string | null;
  derivedMessage: string | null;
  download: string;
  view: { kind: "stl" | "glb"; url: string } | null;
  preview: string | null;
  filaments: ProjectFilament[];
  plates: ModelPlate[];
}

export interface ModelView {
  id: string;
  name: string;
  caption: string | null;
  description: string | null;
  creator: string | null;
  license: string | null;
  licenseNote: string | null;
  tags: string[];
  collections: string[];
  printer: string;
  files: ModelFile[];
}

export interface ModelPageProps {
  loadThree?: ThreeLoader;
  navigateTo?: (url: string) => void;
  platform?: "mac" | "other";
  onFiles?: (files: File[], modelId: string) => void;
  refreshKey?: number;
}

export const POLL_MS = 0;

export function isEstimating(_numbers: PlateNumbers): boolean {
  return false;
}

export function needsPolling(_model: ModelView): boolean {
  return false;
}

export function ModelPage(_props: ModelPageProps) {
  return null;
}
