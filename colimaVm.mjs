/**
 * Colima's VM, which docker runs containers in, reached by `colima ssh` for
 * what docker does not say of it. Docker's info names the VM as Colima names
 * its host: `colima` for the default profile and `colima-<profile>` for any
 * other. A name of another shape is a VM Colima does not run, such as Docker
 * Desktop's, which nothing here can reach.
 */

import { containerEngine } from "@chuggy/worker-core/engine.mjs";

/**
 * @typedef {Pick<import("@chuggy/worker-core/engine.mjs").Engine, "exec">} ColimaCli
 */

/** The cap on a call into the VM, which guards a hung one and not a slow one. */
export const colimaCallMsMax = 30_000;

/** The `colima` this Mac's PATH finds. */
export function colimaCli() {
  return containerEngine("colima", colimaCallMsMax);
}

/**
 * The Colima profile whose VM docker names this, or nothing for a VM Colima
 * does not run.
 *
 * @param {string} machine the name docker's info gives its machine
 */
export function colimaProfile(machine) {
  if (machine === "colima") return "default";
  return /^colima-([A-Za-z0-9][A-Za-z0-9._-]*)$/u.exec(machine)?.[1];
}

/**
 * A command run in the profile's VM, never through a shell there.
 *
 * @param {string} profile
 * @param {readonly string[]} argv
 */
export function colimaVmArgv(profile, argv) {
  return ["ssh", "--profile", profile, "--", ...argv];
}
