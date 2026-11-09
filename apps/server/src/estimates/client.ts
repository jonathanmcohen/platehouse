// The app's client for slicer contract v1 (build plan Task 12).
// Skeleton: the failing tests come first.
import type { Readable } from "node:stream";
import type { Health, Profiles, SliceResult } from "@platehouse/slicer-contract";

export interface SliceRequest {
  printerId: string;
  plate: number;
  body: Readable;
  size: number;
}

export interface SlicerClient {
  health(): Promise<Health>;
  profiles(): Promise<Profiles>;
  slice(request: SliceRequest): Promise<SliceResult>;
}

export class SlicerBusy extends Error {
  constructor() {
    super("The slicer is busy with another job");
    this.name = "SlicerBusy";
  }
}

export class SlicerUnreachable extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`The slicer could not be reached (${reason})`);
    this.name = "SlicerUnreachable";
    this.reason = reason;
  }
}

export class SlicerRefused extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SlicerRefused";
    this.status = status;
  }
}

export function sliceTimeoutMs(_plateSeconds: number): number {
  throw new Error("not implemented");
}

export interface SlicerClientOptions {
  url: string;
  plateSeconds: number;
  requestTimeoutMs?: number;
  sliceTimeoutMs?: number;
}

export function createSlicerClient(_opts: SlicerClientOptions): SlicerClient {
  const notYet = async (): Promise<never> => {
    throw new Error("not implemented");
  };
  return { health: notYet, profiles: notYet, slice: notYet };
}
