// A .3mf plate's 3D view (issue #358): asks the server for the GLB of the
// objects on that plate (GET /app/api/plates/:id/mesh), then shows it in the
// same 3D viewer as an STL or a STEP file (Viewer3d), with the same drag,
// pan and zoom and the same Rotate, Zoom and Reset view buttons. The browser
// loads that one plate's mesh from /blobs/<id>, never the whole .3mf.
//
// The answer is read in order: whether a reply came at all, then its
// status, then its body. Anything but a 200 whose url is a /blobs/ address
// is a failure, handed to onFailed with why, and the plate goes back to its
// picture (PlateViewer says the reason):
// - 422 with a known code: the plate has no 3D view, for that reason;
// - 401: the session ended;
// - 503 with error "busy": the server is already making as many 3D views
//   as it holds, so try again in a moment;
// - any other 503: the file could not be read right now;
// - anything else, no reply, or a body it cannot read: a server error.
// The GLB itself is then loaded by Viewer3d; when that fails, a MeshLoadError
// is read the same way by its status (401 signed out, 503 unavailable,
// anything else, no reply or a mesh it cannot read a server error), a
// ThreeLoadError (three.js itself not loading: a dropped network, a chunk
// gone after a redeploy) is a server error too, and only a viewer that
// cannot start (no WebGL) is "browser". The request is aborted when the
// view goes, and an answer that comes after that is dropped, so nothing
// loads after the view was closed or the page left.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { MeshLoadError, ThreeLoadError, type ThreeLoader, Viewer3d } from "./Viewer3d";

/** Why a plate's 3D view could not be shown. */
export type Plate3dFailure =
  | "no_plate"
  | "no_objects"
  | "no_mesh"
  | "too_large"
  | "damaged"
  | "unavailable"
  | "busy"
  | "signedOut"
  | "browser"
  | "error";

const PROBLEMS: ReadonlySet<string> = new Set([
  "no_plate",
  "no_objects",
  "no_mesh",
  "too_large",
  "damaged",
]);

/** The plate's GLB address, or why there is none. */
export async function fetchPlateMesh(
  plateId: string,
  signal: AbortSignal,
): Promise<{ url: string } | { failure: Plate3dFailure }> {
  let res: Response;
  try {
    res = await fetch(`/app/api/plates/${encodeURIComponent(plateId)}/mesh`, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    return { failure: "error" };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const field = (name: string): unknown =>
    typeof body === "object" && body !== null ? (body as Record<string, unknown>)[name] : undefined;
  if (res.status === 200) {
    const url = field("url");
    return typeof url === "string" && url.startsWith("/blobs/") ? { url } : { failure: "error" };
  }
  if (res.status === 422) {
    const code = field("code");
    return typeof code === "string" && PROBLEMS.has(code)
      ? { failure: code as Plate3dFailure }
      : { failure: "error" };
  }
  if (res.status === 401) return { failure: "signedOut" };
  if (res.status === 503) {
    return { failure: field("error") === "busy" ? "busy" : "unavailable" };
  }
  return { failure: "error" };
}

/** Why the viewer could not show the plate's GLB. */
export function viewerFailure(error: unknown): Plate3dFailure {
  // three.js not loading is the network or a stale page, not the browser.
  if (error instanceof ThreeLoadError) return "error";
  if (!(error instanceof MeshLoadError)) return "browser";
  if (error.status === 401) return "signedOut";
  if (error.status === 503) return "unavailable";
  return "error";
}

export interface Plate3dProps {
  plateId: string;
  /** The plate's name or "Plate N", for the view's label. */
  label: string;
  /** The .3mf's download, which Viewer3d requires; never offered here. */
  download: string;
  loadThree?: ThreeLoader | undefined;
  /** The view could not be shown; the plate goes back to its picture. */
  onFailed(failure: Plate3dFailure): void;
  /** Show picture, between the view and its controls. */
  actions: ReactNode;
}

export function Plate3d({ plateId, label, download, loadThree, onFailed, actions }: Plate3dProps) {
  const [url, setUrl] = useState<string | null>(null);
  // The latest onFailed, so a new callback never asks for the mesh again.
  const failedRef = useRef(onFailed);
  failedRef.current = onFailed;

  useEffect(() => {
    const controller = new AbortController();
    setUrl(null);
    fetchPlateMesh(plateId, controller.signal).then(
      (answer) => {
        if (controller.signal.aborted) return;
        if ("url" in answer) setUrl(answer.url);
        else failedRef.current(answer.failure);
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [plateId]);

  // One Viewer3d throughout, loading until the address comes, so Show
  // picture stays the same element and keeps its focus.
  return (
    <Viewer3d
      source={url === null ? null : { kind: "glb", url }}
      label={label}
      download={download}
      loadThree={loadThree}
      onFailed={(error) => failedRef.current(viewerFailure(error))}
      actions={actions}
    />
  );
}
