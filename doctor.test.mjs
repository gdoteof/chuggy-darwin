import assert from "node:assert/strict";
import test from "node:test";

import { registerRequest } from "@chuggy/worker-core/register.mjs";

import { doctorFindings, findingLine } from "./doctor.mjs";
import { fakeEngine } from "./engine.fixture.mjs";
import { vmPlatform } from "./runner.mjs";
import { runnerFixture } from "./runner.fixture.mjs";

const ownUid = process.getuid?.() ?? -1;

/**
 * @param {import("node:test").TestContext} t
 * @param {{architecture?: string}} [vm]
 */
async function doctored(t, vm = {}) {
  const { home, poolFile, paths } = await runnerFixture(t);
  const { engine, state } = fakeEngine();
  state.machine = {
    ...state.machine,
    architecture: vm.architecture ?? "aarch64",
  };
  const findings = await doctorFindings({
    poolFile,
    paths,
    uid: ownUid,
    home,
    parts: {
      engine: () => engine,
      tokens: () => ({
        acquire: async () => ({ acquired: "Token", token: "pool-token" }),
        invalidate: () => undefined,
      }),
      plane: () =>
        /** @type {any} */ ({
          poll: async () => ({
            polled: "Reconciled",
            assignments: [],
            sessions: [],
            stop: [],
          }),
        }),
    },
  });
  return findings.map(findingLine);
}

test("a Mac with everything a run needs passes every check, warning only that no agent serves the pool", async (t) => {
  const lines = await doctored(t);
  assert.deepEqual(
    lines.map((line) => line.slice(0, line.indexOf(":"))),
    [
      "ok    pool file",
      "ok    runner configuration",
      "ok    control socket",
      "ok    Claude token file",
      "warn  launchd agent",
      "ok    docker",
      "ok    platform",
      "ok    job network",
      "ok    pool token",
      "ok    plane",
    ],
  );
});

test("a VM started again with another architecture than the pool registered fails the platform check", async (t) => {
  const lines = await doctored(t, { architecture: "x86_64" });
  assert.ok(
    lines.includes(
      "FAIL  platform: docker's VM runs Platform:Linux:Amd64, and the pool registered Platform:Linux:Arm64; start Colima with the architecture it registered, or register the pool again",
    ),
    lines.join("\n"),
  );
  const odd = await doctored(t, { architecture: "riscv64" });
  assert.ok(
    odd.includes("FAIL  platform: docker's VM is riscv64, which no pool runs"),
  );
});

test("the platform a VM runs is the one registration declares for its architecture", () => {
  for (const arch of ["arm64", "x64"]) {
    const answer = registerRequest(
      { api: "https://chuggy.example", token: "t", pool: "p" },
      { hostname: "p", arch },
    );
    assert.ok("request" in answer);
    assert.equal(vmPlatform(arch), answer.request.capabilities[0]);
  }
  assert.equal(vmPlatform("riscv64"), undefined);
});
