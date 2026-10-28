import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { workerTaskVariable } from "@chuggy/worker-contract/workerEnvironment";
import { workerRunnerCapabilitiesHeader } from "@chuggy/worker-contract/workerPool";
import { claudeCredentialVariable } from "@chuggy/worker-core/claudeCredential.mjs";
import { heldLabel } from "@chuggy/worker-core/engineArgv.mjs";
import { jobProviderCredentialFile } from "@chuggy/worker-core/job.mjs";

import { fakeColima, fakeEngine } from "./engine.fixture.mjs";
import {
  dockerEndpoint,
  dockerMachine,
  jobNetwork,
  ownScratchRemoved,
  poolRuntimeDirectory,
  poolSocket,
  runnerDirectories,
  runnerLeftoversRemoved,
  runnerCapabilities,
  runnerClaimLock,
  runnerLoop,
  runnerMemoryLock,
  runnerParts,
  runnerReleasePrefix,
  runnerSetup,
  runnerUpdateLock,
  runnerUpdates,
  socketPathBytesMax,
  vmPlatformsFound,
} from "./runner.mjs";
import { updatedExitStatus } from "./launchAgent.mjs";
import { fixturePool, ownerOnly, runnerFixture } from "./runner.fixture.mjs";
import { runnerPaths } from "./runnerPaths.mjs";

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
    colima: fakeColima(90).colima,
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
    colima: fakeColima(90).colima,
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
      host: true,
    }),
  );
  const { engine, state } = fakeEngine();
  const runner = await runnerParts(await runnerSetup(poolFile, home), {
    colima: fakeColima(90).colima,
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
    /no image this pool's owner listed meets it/u,
  );
  assert.equal(state.calls.length, calls);
  assert.deepEqual(runner.backend.inFlight(), []);
  assert.ok(paths.jobs.startsWith(home));
});

/**
 * Catches a run advertising a platform its pool file names in place of the
 * VM's, an agent it has no image or host to run, a capability twice, or what
 * the pool was registered with beside what its own file declares.
 */
test("a run advertises the VM's platforms, the Mac's under --host, the agents its file can run, and what its file declares or else the rest of what its pool was registered with, each once", async (t) => {
  /**
   * @param {Parameters<typeof runnerFixture>[1]} documents
   * @param {string[]} vm the platforms docker's VM runs
   */
  const advertised = async (documents, vm) => {
    const { home, poolFile } = await runnerFixture(t, documents);
    return runnerCapabilities(await runnerSetup(poolFile, home), vm);
  };
  const arm64 = "Platform:Linux:Arm64";
  const amd64 = "Platform:Linux:Amd64";
  const registered = {
    ...fixturePool,
    capabilities: [
      "Platform:Linux:Arm64",
      "Platform:MacOS:Arm64",
      "Tool:Xcode",
      "Tool:Xcode",
      "Agent:Claude",
    ],
  };
  const claudeImages = [
    { image: "registry.example/claude", capabilities: ["Agent:Claude"] },
  ];
  for (const [documents, vm, capabilities] of [
    [{}, [arm64], [arm64]],
    [
      { pool: registered, runner: { images: claudeImages } },
      [amd64],
      [amd64, "Tool:Xcode", "Agent:Claude"],
    ],
    [{ pool: registered }, [arm64, amd64], [arm64, amd64, "Tool:Xcode"]],
    [
      { pool: { ...registered, host: true } },
      [arm64],
      [arm64, "Platform:MacOS:Arm64", "Tool:Xcode", "Agent:Claude"],
    ],
    [
      { pool: registered, runner: { images: claudeImages, capabilities: [] } },
      [arm64],
      [arm64, "Agent:Claude"],
    ],
    [
      { pool: registered, runner: { capabilities: ["gpu"] } },
      [arm64],
      [arm64, "gpu"],
    ],
    [
      {
        pool: { ...registered, host: true },
        runner: {
          codexCredential: { authFile: "/Users/you/.codex/auth.json" },
        },
      },
      [arm64],
      [
        arm64,
        "Platform:MacOS:Arm64",
        "Tool:Xcode",
        "Agent:Claude",
        "Agent:Codex",
      ],
    ],
  ])
    assert.deepEqual(
      await advertised(
        /** @type {Parameters<typeof runnerFixture>[1]} */ (documents),
        /** @type {string[]} */ (vm),
      ),
      capabilities,
      JSON.stringify(documents),
    );
});

/**
 * Catches a run started on a VM no pool runs on, or advertising a set the
 * plane refuses, which would end the pool at its first poll, and a `status`
 * or `stop`, which never polls, refused for it.
 */
test("a run is refused on a VM no pool runs on, and where it would advertise more than a pool may, naming the runner's file, while a command that never polls is not", async (t) => {
  const { home, poolFile } = await runnerFixture(t, {
    runner: {
      capabilities: Array.from({ length: 64 }, (_, at) => `c${String(at)}`),
    },
  });
  const setup = await runnerSetup(poolFile, home);
  assert.throws(
    () => runnerCapabilities(setup, ["Platform:Linux:Arm64"]),
    new Error(
      `runner configuration ${setup.paths.config}: capabilities: this runner would advertise 65 capabilities, its platforms and agents among them, and a pool advertises at most 64`,
    ),
  );
  const host = { uid: ownUid, home, log: () => undefined };
  await assert.rejects(
    runnerParts(setup, {
      colima: fakeColima(90).colima,
      ...host,
      engine: fakeEngine().engine,
    }),
    /^Error: runner configuration .*: capabilities: this runner would advertise 66 /u,
  );
  const { engine, state } = fakeEngine();
  state.machine = { ...state.machine, architecture: "riscv64" };
  await runnerParts(setup, {
    colima: fakeColima(90).colima,
    ...host,
    engine,
    polls: false,
  });
  await assert.rejects(
    vmPlatformsFound(
      { arch: "riscv64", name: "colima" },
      fakeColima(90).colima,
    ),
    new Error("docker's VM is riscv64, which no pool runs"),
  );
});

/**
 * Catches an arm64 VM advertising Amd64 without Rosetta, where QEMU would run
 * amd64 work at a small fraction of the speed, or not advertising it with
 * Rosetta, where most work asks for it; and Colima asked of a VM it does not
 * run, or of Rosetta where the VM runs amd64 itself.
 */
test("an arm64 VM runs Amd64 beside Arm64 where Colima runs amd64 there through Rosetta, and an x86_64 VM runs Amd64 alone", async () => {
  const arm64 = "Platform:Linux:Arm64";
  const amd64 = "Platform:Linux:Amd64";
  const colima = { arch: "arm64", name: "colima" };
  for (const [rosetta, platforms, found] of /** @type {const} */ ([
    ["enabled", [arm64, amd64], { rosetta: true }],
    ["disabled", [arm64], { rosetta: false }],
    ["absent", [arm64], { rosetta: false }],
  ]))
    assert.deepEqual(
      await vmPlatformsFound(colima, fakeColima(90, { rosetta }).colima),
      { platforms, rosetta: found },
      rosetta,
    );
  const intel = fakeColima(90);
  assert.deepEqual(
    await vmPlatformsFound({ arch: "x64", name: "colima" }, intel.colima),
    { platforms: [amd64] },
  );
  assert.deepEqual(intel.calls, []);
  const desktop = fakeColima(90);
  assert.deepEqual(
    await vmPlatformsFound(
      { arch: "arm64", name: "docker-desktop" },
      desktop.colima,
    ),
    {
      platforms: [arm64],
      rosetta: {
        unknown:
          "docker names its machine docker-desktop, which is no Colima VM",
      },
    },
  );
  assert.deepEqual(desktop.calls, []);
  const work = fakeColima(90);
  assert.deepEqual(
    await vmPlatformsFound({ arch: "arm64", name: "colima-work" }, work.colima),
    {
      platforms: [arm64],
      rosetta: {
        unknown:
          '/proc/sys/fs/binfmt_misc could not be listed in Colima\'s VM work: time="2026-10-27T22:38:17-04:00" level=fatal msg="colima [profile=work] not running"',
      },
    },
  );
  const unreadable = {
    /** @param {readonly string[]} argv */
    exec: async (argv) =>
      argv.includes("ls")
        ? { code: 0, stdout: "rosetta\nstatus\n", stderr: "" }
        : {
            code: 1,
            stdout: "",
            stderr: "cat: /proc/sys/fs/binfmt_misc/rosetta: Permission denied",
          },
  };
  assert.deepEqual(await vmPlatformsFound(colima, unreadable), {
    platforms: [arm64],
    rosetta: {
      unknown:
        "/proc/sys/fs/binfmt_misc/rosetta could not be read in Colima's VM default: cat: /proc/sys/fs/binfmt_misc/rosetta: Permission denied",
    },
  });
});

/**
 * Catches a run that finds its set and polls without it, or a command that
 * never polls advertising one.
 */
test("each poll of a run names what it advertises, and a command that never polls names none", async (t) => {
  const { home, poolFile } = await runnerFixture(t);
  const setup = await runnerSetup(poolFile, home);
  /** @type {(string | null)[]} */
  const named = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    named.push(
      new globalThis.Headers(init?.headers).get(workerRunnerCapabilitiesHeader),
    );
    return new globalThis.Response(
      JSON.stringify({ assignments: [], sessions: [], stop: [] }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  });
  for (const polls of [true, false]) {
    const runner = await runnerParts(setup, {
      colima: fakeColima(90).colima,
      uid: ownUid,
      home,
      log: () => undefined,
      engine: fakeEngine().engine,
      polls,
    });
    await runner.client.plane.poll("pool-token", [], 0, 0);
  }
  assert.deepEqual(named, ["Platform:Linux:Arm64,Platform:Linux:Amd64", null]);
});

test("a runner's client is given its own pool's limits from pools, and the file's where pools names another, a concurrencyMax of 0 among them", async (t) => {
  for (const [runner, limits] of [
    [{ concurrencyMax: 0 }, [0, 2]],
    [
      {
        pools: { "vteng.chuggy.shame": { concurrencyMax: 0, sessionsMax: 1 } },
      },
      [0, 1],
    ],
    [{ pools: { "vteng.chuggy.shame": { sessionsMax: 0 } } }, [3, 0]],
    [{ pools: { other: { concurrencyMax: 0, sessionsMax: 1 } } }, [3, 2]],
  ]) {
    const { home, poolFile } = await runnerFixture(t, {
      runner: { concurrencyMax: 3, ...runner },
    });
    const { engine } = fakeEngine();
    const { client } = await runnerParts(await runnerSetup(poolFile, home), {
      colima: fakeColima(90).colima,
      uid: ownUid,
      home,
      log: () => undefined,
      engine,
    });
    assert.deepEqual(
      [client.settings.concurrencyMax, client.settings.sessionsMax],
      limits,
      JSON.stringify(runner),
    );
  }
});

test("a run removes a job's image it pulled once unused for as long as its file says, by the record every runner on this Mac keeps", async (t) => {
  const image = `ghcr.io/someone/tool@sha256:${"b".repeat(64)}`;
  for (const [imageUnusedSecsMax, kept] of [
    [undefined, true],
    [86_399, false],
  ]) {
    const { home, poolFile } = await runnerFixture(t, {
      runner: imageUnusedSecsMax === undefined ? {} : { imageUnusedSecsMax },
    });
    const file = join(runnerPaths(home).images, "docker.json");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        createdMs: 0,
        repositories: {},
        images: {
          [image]: {
            kinds: ["Job"],
            usedMs: Date.now() - 86_400_000,
            pulledId: "sha256:1",
          },
        },
        holds: {},
      }),
    );
    const { engine } = fakeEngine();
    /** @type {string[]} */
    const removed = [];
    const answered = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    const runner = await runnerParts(await runnerSetup(poolFile, home), {
      colima: fakeColima(90).colima,
      uid: ownUid,
      home,
      log: () => undefined,
      engine: {
        ...engine,
        exec: async (argv, call) => {
          const [verb, sub, ...rest] = argv;
          if (verb !== "image" || (sub === "inspect" && rest[0] === "--format"))
            return engine.exec(argv, call);
          if (sub === "ls") return answered("sha256:1\n");
          if (sub === "rm") {
            removed.push(rest[0]);
            return answered(`Untagged: ${rest[0]}\nDeleted: sha256:1\n`);
          }
          return answered(
            JSON.stringify([
              { Id: "sha256:1", RepoTags: [], RepoDigests: [image] },
            ]),
          );
        },
      },
    });
    await runner.backend.held();
    await runner.backend.settled();
    assert.deepEqual(removed, kept ? [] : [image], String(imageUnusedSecsMax));
  }
});

/** A power assertion that keeps nothing awake, for a suite that holds work. */
const unpowered = { held: () => undefined, asserted: () => false };

/**
 * Docker in a VM of 16 GiB, whose containers outside every pool use `usedGib`.
 *
 * @param {number} usedGib
 */
function vmUsing(usedGib) {
  const { engine, state } = fakeEngine();
  state.machine = { ...state.machine, memoryBytes: 16 * 2 ** 30 };
  state.containers.set("chuggy-jobs-postgres", {
    id: "id-postgres",
    name: "chuggy-jobs-postgres",
    labels: {},
    status: "running",
    image: "postgres",
    usedBytes: usedGib * 2 ** 30,
  });
  return { engine, state };
}

test("a run holds the floor its file sets in GiB free where docker stores in Colima's VM, taking no job under it, and keeps none at 0", async (t) => {
  const where = "/var/lib/docker in Colima's VM";
  for (const [diskFreeGibMin, gib, taken] of /** @type {const} */ ([
    [undefined, 19.9, false],
    [undefined, 20, true],
    [8, 7.5, false],
    [0, 0.5, true],
  ])) {
    const label = `${String(diskFreeGibMin)} at ${String(gib)}`;
    const { home, poolFile } = await runnerFixture(t, {
      runner: diskFreeGibMin === undefined ? {} : { diskFreeGibMin },
    });
    const vm = fakeColima(gib);
    /** @type {string[]} */
    const logged = [];
    const runner = await runnerParts(await runnerSetup(poolFile, home), {
      uid: ownUid,
      home,
      log: (line) => logged.push(line),
      engine: fakeEngine().engine,
      colima: vm.colima,
      power: unpowered,
    });
    await runner.client.backend.held();
    await runner.backend.settled();
    assert.equal(runner.client.backend.jobsTaken?.(false), taken, label);
    if (diskFreeGibMin === 0) assert.deepEqual(vm.measured, [], label);
    else
      assert.equal(
        logged.includes(
          `this runner's disk has ${String(gib)} GiB free at ${where}, under its floor of ${String(diskFreeGibMin ?? 20)} GiB: it takes no job until it is over`,
        ),
        !taken,
        `${label}: ${logged.join("; ")}`,
      );
  }
});

test("every pool's agent of a user takes one install lock, and one memory lock and one claim lock, in the runner's runtime directory, since every one runs the one install in the one VM", () => {
  const paths = runnerPaths("/Users/shame");
  assert.equal(
    runnerUpdateLock(paths),
    "/Users/shame/Library/Caches/chuggy-darwin/update.lock",
  );
  assert.equal(
    runnerMemoryLock(paths),
    "/Users/shame/Library/Caches/chuggy-darwin/memory/docker.lock",
  );
  assert.equal(
    runnerClaimLock(paths),
    "/Users/shame/Library/Caches/chuggy-darwin/memory/docker.claim",
  );
});

test("a run's memory budget is the VM's memory less the GiB its file keeps free, none unless it says, and it takes no job without room", async (t) => {
  for (const [memoryFreeGibMin, usedGib, taken] of /** @type {const} */ ([
    [undefined, 15.5, true],
    [undefined, 15.6, false],
    [4, 11.6, false],
    [2, 13.5, true],
  ])) {
    const label = `${String(memoryFreeGibMin)} with ${String(usedGib)} used`;
    const { home, poolFile } = await runnerFixture(t, {
      runner: memoryFreeGibMin === undefined ? {} : { memoryFreeGibMin },
    });
    const runner = await runnerParts(await runnerSetup(poolFile, home), {
      colima: fakeColima(90).colima,
      uid: ownUid,
      home,
      log: () => undefined,
      engine: vmUsing(usedGib).engine,
      power: unpowered,
    });
    await runner.client.backend.held();
    assert.equal(runner.client.backend.jobsTaken?.(false), taken, label);
  }
});

test("a run's ceiling for a job is its budget less the GiB its file reserves, none unless it says, and its agent claims jobs under the VM's claim lock", async (t) => {
  for (const [memoryReservedGib, ceilingMib] of /** @type {const} */ ([
    [undefined, 16 * 1024],
    [6, 10 * 1024],
    [20, 0],
  ])) {
    const { home, poolFile, paths } = await runnerFixture(t, {
      runner: memoryReservedGib === undefined ? {} : { memoryReservedGib },
    });
    const runner = await runnerParts(await runnerSetup(poolFile, home), {
      colima: fakeColima(90).colima,
      uid: ownUid,
      home,
      log: () => undefined,
      engine: vmUsing(0).engine,
      power: unpowered,
    });
    await runner.client.backend.held();
    assert.deepEqual(runner.client.backend.memoryRoom?.(), {
      roomMib: 16 * 1024,
      ceilingMib,
    });
    const lock = runnerClaimLock(paths);
    const release = await runner.client.backend.claimed?.();
    assert.ok(release !== undefined);
    assert.equal(existsSync(lock), true);
    await release();
    assert.equal(existsSync(lock), false);
  }
});

test("every pool's agent of a user starts its jobs under the one memory lock of the VM", async (t) => {
  const { home, poolFile, paths } = await runnerFixture(t);
  const otherFile = await ownerOnly(
    join(paths.pools, "vteng.chuggy.other.json"),
    JSON.stringify({ ...fixturePool, pool: "other" }),
  );
  const lock = runnerMemoryLock(paths);
  const { engine } = vmUsing(0);
  /** @type {boolean[]} */
  const lockedAtHold = [];
  const watched = {
    ...engine,
    /** @type {typeof engine.exec} */
    exec: (argv, options) => {
      if (
        argv[0] === "volume" &&
        argv[1] === "create" &&
        argv.some((arg) => arg.startsWith(`${heldLabel}=`))
      )
        lockedAtHold.push(existsSync(lock));
      return engine.exec(argv, options);
    },
  };
  for (const [file, name] of /** @type {const} */ ([
    [poolFile, "asg-1"],
    [otherFile, "asg-2"],
  ])) {
    const runner = await runnerParts(await runnerSetup(file, home), {
      colima: fakeColima(90).colima,
      uid: ownUid,
      home,
      log: () => undefined,
      engine: watched,
      power: unpowered,
    });
    await runner.client.backend.held();
    await runner.backend.place(
      { ...assignment(), assignment: name, memoryMib: 512 },
      "Job",
    );
    await runner.backend.settled();
  }
  assert.deepEqual(lockedAtHold, [true, true]);
});

test("docker's machine is its VM's size and architecture, named as Node names one, and refused when docker cannot be asked or answers something else", async () => {
  const { engine, state } = fakeEngine();
  assert.deepEqual(await dockerMachine(engine), {
    size: { cpuMillis: 2000, memoryMib: 2048 },
    arch: "arm64",
    name: "colima",
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

/**
 * Each way a runner's file may name a Claude credential kept in `file`, and
 * the setting a workload is told the kind by.
 *
 * @param {string} file
 * @returns {Array<[Record<string, unknown>, Record<string, string>]>}
 */
function claudeNamings(file) {
  return [
    [{ claudeTokenFile: file }, { kind: "Subscription" }],
    [
      { claudeCredential: { kind: "Subscription", tokenFile: file } },
      { kind: "Subscription" },
    ],
    [
      { claudeCredential: { kind: "ApiKey", apiKeyFile: file } },
      { kind: "ApiKey" },
    ],
    [
      {
        claudeCredential: {
          kind: "Bedrock",
          region: "us-west-2",
          apiKeyFile: file,
        },
      },
      { kind: "Bedrock", region: "us-west-2" },
    ],
    [
      {
        claudeCredential: {
          kind: "Bedrock",
          region: "us-west-2",
          credentialsFile: file,
        },
      },
      { kind: "Bedrock", region: "us-west-2", profile: "default" },
    ],
    [
      {
        claudeCredential: {
          kind: "Vertex",
          region: "us-east5",
          project: "chuggy-jobs",
          credentialsFile: file,
        },
      },
      { kind: "Vertex", region: "us-east5", project: "chuggy-jobs" },
    ],
    [
      {
        claudeCredential: {
          kind: "Foundry",
          resource: "chuggy-jobs",
          apiKeyFile: file,
        },
      },
      { kind: "Foundry", resource: "chuggy-jobs" },
    ],
  ];
}

/**
 * Rewrites the runner's file to name the Claude credential `named` names.
 *
 * @param {{config: string}} paths
 * @param {Record<string, unknown>} named
 */
function claudeNamed(paths, named) {
  return ownerOnly(
    paths.config,
    JSON.stringify({ timeoutSecsMax: 3600, outputBytesMax: 65536, ...named }),
  );
}

/**
 * The setting a workload's variables tell it the Claude credential's kind by.
 *
 * @param {readonly string[]} variables each `NAME=value`
 */
function claudeToldOf(variables) {
  const told = variables.filter((line) =>
    line.startsWith(`${claudeCredentialVariable}=`),
  );
  assert.equal(told.length, 1, variables.join("\n"));
  return JSON.parse(told[0].slice(claudeCredentialVariable.length + 1));
}

test("a job and a session in a container are each told the kind of Claude credential the runner's file names, a subscription's where it names claudeTokenFile, and mount its file", async (t) => {
  for (const index of claudeNamings("").keys()) {
    const { home, poolFile, paths, tokenFile } = await runnerFixture(t);
    const [named, setting] = claudeNamings(tokenFile)[index];
    await claudeNamed(paths, named);
    const { engine, state } = fakeEngine();
    const runner = await runnerParts(await runnerSetup(poolFile, home), {
      colima: fakeColima(90).colima,
      uid: ownUid,
      home,
      log: () => undefined,
      engine,
    });
    const job = await runner.backend.place(assignment(), "Job");
    const session = await runner.backend.place(
      { ...assignment(), assignment: "ses-1" },
      "Session",
    );
    assert.deepEqual([job.placed, session.placed], ["Placed", "Placed"]);
    await runner.backend.settled();
    const runs = state.calls.filter(({ argv }) => argv[0] === "run");
    assert.equal(runs.length, 2);
    for (const run of runs) {
      const variables = (run.envFile ?? "")
        .split("\n")
        .filter((line) => line !== "");
      assert.deepEqual(claudeToldOf(variables), setting);
      const mount = `type=bind,source=${tokenFile},target=${jobProviderCredentialFile},readonly`;
      assert.equal(
        run.argv[run.argv.indexOf(mount) - 1],
        "--mount",
        JSON.stringify(named),
      );
    }
  }
});

/** A pool registered with `--host`, its file naming the Mac's platform. */
const hostPool = {
  ...fixturePool,
  capabilities: ["Platform:Linux:Arm64", "Platform:MacOS:Arm64"],
  host: true,
};

/**
 * The environment the core of a job placed on the Mac itself starts with,
 * its spawn stood in for by one that exits at once.
 *
 * @param {{home: string, poolFile: string}} fixture
 * @param {readonly string[]} capabilities the assignment's
 * @returns {Promise<Record<string, string>>}
 */
async function hostStartedWith({ home, poolFile }, capabilities) {
  /** @type {Array<Record<string, string>>} */
  const started = [];
  /** @type {Promise<unknown>[]} */
  const closed = [];
  const runner = await runnerParts(await runnerSetup(poolFile, home), {
    colima: fakeColima(90).colima,
    uid: ownUid,
    home,
    log: () => undefined,
    engine: fakeEngine().engine,
    spawn: /** @type {any} */ (
      (
        /** @type {string} */ _command,
        /** @type {string[]} */ _argv,
        /** @type {{env: Record<string, string>}} */ options,
      ) => {
        started.push(options.env);
        const child = spawn(process.execPath, ["-e", ""], {
          detached: true,
          stdio: "ignore",
        });
        closed.push(once(child, "close"));
        return child;
      }
    ),
  });
  const placed = await runner.backend.place(
    { ...assignment(), image: undefined, capabilities: [...capabilities] },
    "Job",
  );
  assert.equal(placed.placed, "Placed", placed.evidence);
  await Promise.all(closed);
  await runner.backend.settled();
  assert.equal(started.length, 1);
  return started[0];
}

test("a job on the Mac itself is told the kind of Claude credential the runner's file names, a subscription's where it names claudeTokenFile, and reads its file where it is", async (t) => {
  for (const index of claudeNamings("").keys()) {
    const fixture = await runnerFixture(t, { pool: hostPool });
    const [named, setting] = claudeNamings(fixture.tokenFile)[index];
    await claudeNamed(fixture.paths, named);
    const started = await hostStartedWith(fixture, [
      "Platform:MacOS:Arm64",
      "Agent:Claude",
    ]);
    const variables = Object.entries(started).map(
      ([name, value]) => `${name}=${value}`,
    );
    assert.deepEqual(claudeToldOf(variables), setting);
    assert.equal(
      JSON.parse(started[workerTaskVariable]).providerCredentialFile,
      fixture.tokenFile,
    );
  }
});

/**
 * An assignment requiring one agent, pinning no image.
 *
 * @param {string} name
 * @param {string} agent
 * @param {string} [platform]
 */
const agentRequired = (name, agent, platform = "Platform:Linux:Arm64") => ({
  ...assignment(),
  assignment: name,
  image: undefined,
  capabilities: [platform, agent],
});

/**
 * A run's backend over a fake engine, as this uid, for a runner whose file
 * names its Claude token file and, under the home, a Codex auth file, and
 * lists an image declaring both agents; and both files.
 *
 * @param {import("node:test").TestContext} t
 * @param {{uid?: number, codex?: boolean, outside?: boolean}} [runner] this uid where not the suite's, no Codex credential where `codex` is false, and the Codex file outside the home where `outside` is true
 */
async function codexPlacing(t, runner = {}) {
  const { home, poolFile, paths, tokenFile } = await runnerFixture(t);
  const directory = runner.outside
    ? await mkdtemp(join(tmpdir(), "chuggy-darwin-codex-"))
    : join(home, ".codex");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const codex = await ownerOnly(join(directory, "auth.json"), "{}");
  await ownerOnly(
    paths.config,
    JSON.stringify({
      claudeTokenFile: tokenFile,
      timeoutSecsMax: 3600,
      outputBytesMax: 65536,
      images: [
        {
          image: assignment().image,
          capabilities: ["Agent:Claude", "Agent:Codex"],
        },
      ],
      ...(runner.codex === false
        ? {}
        : { codexCredential: { authFile: codex } }),
    }),
  );
  const { engine, state } = fakeEngine();
  const parts = await runnerParts(await runnerSetup(poolFile, home), {
    colima: fakeColima(90).colima,
    uid: runner.uid ?? ownUid,
    home,
    log: () => undefined,
    engine,
  });
  return { backend: parts.backend, state, claude: tokenFile, codex };
}

/** @param {string} file */
const credentialMount = (file) =>
  `type=bind,source=${file},target=${jobProviderCredentialFile},readonly`;

/**
 * Catches a job requiring Codex mounted the Claude credential or told its
 * kind, or one requiring Claude mounted the Codex file.
 */
test("a runner whose file names a Codex credential mounts it into a job requiring Agent:Codex, told no Claude kind, and the Claude one into a job requiring Claude", async (t) => {
  const { backend, state, claude, codex } = await codexPlacing(t);
  for (const [name, agent] of [
    ["asg-codex", "Agent:Codex"],
    ["asg-claude", "Agent:Claude"],
  ]) {
    const placed = await backend.place(agentRequired(name, agent), "Job");
    assert.equal(placed.placed, "Placed", placed.evidence);
  }
  await backend.settled();
  /** @param {string} name */
  const ran = (name) => {
    const call = state.calls.find(
      ({ argv }) =>
        argv[0] === "run" && argv.includes(`io.chuggy.assignment=${name}`),
    );
    assert.ok(call !== undefined, name);
    return call;
  };
  const codexJob = ran("asg-codex");
  assert.ok(codexJob.argv.includes(credentialMount(codex)));
  assert.ok(!codexJob.argv.includes(credentialMount(claude)));
  assert.doesNotMatch(
    codexJob.envFile ?? "",
    new RegExp(claudeCredentialVariable, "u"),
  );
  const claudeJob = ran("asg-claude");
  assert.ok(claudeJob.argv.includes(credentialMount(claude)));
  assert.deepEqual(claudeToldOf((claudeJob.envFile ?? "").split("\n")), {
    kind: "Subscription",
  });
});

/**
 * Catches the runner's check of the Codex file naming it as Claude's, or
 * letting through one Colima's VM would show a job nothing at; or a Codex
 * job refused, or handed other than the Claude file, by a runner whose file
 * names no Codex credential.
 */
test("a runner refuses a job requiring Agent:Codex where its Codex credential's file is not its to hand over or lies outside the home the VM shares, naming that file, and one whose file names none mounts the Claude one into it", async (t) => {
  const other = await codexPlacing(t, { uid: ownUid + 1 });
  assert.match(
    (await other.backend.place(agentRequired("asg-1", "Agent:Codex"), "Job"))
      .evidence ?? "",
    new RegExp(`^the Codex auth file ${other.codex} is owned by uid`, "u"),
  );
  const outside = await codexPlacing(t, { outside: true });
  assert.match(
    (await outside.backend.place(agentRequired("asg-1", "Agent:Codex"), "Job"))
      .evidence ?? "",
    new RegExp(
      `^the Codex auth file ${outside.codex} is not under .+, and .+ is the only directory Colima shares with its VM by default`,
      "u",
    ),
  );
  for (const { state } of [other, outside])
    assert.ok(!state.calls.some(({ argv }) => argv[0] === "run"));
  const without = await codexPlacing(t, { codex: false });
  const placed = await without.backend.place(
    agentRequired("asg-1", "Agent:Codex"),
    "Job",
  );
  assert.equal(placed.placed, "Placed", placed.evidence);
  await without.backend.settled();
  const run = without.state.calls.find(({ argv }) => argv[0] === "run");
  assert.ok(run?.argv.includes(credentialMount(without.claude)));
  assert.deepEqual(claudeToldOf((run?.envFile ?? "").split("\n")), {
    kind: "Subscription",
  });
});

/**
 * Catches a host job requiring Codex handed the Claude credential, or told
 * its kind.
 */
test("a pool registered with --host hands a job on the Mac requiring Agent:Codex the Codex credential's file where it is, told no Claude kind", async (t) => {
  const fixture = await runnerFixture(t, { pool: hostPool });
  const codex = await ownerOnly(
    join(fixture.home, ".codex", "auth.json"),
    "{}",
  );
  await claudeNamed(fixture.paths, {
    claudeTokenFile: fixture.tokenFile,
    codexCredential: { authFile: codex },
  });
  const started = await hostStartedWith(fixture, [
    "Platform:MacOS:Arm64",
    "Agent:Codex",
  ]);
  assert.equal(
    JSON.parse(started[workerTaskVariable]).providerCredentialFile,
    codex,
  );
  assert.ok(!Object.hasOwn(started, claudeCredentialVariable));
});

/** A release of this package above the copy a suite's runs are made of. */
const nextRelease = {
  package: "chuggy-darwin",
  version: "9.8.8",
  url: `${runnerReleasePrefix}v9.8.8/chuggy-darwin-9.8.8.tgz`,
  integrity: `sha512-${"A".repeat(86)}==`,
};

/**
 * A client whose plane answers each poll as `polled` says, holding nothing.
 *
 * @param {() => unknown} polled
 */
function polledClient(polled) {
  return /** @type {any} */ ({
    tokens: {
      acquire: async () => ({ acquired: "Token", token: "pool-token" }),
      invalidate: () => undefined,
    },
    plane: { poll: async () => polled() },
    backend: { held: async () => [], ended: async () => [] },
    settings: { concurrencyMax: 2, outageBackoffMs: 5000, passesMax: 1 },
  });
}

/** The update of a copy at 9.8.7 that installs whatever release it is given. */
const installingUpdates = {
  on: true,
  updater: /** @type {any} */ ({
    runner: { package: "chuggy-darwin", version: "9.8.7" },
    refusal: async () => undefined,
    update: async (/** @type {{version: string}} */ release) => ({
      updated: "Installed",
      version: release.version,
    }),
  }),
};

/**
 * Catches a denied run restarted by its agent, or an updated one left
 * stopped, or one started by hand told nothing of the release it installed.
 */
test("a run the plane denies is done, and one that installed a release of itself ends with the status its agent restarts after, and started by hand says to start it again", async () => {
  /** @type {string[]} */
  const denials = [];
  assert.equal(
    await runnerLoop(
      polledClient(() => ({
        polled: "Denied",
        evidence: "the pool was revoked",
      })),
      {
        sleep: async () => undefined,
        log: (line) => denials.push(line),
        updates: installingUpdates,
        underAgent: true,
      },
    ),
    0,
  );
  assert.deepEqual(denials, [
    "the plane denied this pool: the pool was revoked",
  ]);
  for (const [underAgent, said] of /** @type {const} */ ([
    [true, "ending, for launchd to restart this run on chuggy-darwin 9.8.8"],
    [false, "ending: start this run again to run chuggy-darwin 9.8.8"],
  ])) {
    /** @type {string[]} */
    const log = [];
    const status = await runnerLoop(
      polledClient(() => ({
        polled: "Reconciled",
        assignments: [],
        sessions: [],
        stop: [],
        release: nextRelease,
      })),
      {
        sleep: async () => undefined,
        log: (line) => log.push(line),
        updates: installingUpdates,
        underAgent,
      },
    );
    assert.equal(status, updatedExitStatus);
    assert.notEqual(updatedExitStatus, 0);
    assert.equal(log.at(-1), said);
  }
});

/**
 * Catches a run updating from another package's downloads, into another
 * directory than its own copy's, or where the runner's file turns it off.
 */
test("a run updates itself as the runner's file says, from this package's own release downloads into the directory its copy is installed in", async (t) => {
  const { home, poolFile } = await runnerFixture(t);
  const copy = {
    package: "chuggy-darwin",
    version: "9.8.7",
    cli: "/opt/chuggy-darwin/cli.mjs",
  };
  const updates = runnerUpdates(await runnerSetup(poolFile, home), copy);
  assert.equal(updates.on, true);
  assert.deepEqual(updates.updater.runner, {
    package: "chuggy-darwin",
    version: "9.8.7",
  });
  assert.equal(
    await updates.updater.refusal(nextRelease),
    "this runner is installed at /opt/chuggy-darwin, which is not where npm installs a package globally",
  );
  const elsewhere =
    "https://github.com/kasofsk/chuggy-linux/releases/download/v9.8.8/chuggy-darwin-9.8.8.tgz";
  assert.equal(
    await updates.updater.refusal({ ...nextRelease, url: elsewhere }),
    `its address, ${elsewhere}, is not a release download under ${runnerReleasePrefix}`,
  );
  const off = await runnerFixture(t, { runner: { autoUpdate: false } });
  assert.equal(
    runnerUpdates(await runnerSetup(off.poolFile, off.home), copy).on,
    false,
  );
});
