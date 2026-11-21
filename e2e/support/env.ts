// Where the end-to-end specs find the stack (build plan Task 22). Every
// request goes to Traefik on 127.0.0.1:443 under these names, which the
// runner's /etc/hosts maps (see e2e/README.md and the e2e job in ci.yml).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** PUBLIC_ORIGIN in e2e/compose.yml. */
export const ORIGIN = "https://platehouse.e2e.test";

/** OIDC_ISSUER in e2e/compose.yml, the mock issuer behind Traefik. */
export const ISSUER = "https://id.e2e.test";

const HERE = dirname(fileURLToPath(import.meta.url));

/** e2e/, where the config, the specs and the run's own files live. */
export const E2E_DIR = join(HERE, "..");

/** Run files made by the global setup; e2e/.gitignore keeps them out of git. */
export const RUN_DIR = join(E2E_DIR, ".run");

/** The signed-in browser state the specs start from. */
export const STATE_PATH = join(RUN_DIR, "state.json");

/** What the global setup put in the library, and the API token it made. */
export const SEED_PATH = join(RUN_DIR, "seed.json");
