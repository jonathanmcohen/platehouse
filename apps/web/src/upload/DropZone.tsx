// A drop target for files (build plan Task 19, AC-020). Not yet implemented:
// this commit carries the interfaces and the failing tests.
import type { ReactNode } from "react";

export interface DropZoneProps {
  onFiles(files: File[]): void;
  children?: ReactNode;
}

export function DropZone({ children }: DropZoneProps) {
  return <div>{children}</div>;
}
