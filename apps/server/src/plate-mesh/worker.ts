// The worker thread a plate's mesh is read in (issue #358, worker-read.ts).
// It reads one plate of the .3mf at workerData.path and posts one message:
// the mesh, its arrays' buffers handed over rather than copied; the reader's
// verdict on the file; ReadUnavailable's code when the file cannot be read
// right now; or, for anything else, the error's message. Nothing it sends is
// trusted: the main thread validates a mesh before using it.
import { parentPort, workerData } from "node:worker_threads";
import { PlateMeshError, ReadUnavailable, readPlateMesh } from "@platehouse/threemf";

const { path, plate } = workerData as { path: string; plate: number };

try {
  const mesh = await readPlateMesh(path, plate);
  const buffers = new Set<ArrayBuffer>();
  for (const p of mesh.pieces) {
    buffers.add(p.positions.buffer as ArrayBuffer);
    buffers.add(p.indices.buffer as ArrayBuffer);
  }
  parentPort?.postMessage({ type: "mesh", mesh }, [...buffers]);
} catch (error) {
  if (error instanceof PlateMeshError) {
    parentPort?.postMessage({ type: "verdict", problem: error.problem, message: error.message });
  } else if (error instanceof ReadUnavailable) {
    parentPort?.postMessage({ type: "unavailable", code: error.code, message: error.message });
  } else {
    parentPort?.postMessage({
      type: "error",
      message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
}
