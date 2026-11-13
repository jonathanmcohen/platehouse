// The upload dialog (build plan Task 19, AC-020). Not yet implemented: this
// commit carries the interfaces and the failing tests.
import type { FetchResult, StartUpload } from "./useTusUpload";

export interface UploadDialogProps {
  open: boolean;
  files: File[];
  modelId?: string;
  onClose(): void;
  onUploaded?: () => void;
  start?: StartUpload;
  fetchResult?: FetchResult;
  resultDelayMs?: number;
}

export function UploadDialog(_props: UploadDialogProps) {
  return null;
}
