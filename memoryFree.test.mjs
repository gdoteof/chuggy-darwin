import assert from "node:assert/strict";
import test from "node:test";

import { heldCreateArgv } from "@chuggy/worker-core/engineArgv.mjs";

import { fakeEngine } from "./engine.fixture.mjs";
import {
  memoryBudgetSaid,
  memoryFreeBytes,
  memoryReservedBytes,
} from "./memoryFree.mjs";

const gib = 2 ** 30;

/**
 * A runner's file keeping `memoryFreeGibMin` free of the VM's memory, and
 * reserving `memoryReservedGib` of the budget from jobs.
 *
 * @param {number} memoryFreeGibMin
 * @param {number} [memoryReservedGib]
 */
const config = (memoryFreeGibMin, memoryReservedGib = 0) =>
  /** @type {import("./runnerConfig.mjs").RunnerConfig} */ (
    /** @type {unknown} */ ({
      memoryFreeGibMin,
      memoryReservedGib,
    })
  );

/**
 * Docker in a VM of 16 GiB, whose containers outside every pool use
 * `usedGib`, holding `held` jobs of 2 GiB each, held for room or starting.
 *
 * @param {number} usedGib
 * @param {number} [held]
 * @param {boolean} [starting]
 */
async function engineUsing(usedGib, held = 0, starting = false) {
  const { engine, state } = fakeEngine();
  state.machine = { ...state.machine, memoryBytes: 16 * gib };
  state.containers.set("chuggy-jobs-postgres", {
    id: "id-postgres",
    name: "chuggy-jobs-postgres",
    labels: {},
    status: "running",
    image: "postgres",
    usedBytes: usedGib * gib,
  });
  for (let index = 0; index < held; index += 1)
    await engine.exec(
      heldCreateArgv({
        name: `chuggy-other-${String(index)}-held`,
        pool: "vteng/chuggy/other",
        assignment: `asg-${String(index)}`,
        memoryMib: 2048,
        heldMs: index,
        pid: process.pid,
        untilMs: Date.now() + 3_600_000,
        starting,
      }),
    );
  return { engine, state };
}

test("what the file keeps free and what it reserves are their GiB in bytes", () => {
  assert.equal(memoryFreeBytes(config(2)), 2 * gib);
  assert.equal(memoryFreeBytes(config(0)), 0);
  assert.equal(memoryReservedBytes(config(0, 3)), 3 * gib);
  assert.equal(memoryReservedBytes(config(0)), 0);
});

test("status says the room, the budget, the ceiling, the sessions' caps and the budget's state, or why it could not be counted", async () => {
  assert.equal(
    await memoryBudgetSaid(config(2), (await engineUsing(4)).engine),
    "10 GiB room · 14 GiB budget · 14 GiB ceiling · 0 GiB sessions · Taking",
  );
  assert.equal(
    await memoryBudgetSaid(config(0), (await engineUsing(4)).engine),
    "12 GiB room · 16 GiB budget · 16 GiB ceiling · 0 GiB sessions · Taking",
  );
  assert.equal(
    await memoryBudgetSaid(config(2, 6), (await engineUsing(4)).engine),
    "10 GiB room · 14 GiB budget · 8 GiB ceiling · 0 GiB sessions · Taking",
  );
  assert.equal(
    await memoryBudgetSaid(config(2, 20), (await engineUsing(4)).engine),
    "10 GiB room · 14 GiB budget · 0 GiB ceiling · 0 GiB sessions · Taking",
  );
  assert.equal(
    await memoryBudgetSaid(config(2), (await engineUsing(13.75)).engine),
    "0.3 GiB room · 14 GiB budget · 14 GiB ceiling · 0 GiB sessions · Full",
  );
  assert.equal(
    await memoryBudgetSaid(config(2), (await engineUsing(4, 2)).engine),
    "6 GiB room · 14 GiB budget · 14 GiB ceiling · 0 GiB sessions · Held",
  );
  assert.equal(
    await memoryBudgetSaid(config(2), (await engineUsing(4, 1, true)).engine),
    "8 GiB room · 14 GiB budget · 14 GiB ceiling · 0 GiB sessions · Taking",
  );
  assert.equal(
    await memoryBudgetSaid(
      config(2),
      (await engineUsing(4, 1)).engine,
      () => false,
    ),
    "10 GiB room · 14 GiB budget · 14 GiB ceiling · 0 GiB sessions · Taking",
  );
  const sessions = await engineUsing(4);
  for (const [name, kind, capGib] of /** @type {const} */ ([
    ["chuggy-shame-session", "Session", 3],
    ["chuggy-shame-job", "Job", 2],
  ]))
    sessions.state.containers.set(name, {
      id: `id-${name}`,
      name,
      status: "running",
      image: "i",
      labels: {
        "io.chuggy.pool": "vteng/chuggy/shame",
        "io.chuggy.kind": kind,
      },
      memoryBytes: capGib * gib,
    });
  assert.equal(
    await memoryBudgetSaid(config(2), sessions.engine),
    "5 GiB room · 14 GiB budget · 14 GiB ceiling · 3 GiB sessions · Taking",
  );
  const { engine, state } = await engineUsing(4);
  state.unreachable = true;
  assert.equal(
    await memoryBudgetSaid(config(2), engine),
    "Unknown · docker could not say how much memory it has: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
  );
});

test("status says where what no runner capped was counted at none, since the engine refused its stats", async () => {
  const { engine } = await engineUsing(4);
  const refusing = {
    ...engine,
    /** @type {typeof engine.exec} */
    exec: async (argv, options) =>
      argv[0] === "stats"
        ? {
            code: 125,
            stdout: "",
            stderr:
              "Error: stats is not supported in rootless mode without cgroups v2\n",
          }
        : engine.exec(argv, options),
  };
  assert.equal(
    await memoryBudgetSaid(config(0), refusing),
    "16 GiB room · 16 GiB budget · 16 GiB ceiling · 0 GiB sessions · Taking · uncapped use unmeasured",
  );
});
