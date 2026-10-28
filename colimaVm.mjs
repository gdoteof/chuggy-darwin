/**
 * Colima's VM, which docker runs containers in, reached by `colima ssh` for
 * what docker does not say of it. Docker's info names the VM as Colima names
 * its host: `colima` for the default profile and `colima-<profile>` for any
 * other. A name of another shape is a VM Colima does not run, such as Docker
 * Desktop's, which nothing here can reach.
 */

import { containerEngine } from "@chuggy/worker-core/engine.mjs";
import { engineFailureLine } from "@chuggy/worker-core/engineErrors.mjs";

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
 * A command run in the profile's VM. Lima runs it through the login shell
 * there, each argument quoted for that shell, so none is read as shell
 * syntax. What that shell's profile prints to stdout comes before the
 * command's own output, and a read here then reads the disk as unknown and
 * Rosetta as absent, each of which doctor warns of.
 *
 * @param {string} profile
 * @param {readonly string[]} argv
 */
export function colimaVmArgv(profile, argv) {
  return ["ssh", "--profile", profile, "--", ...argv];
}

/** Where Linux lists the interpreters it runs other architectures' programs through. */
const binfmtMisc = "/proc/sys/fs/binfmt_misc";

/**
 * Whether the profile's VM runs amd64 programs through Rosetta: Linux holds
 * an enabled interpreter named rosetta, as Colima registers one where it was
 * started with `--vz-rosetta` on a Mac with Rosetta installed. Without one,
 * Colima's VM runs them through QEMU.
 *
 * @param {ColimaCli} colima
 * @param {string} profile
 * @returns {Promise<{rosetta: boolean} | {unknown: string}>}
 */
export async function colimaRosetta(colima, profile) {
  const listed = await colima.exec(
    colimaVmArgv(profile, ["ls", "-1", binfmtMisc]),
  );
  if (listed.code !== 0)
    return {
      unknown: `${binfmtMisc} could not be listed in Colima's VM ${profile}: ${engineFailureLine(listed)}`,
    };
  if (!listed.stdout.split("\n").includes("rosetta")) return { rosetta: false };
  const entry = await colima.exec(
    colimaVmArgv(profile, ["cat", `${binfmtMisc}/rosetta`]),
  );
  if (entry.code !== 0)
    return {
      unknown: `${binfmtMisc}/rosetta could not be read in Colima's VM ${profile}: ${engineFailureLine(entry)}`,
    };
  return { rosetta: entry.stdout.split("\n")[0] === "enabled" };
}
