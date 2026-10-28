/**
 * The bytes free where docker stores what it holds, which is Colima's VM's
 * disk and not the Mac's, so the runner measures it in the VM: the lowest of
 * the filesystems holding docker's root directory, and containerd's where
 * docker stores images through its snapshotter. A VM Colima does not run
 * cannot be reached, and its free disk is unknown.
 */

import { z } from "zod";

import { diskGib } from "@chuggy/worker-core/diskFloor.mjs";
import { engineInfoArgv } from "@chuggy/worker-core/engineArgv.mjs";
import { engineFailureLine } from "@chuggy/worker-core/engineErrors.mjs";

import { colimaProfile, colimaVmArgv } from "./colimaVm.mjs";

/**
 * @typedef {import("@chuggy/worker-core/diskFloor.mjs").DiskFree} DiskFree
 * @typedef {import("@chuggy/worker-core/engine.mjs").Engine} Engine
 * @typedef {import("./colimaVm.mjs").ColimaCli} ColimaCli
 * @typedef {import("./runnerConfig.mjs").RunnerConfig} RunnerConfig
 */

/** Where containerd keeps what it holds unless its own configuration moves it. */
const containerdRoot = "/var/lib/containerd";

/** What docker's `info` names the storage of images it keeps through containerd. */
const containerdSnapshotter = "io.containerd.snapshotter.v1";

/** The bytes in the blocks `df -k` counts in. */
const dfBlockBytes = 1024;

const dockerInfoSchema = z.object({
  DockerRootDir: z.string(),
  Name: z.string(),
  DriverStatus: z.array(z.array(z.string())).nullish(),
});

/**
 * The machine docker's `info` names and the directories it says it keeps
 * what it holds in, or nothing for an answer of another shape.
 *
 * @param {string} stdout
 * @returns {{machine: string, paths: string[]} | undefined}
 */
function dockerStores(stdout) {
  let parsed;
  try {
    parsed = dockerInfoSchema.safeParse(JSON.parse(stdout));
  } catch {
    return undefined;
  }
  if (!parsed.success) return undefined;
  const { DockerRootDir, Name, DriverStatus } = parsed.data;
  const snapshotter = (DriverStatus ?? []).some(
    ([key, value]) => key === "driver-type" && value === containerdSnapshotter,
  );
  return {
    machine: Name,
    paths: [
      ...new Set([DockerRootDir, ...(snapshotter ? [containerdRoot] : [])]),
    ],
  };
}

/**
 * The bytes free under each path `df -P -k` was asked of, in the order asked,
 * or nothing for an answer of another shape.
 *
 * @param {string} stdout
 * @param {number} count the paths asked of
 */
function dfFree(stdout, count) {
  const rows = stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(1);
  if (rows.length !== count) return undefined;
  const free = rows.map((row) => Number(row.trim().split(/\s+/u)[3]));
  return free.every((blocks) => Number.isSafeInteger(blocks) && blocks >= 0)
    ? free.map((blocks) => blocks * dfBlockBytes)
    : undefined;
}

/**
 * @param {Engine} engine
 * @param {ColimaCli} colima
 * @returns {Promise<DiskFree>}
 */
export async function vmDiskFree(engine, colima) {
  const info = await engine.exec(engineInfoArgv());
  if (info.code !== 0)
    return {
      unknown: `docker could not be asked where it stores what it holds: ${engineFailureLine(info)}`,
    };
  const stores = dockerStores(info.stdout);
  if (stores === undefined)
    return { unknown: "docker answered an info this runner cannot read" };
  const profile = colimaProfile(stores.machine);
  if (profile === undefined)
    return {
      unknown: `docker names its machine ${stores.machine}, which is no Colima VM, so its disk cannot be measured`,
    };
  const answer = await colima.exec(
    colimaVmArgv(profile, ["df", "-P", "-k", ...stores.paths]),
  );
  if (answer.code !== 0)
    return {
      unknown: `${stores.paths.join(" and ")} could not be measured in Colima's VM ${profile}: ${engineFailureLine(answer)}`,
    };
  const free = dfFree(answer.stdout, stores.paths.length);
  if (free === undefined)
    return {
      unknown: `df in Colima's VM ${profile} answered what this runner cannot read`,
    };
  const lowest = free.indexOf(Math.min(...free));
  return {
    free: free[lowest],
    where: `${stores.paths[lowest]} in Colima's VM`,
  };
}

/**
 * The floor the runner's file sets, in bytes.
 *
 * @param {RunnerConfig} config
 */
export function diskFloorBytes(config) {
  return config.diskFreeGibMin * 2 ** 30;
}

/**
 * The VM's free disk against the runner's floor, as doctor and `status` say
 * it, and whether it is one to warn of: unmeasured, or under the floor.
 *
 * @param {RunnerConfig} config
 * @param {Engine} engine
 * @param {ColimaCli} colima
 * @returns {Promise<{detail: string, warning: boolean}>}
 */
export async function diskFloorSaid(config, engine, colima) {
  if (config.diskFreeGibMin === 0)
    return {
      detail: "none: the runner's file sets diskFreeGibMin to 0",
      warning: false,
    };
  const measured = await vmDiskFree(engine, colima);
  if ("unknown" in measured)
    return {
      detail: `none held, since the free disk could not be measured: ${measured.unknown}`,
      warning: true,
    };
  const bytesMin = diskFloorBytes(config);
  const free = `${diskGib(measured.free)} GiB free at ${measured.where}`;
  const floor = `the floor of ${String(config.diskFreeGibMin)} GiB`;
  if (measured.free >= bytesMin)
    return { detail: `${free}, over ${floor}`, warning: false };
  if (measured.free >= Math.floor(bytesMin / 2))
    return {
      detail: `${free}, under ${floor}: the agent removes the images it may and takes no job until it is over`,
      warning: true,
    };
  return {
    detail: `${free}, under half ${floor}: the agent removes the images it may, and stops a job each pass it is still under half`,
    warning: true,
  };
}
