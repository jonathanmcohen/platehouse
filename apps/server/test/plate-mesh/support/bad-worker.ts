// Test fixture (issue #358): a plate mesh worker that answers with a mesh the
// validator must refuse: a coordinate that is not a number. Nothing it sends
// may be trusted just because it came from the worker.
import { parentPort } from "node:worker_threads";

parentPort?.postMessage({
  type: "mesh",
  mesh: {
    plate: 1,
    pieces: [
      {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, Number.NaN, 0]),
        indices: new Uint32Array([0, 1, 2]),
        colour: null,
      },
    ],
    instances: [{ piece: 0, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] }],
    triangles: 1,
  },
});
