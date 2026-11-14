// The slicer in the end-to-end stack (build plan Task 22): the
// contract-faithful stub the integration tests use
// (apps/server/test/support/slicer-stub.ts), answering every slice with ok
// numbers. That stub listens on 127.0.0.1 only, so this process forwards
// port 8080 on every interface to it, the port SLICER_URL names in compose.
// Run with node --conditions=source and the test resolve hook (compose.yml).
import { createConnection, createServer } from "node:net";
import { startSlicerStub } from "../../apps/server/test/support/slicer-stub.js";

const PORT = 8080;

const stub = await startSlicerStub();
const target = new URL(stub.url);

const forward = createServer((client) => {
  const upstream = createConnection({ host: target.hostname, port: Number(target.port) });
  client.pipe(upstream);
  upstream.pipe(client);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
});
forward.listen(PORT, "0.0.0.0", () => {
  console.info(`slicer stub: listening on ${PORT}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    forward.close();
    void stub.stop().then(() => process.exit(0));
  });
}
