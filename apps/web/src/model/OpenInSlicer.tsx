// Open in Bambu Studio and Open in OrcaSlicer (build plan Task 20, AC-040),
// on every .3mf of a model page.
//
// - The plain line about Bambu Studio's own prompt is shown beside the
//   buttons before anything is pressed: Bambu Studio trusts only
//   MakerWorld's hosts and asks "This file is not from a trusted site" for
//   any other, Platehouse included.
// - A press mints a 10-minute slicer link with Task 17's POST
//   /app/api/files/:id/slicer-link (a same-origin request, which the gate's
//   Origin check passes) and goes to the protocol URL that route answers:
//   open.orca for OrcaSlicer, open.bambuMac on a Mac and open.bambuOther
//   elsewhere for Bambu Studio. Those URLs carry the link encoded exactly
//   once by the server (the Slicer link contract); the page never encodes,
//   builds or signs a link itself. A URL that does not start with the
//   expected scheme is refused rather than followed.
// - A link that cannot be made is said in the page (role alert), never in a
//   browser dialog. While a link is being made the buttons stay focusable
//   (aria-disabled) and ignore presses.
import { useId, useState } from "react";

export const BAMBU_PROMPT_LINE =
  'Bambu Studio asks "This file is not from a trusted site, do you want to open it anyway?" ' +
  "for any file that is not from MakerWorld. Choose to open it.";

/** What Task 17's mint route answers. */
export interface SlicerLink {
  url: string;
  expiresAt: string;
  open: { orca: string; bambuMac: string; bambuOther: string };
}

export type Platform = "mac" | "other";

export type Slicer = "orca" | "bambu";

/** The protocol URL each slicer is opened with, and its required prefix. */
const PREFIX: Record<keyof SlicerLink["open"], string> = {
  orca: "orcaslicer://open?file=",
  bambuMac: "bambustudioopen://",
  bambuOther: "bambustudio://open?file=",
};

/** The protocol URL to go to for the slicer on this platform; undefined when the answer is not one. */
export function slicerTarget(
  link: SlicerLink,
  slicer: Slicer,
  platform: Platform,
): string | undefined {
  const key: keyof SlicerLink["open"] =
    slicer === "orca" ? "orca" : platform === "mac" ? "bambuMac" : "bambuOther";
  const target = link.open?.[key];
  return typeof target === "string" && target.startsWith(PREFIX[key]) ? target : undefined;
}

/** Whether this browser runs on macOS, where Bambu Studio takes bambustudioopen://. */
export function detectPlatform(nav: Navigator | undefined = globalThis.navigator): Platform {
  if (nav === undefined) return "other";
  const hinted = (nav as Navigator & { userAgentData?: { platform?: string } }).userAgentData
    ?.platform;
  if (hinted !== undefined && hinted !== "") return hinted === "macOS" ? "mac" : "other";
  return /Mac/i.test(nav.platform || nav.userAgent) ? "mac" : "other";
}

export interface OpenInSlicerProps {
  fileId: string;
  fileName: string;
  /** Goes to a protocol URL; window.location.assign when left out. */
  navigateTo?: ((url: string) => void) | undefined;
  /** Read from the browser when left out. */
  platform?: Platform | undefined;
}

export function OpenInSlicer({ fileId, fileName, navigateTo, platform }: OpenInSlicerProps) {
  const lineId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open(slicer: Slicer) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/app/api/files/${encodeURIComponent(fileId)}/slicer-link`, {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`the link route answered ${res.status}`);
      const target = slicerTarget(
        (await res.json()) as SlicerLink,
        slicer,
        platform ?? detectPlatform(),
      );
      if (target === undefined) throw new Error("the link route answered no protocol URL");
      (navigateTo ?? ((url: string) => window.location.assign(url)))(target);
    } catch {
      setError("The slicer link could not be made. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ph-open-in">
      <div className="studio-actions">
        <button
          type="button"
          className="studio-button studio-button-primary"
          aria-describedby={lineId}
          aria-disabled={busy}
          onClick={() => void open("bambu")}
        >
          Open in Bambu Studio<span className="studio-visually-hidden">, {fileName}</span>
        </button>
        <button
          type="button"
          className="studio-button"
          aria-disabled={busy}
          onClick={() => void open("orca")}
        >
          Open in OrcaSlicer<span className="studio-visually-hidden">, {fileName}</span>
        </button>
      </div>
      <p id={lineId} className="studio-muted ph-small">
        {BAMBU_PROMPT_LINE}
      </p>
      {error === null ? null : (
        <p role="alert" className="ph-error">
          {error}
        </p>
      )}
    </div>
  );
}
