/**
 * The memory budget a run keeps of docker's, which the worker core's
 * `memoryBudget.mjs` holds: the memory of Colima's VM less `memoryFreeGibMin`,
 * its ceiling for a job that budget less `memoryReservedGib`, and what
 * `status` says of them.
 */

import { diskGib } from "@chuggy/worker-core/diskFloor.mjs";
import { fileLockHolderAlive } from "@chuggy/worker-core/fileLock.mjs";
import {
  memoryBudgetBytes,
  memoryBudgetState,
  memoryCountMsMax,
  memoryCounted,
  memoryRoomBytes,
} from "@chuggy/worker-core/memoryBudget.mjs";

/**
 * @typedef {import("@chuggy/worker-core/engine.mjs").Engine} Engine
 * @typedef {import("./runnerConfig.mjs").RunnerConfig} RunnerConfig
 */

/**
 * What the runner's file keeps free of the VM's memory, in bytes.
 *
 * @param {RunnerConfig} config
 */
export function memoryFreeBytes(config) {
  return config.memoryFreeGibMin * 2 ** 30;
}

/**
 * What the runner's file reserves of the budget from jobs, in bytes.
 *
 * @param {RunnerConfig} config
 */
export function memoryReservedBytes(config) {
  return config.memoryReservedGib * 2 ** 30;
}

/**
 * The VM's memory against the runner's budget, as `status` says it: the
 * room, the budget, the ceiling for a job, the running sessions' caps and the
 * budget's state, or why it could not be counted; and where docker refused
 * to say what its containers use, that what no runner capped was counted at
 * none.
 *
 * @param {RunnerConfig} config
 * @param {Engine} engine
 * @param {(pid: number) => boolean} [holderAlive]
 */
export async function memoryBudgetSaid(
  config,
  engine,
  holderAlive = fileLockHolderAlive,
) {
  const { counted } = await memoryCounted({
    engine,
    name: "docker",
    holderAlive,
    nowMs: Date.now,
    signal: globalThis.AbortSignal.timeout(memoryCountMsMax),
  });
  if ("unknown" in counted) return `Unknown · ${counted.unknown}`;
  const bytesFree = memoryFreeBytes(config);
  const budgetBytes = memoryBudgetBytes(bytesFree, counted);
  return [
    `${diskGib(Math.max(0, memoryRoomBytes(bytesFree, counted)))} GiB room`,
    `${diskGib(budgetBytes)} GiB budget`,
    `${diskGib(Math.max(0, budgetBytes - memoryReservedBytes(config)))} GiB ceiling`,
    `${diskGib(counted.sessionBytes)} GiB sessions`,
    memoryBudgetState(bytesFree, counted, 0),
    ...(counted.unmeasured === undefined ? [] : ["uncapped use unmeasured"]),
  ].join(" · ");
}
