// Open in Bambu Studio and Open in OrcaSlicer (build plan Task 20, AC-040).
// Interface stub.

export const BAMBU_PROMPT_LINE = "";

export interface SlicerLink {
  url: string;
  expiresAt: string;
  open: { orca: string; bambuMac: string; bambuOther: string };
}
