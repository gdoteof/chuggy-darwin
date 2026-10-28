/**
 * A service answering on a control socket for a suite that asks it: its
 * backend is placing what it is given, one assignment unless told otherwise,
 * and stops whatever it is asked to.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { controlServer } from "@chuggy/worker-core/control.mjs";

/** @type {import("@chuggy/worker-core/containerBackend.mjs").InFlightPlacement} */
export const inFlightFixture = {
  assignment: "asg-1",
  kind: "Session",
  name: "chuggy-shame-x",
  image: "i",
  phase: "Pulling",
  memoryMib: 4096,
  deadlineEpochSecs: 1,
};

/**
 * @param {import("node:test").TestContext} t
 * @param {string} socket
 * @param {readonly object[]} inFlight what the service answers it is placing
 */
export async function controlServed(t, socket, inFlight = [inFlightFixture]) {
  await mkdir(dirname(socket), { recursive: true, mode: 0o700 });
  /** @type {string[]} */
  const stopped = [];
  const backend =
    /** @type {import("@chuggy/worker-core/containerBackend.mjs").ContainerBackend} */ (
      /** @type {unknown} */ ({
        inFlight: () => inFlight,
        stop: async (/** @type {string} */ assignment) => {
          stopped.push(assignment);
          return { stopped: "Stopped" };
        },
      })
    );
  const server = await controlServer(socket, backend);
  t.after(() => server.close());
  return { stopped, backend };
}
