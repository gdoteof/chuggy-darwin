import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fakeEngine } from "./engine.fixture.mjs";
import {
  dockerEndpoint,
  dockerMachine,
  jobNetwork,
  ownScratchRemoved,
  poolRuntimeDirectory,
  poolSocket,
  runnerDirectories,
  runnerLeftoversRemoved,
  runnerParts,
  runnerSetup,
  socketPathBytesMax,
} from "./runner.mjs";
import { fixturePool, ownerOnly, runnerFixture } from "./runner.fixture.mjs";

const ownUid = process.getuid?.() ?? -1;

/** @param {Partial<{cpuMillis: number, memoryMib: number}>} asks */
const assignment = (asks = {}) => ({
  assignment: "asg-1",
  capabilities: ["Platform:Linux:Arm64"],
  image: "registry.chuggy.example/worker@sha256:" + "a".repeat(64),
  cpuMillis: 1,
  memoryMib: 1,
  deadlineSecs: 60,
  callbackUrl: "https://chuggy.example/worker",
  bearer: "attempt-bearer",
  ...asks,
});

test("a job is sized against the VM docker runs it in, not the Mac", async (t) => {
  const { home, poolFile } = await runnerFixture(t);
  const { engine, state } = fakeEngine();
  state.machine = {
    cpus: 2,
    memoryBytes: 2 * 1024 ** 3,
    architecture: "aarch64",
  };
  const runner = await runnerParts(await runnerSetup(poolFile, home), {
    uid: ownUid,
    home,
    log: () => undefined,
    engine,
  });
  for (const [asks, evidence] of /** @type {const} */ ([
    [
      { cpuMillis: 2001 },
      "the assignment asks for 2001 CPU millis and this machine has 2000",
    ],
    [
      { memoryMib: 2049 },
      "the assignment asks for 2049 MiB and this machine has 2048",
    ],
  ])) {
    const placed = await runner.backend.place(assignment(asks), "Job");
    assert.deepEqual([placed.placed, placed.evidence], ["Refused", evidence]);
  }
});

test("a run's backend refuses an assignment while the token file lies outside the home the VM shares", async (t) => {
  const { home, poolFile, paths } = await runnerFixture(t);
  const elsewhere = await mkdtemp(join(tmpdir(), "chuggy-darwin-elsewhere-"));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  const outside = await ownerOnly(join(elsewhere, "token"), "t");
  await ownerOnly(
    paths.config,
    JSON.stringify({
      claudeTokenFile: outside,
      timeoutSecsMax: 3600,
      outputBytesMax: 65536,
    }),
  );
  const { engine, state } = fakeEngine();
  const runner = await runnerParts(await runnerSetup(poolFile, home), {
    uid: ownUid,
    home,
    log: () => undefined,
    engine,
  });
  const calls = state.calls.length;
  const placed = await runner.backend.place(assignment(), "Job");
  assert.equal(placed.placed, "Refused");
  assert.match(
    placed.evidence ?? "",
    /is not under .*, or leads outside it, and .* is the only directory Colima shares with its VM by default/u,
  );
  assert.equal(state.calls.length, calls);
});

test("a pool registered with --host takes a job that pins no image and names the Mac's platform on the Mac, and leaves every other to its containers", async (t) => {
  const { home, poolFile, paths } = await runnerFixture(t, {
    runner: {
      images: [
        { image: "ghcr.io/owner/swift:6", capabilities: ["Tool:Swift"] },
      ],
    },
  });
  await ownerOnly(
    poolFile,
    JSON.stringify({
      ...fixturePool,
      capabilities: ["Platform:Linux:Arm64", "Platform:MacOS:Arm64"],
    }),
  );
  const { engine, state } = fakeEngine();
  const runner = await runnerParts(await runnerSetup(poolFile, home), {
    uid: ownUid + 1,
    home,
    log: () => undefined,
    engine,
  });
  const imageless = { ...assignment(), image: undefined };
  const calls = state.calls.length;
  const hosted = await runner.backend.place(
    { ...imageless, capabilities: ["Platform:MacOS:Arm64", "Tool:Xcode"] },
    "Job",
  );
  assert.match(hosted.evidence ?? "", /not by this runner's uid/u);
  const contained = await runner.backend.place(
    { ...imageless, capabilities: ["Platform:Linux:Arm64", "Tool:Xcode"] },
    "Job",
  );
  assert.match(
    contained.evidence ?? "",
    /no image this pool's owner listed declares every capability it names/u,
  );
  assert.equal(state.calls.length, calls);
  assert.deepEqual(runner.backend.inFlight(), []);
  assert.ok(paths.jobs.startsWith(home));
});

test("docker's machine is its VM's size and architecture, named as Node names one, and refused when docker cannot be asked or answers something else", async () => {
  const { engine, state } = fakeEngine();
  assert.deepEqual(await dockerMachine(engine), {
    size: { cpuMillis: 2000, memoryMib: 2048 },
    arch: "arm64",
  });
  state.machine = { ...state.machine, architecture: "x86_64" };
  assert.equal((await dockerMachine(engine)).arch, "x64");
  state.machine = { ...state.machine, architecture: "riscv64" };
  assert.equal((await dockerMachine(engine)).arch, "riscv64");
  state.machine = { ...state.machine, cpus: 0 };
  await assert.rejects(
    dockerMachine(engine),
    /^Error: docker answered ".*", not its CPUs, memory and architecture$/u,
  );
  state.unreachable = true;
  await assert.rejects(
    dockerMachine(engine),
    /^Error: docker could not be asked: Cannot connect to the Docker daemon/u,
  );
});

test("docker is refused when its context names no unix socket, or cannot be read", async () => {
  const { engine, state } = fakeEngine();
  assert.equal(
    await dockerEndpoint(engine),
    "unix:///Users/shame/.colima/default/docker.sock",
  );
  for (const host of ["tcp://192.0.2.10:2376", "ssh://op@build", ""]) {
    state.contextHost = host;
    await assert.rejects(
      dockerEndpoint(engine),
      new RegExp(
        `^Error: docker's context names "${host}", and only a docker reached by a unix socket, as Colima's is, is supported$`,
        "u",
      ),
    );
  }
  state.contextHost = undefined;
  await assert.rejects(
    dockerEndpoint(engine),
    /^Error: docker's context could not be read: context "default": context not found$/u,
  );
});

test("each pool has a runtime directory of its own, whose socket is refused past what macOS binds", () => {
  const paths = { runtime: "/Users/shame/Library/Caches/chuggy-darwin" };
  const runtime = poolRuntimeDirectory(/** @type {any} */ (paths), fixturePool);
  assert.match(
    runtime,
    /^\/Users\/shame\/Library\/Caches\/chuggy-darwin\/pools\/[0-9a-f]+$/u,
  );
  assert.notEqual(
    runtime,
    poolRuntimeDirectory(/** @type {any} */ (paths), {
      ...fixturePool,
      pool: "other",
    }),
  );
  assert.equal(poolSocket(runtime), join(runtime, "control.sock"));
  const long = join("/", "u".repeat(socketPathBytesMax));
  assert.throws(
    () => poolSocket(long),
    /is longer than the 103 bytes macOS binds a socket at$/u,
  );
});

test("the job network is made only where it is missing", async () => {
  const { engine, state } = fakeEngine();
  assert.equal(await jobNetwork(engine, "chuggy-jobs"), "Created");
  assert.equal(await jobNetwork(engine, "chuggy-jobs"), "Present");
  assert.ok(state.networks.has("chuggy-jobs"));
});

test("a job network another run made between the inspection and the creation is present", async () => {
  const { engine, state } = fakeEngine();
  const raced = {
    .../** @type {import("@chuggy/worker-core/engine.mjs").Engine} */ (engine),
    exec: async (
      /** @type {readonly string[]} */ argv,
      /** @type {import("@chuggy/worker-core/engine.mjs").EngineCall | undefined} */ call,
    ) => {
      if (argv[0] === "network" && argv[1] === "create") {
        state.networks.add(argv[2]);
        return {
          code: 1,
          stdout: "",
          stderr: `Error response from daemon: network with name ${argv[2]} already exists\n`,
        };
      }
      return engine.exec(argv, call);
    },
  };
  assert.equal(await jobNetwork(raced, "chuggy-jobs"), "Present");
  const refused = {
    ...raced,
    exec: async (/** @type {readonly string[]} */ argv) =>
      argv[1] === "create"
        ? { code: 1, stdout: "", stderr: "Error: permission denied\n" }
        : engine.exec(["network", "inspect", "missing"]),
  };
  await assert.rejects(
    jobNetwork(refused, "missing"),
    /^Error: network missing could not be created: Error: permission denied$/u,
  );
});

test("what a killed run left in a pool's runtime directory is removed, and nothing else", async (t) => {
  const { paths } = await runnerFixture(t);
  const runtime = poolRuntimeDirectory(paths, fixturePool);
  await runnerDirectories(paths, runtime);
  for (const entry of ["pull-9-a", "job-9-b", "keep"])
    await mkdir(join(runtime, entry));
  await runnerLeftoversRemoved(runtime);
  assert.deepEqual(await readdir(runtime), ["keep"]);
  assert.equal((await stat(runtime)).mode & 0o777, 0o700);
  assert.equal((await stat(paths.logs)).mode & 0o777, 0o700);
});

test("a process removes only the pull credentials and env files it made", async (t) => {
  const { paths } = await runnerFixture(t);
  const { runtime } = paths;
  for (const entry of ["pull-12-a", "job-12-b", "pull-123-c", "job-1-d"])
    await mkdir(join(runtime, entry), { recursive: true });
  await writeFile(join(runtime, "control.sock"), "");
  ownScratchRemoved(runtime, 12);
  assert.deepEqual((await readdir(runtime)).sort(), [
    "control.sock",
    "job-1-d",
    "pull-123-c",
  ]);
});

test("a SIGTERM removes the process's own scratch and still ends it by that signal", async (t) => {
  const { paths } = await runnerFixture(t);
  const { runtime } = paths;
  await mkdir(join(runtime, "pull-1-another"), { recursive: true });
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runtimeScratch } from ${JSON.stringify(import.meta.resolve("@chuggy/worker-core/runtimeScratch.mjs"))};
import { scratchRemovedOnSignal } from ${JSON.stringify(import.meta.resolve("./runner.mjs"))};
const runtime = process.argv[1];
mkdirSync(join(runtime, runtimeScratch("pull") + "x"));
scratchRemovedOnSignal(runtime);
process.stdout.write("ready\\n");
setInterval(() => undefined, 1000);`,
      runtime,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await once(child.stdout, "data");
  child.kill("SIGTERM");
  const [code, signal] = await once(child, "exit");
  assert.deepEqual([code, signal], [null, "SIGTERM"]);
  assert.deepEqual(await readdir(runtime), ["pull-1-another"]);
});
