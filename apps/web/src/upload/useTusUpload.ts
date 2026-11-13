// Uploads through Task 9's tus endpoint (build plan Task 19, AC-020). Not yet
// implemented: this commit carries the interfaces and the failing tests.
import type { UploadOptions } from "tus-js-client";

export const UPLOAD_ENDPOINT = "/app/uploads";

export const CHUNK_SIZE = 0;

export type UploadTarget =
  | { kind: "new" }
  | { kind: "model"; modelId: string }
  | { kind: "batch"; batch: string };

export function isSupportedFile(_name: string): boolean {
  return false;
}

export function uploadMetadata(_file: File, _target: UploadTarget): Record<string, string> {
  return {};
}

export function uploadFingerprint(_file: File, _target: UploadTarget, _endpoint: string): string {
  return "";
}

export interface UploadHandlers {
  onProgress(bytesSent: number, bytesTotal: number): void;
  onSuccess(uploadUrl: string): void;
  onError(error: Error): void;
}

export function uploadOptions(
  _file: File,
  _target: UploadTarget,
  _handlers: UploadHandlers,
): UploadOptions {
  return {};
}

export interface UploadHandle {
  abort(): void;
}

export type StartUpload = (
  file: File,
  target: UploadTarget,
  handlers: UploadHandlers,
) => UploadHandle;

export interface UploadResult {
  status: "pending" | "done" | "failed";
  modelId?: string;
  fileId?: string;
  error?: string;
}

export type FetchResult = (uploadUrl: string) => Promise<UploadResult>;
