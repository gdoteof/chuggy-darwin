import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { workerRunnerHeader } from "@chuggy/worker-contract/workerPool";
import { controlSocketPath } from "@chuggy/worker-core/control.mjs";
import { heldCreateArgv } from "@chuggy/worker-core/engineArgv.mjs";

import { cliMain } from "./commands.mjs";
import { controlServed, inFlightFixture } from "./control.fixture.mjs";
import { fakeColima, fakeEngine } from "./engine.fixture.mjs";
import {
  answeringFetch,
  registeredFixture,
  registeredPersonalFixture,
} from "./register.fixture.mjs";
import { launchAgentLabel, updatedExitStatus } from "./launchAgent.mjs";
import { poolRuntimeDirectory, runnerReleasePrefix } from "./runner.mjs";
import { fixturePool, ownerOnly, runnerFixture } from "./runner.fixture.mjs";
import { runnerPaths } from "./runnerPaths.mjs";

/**
 * @typedef {object} Machine
 * @property {Record<string, string>} [environment]
 * @property {string} [home]
 * @property {string} [hostname]
 * @property {string} [architecture] the docker VM's, as `docker info` names it
 * @property {string} [arch] the Mac's own, as `process.arch` names it
 * @property {typeof globalThis.fetch} [fetch]
 * @property {import("@chuggy/worker-core/engine.mjs").Engine} [engine]
 * @property {import("./colimaVm.mjs").ColimaCli} [colima]
 * @property {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient["tokens"]} [tokens] where not one whose issuer has revoked the pool
 * @property {Partial<import("@chuggy/worker-core/runnerUpdate.mjs").RunnerUpdatePorts>} [updatePorts]
 * @property {string} [cli] the copy's entry, where not one installed outside npm's global directory
 * @property {boolean} [desktop] `false` where the user is not logged in at the Mac's screen
 */

/** The version the suite's copy says it is. */
const copyVersion = "9.8.7";

/**
 * Docker with a VM of the given architecture.
 *
 * @param {string} architecture
 */
function vm(architecture) {
  const { engine, state } = fakeEngine();
  state.machine = { ...state.machine, architecture };
  return engine;
}

/** A token source whose issuer has revoked the pool, so a pass ends without the network. */
const deniedTokens = {
  acquire: async () => ({
    acquired: "Denied",
    evidence: "the pool was revoked",
  }),
  invalidate: () => undefined,
};

/**
 * @param {readonly string[]} argv
 * @param {Machine} machine
 */
async function called(argv, machine = {}) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  const status = await cliMain(argv, {
    environment: machine.environment ?? {},
    home: machine.home ?? "/nonexistent",
    uid: process.getuid?.() ?? -1,
    hostname: machine.hostname ?? "shame",
    arch: machine.arch ?? "arm64",
    fetch:
      machine.fetch ??
      (async () => {
        throw new Error("a suite reaches no network");
      }),
    engine: machine.engine ?? vm(machine.architecture ?? "aarch64"),
    colima: machine.colima ?? fakeColima(90).colima,
    tokens: machine.tokens ?? deniedTokens,
    packageName: "chuggy-darwin",
    version: copyVersion,
    node: "/opt/homebrew/bin/node",
    nodeVersion: "24.0.0",
    cli: machine.cli ?? "/opt/chuggy-darwin/cli.mjs",
    updatePorts: machine.updatePorts,
    desktop: async () => machine.desktop ?? true,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { status, out: out.join("\n"), err: err.join("\n") };
}

/**
 * A Mac's home, with the runner's file written before `register` as the
 * README has it, unless `runner` is named and undefined.
 *
 * @param {import("node:test").TestContext} t
 * @param {{runner?: Record<string, unknown> | undefined}} [documents] what the runner's file sets beside its credential and limits
 */
async function home(t, documents = {}) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-darwin-home-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { runner = {} } = documents;
  if (!("runner" in documents) || documents.runner !== undefined)
    await ownerOnly(
      runnerPaths(directory).config,
      JSON.stringify({
        claudeTokenFile: join(directory, ".claude-token"),
        timeoutSecsMax: 3600,
        outputBytesMax: 65536,
        ...runner,
      }),
    );
  return directory;
}

/** What chuggy answers a redemption from an Apple silicon Mac with. */
const registered = {
  ...registeredFixture,
  capabilities: ["Platform:Linux:Arm64"],
};

/** What chuggy answers a personal redemption from an Apple silicon Mac with. */
const registeredPersonal = {
  ...registeredPersonalFixture,
  capabilities: ["Platform:Linux:Arm64"],
};

/** The file a personal registration writes, less `.json`. */
const personalBase =
  "newtenant.28_3ahttps_3a_2f_2fauth_2echuggy_2eexample_2f0f3c9a52-member";

const registerArgv = [
  "register",
  "--api",
  "https://chuggy.example",
  "--token=registration-token-fixture",
];

test("help is asked for and answered", async () => {
  for (const argv of [["--help"], ["help"], ["-h"]]) {
    const { status, out } = await called(argv);
    assert.equal(status, 0);
    assert.match(out, /^usage: chuggy-darwin <command>/u);
  }
});

test("a call asked wrongly exits 2 with the usage", async () => {
  for (const argv of [
    [],
    ["frobnicate", "--pool", "/p"],
    ["status", "extra", "--pool", "/p"],
    ["stop", "--pool", "/p"],
    ["run", "--token=t", "--pool", "/p"],
    ["doctor", "--personal", "--pool", "/p"],
    ["run", "--host", "--pool", "/p"],
    ["status", "--capability", "Tool:Bazel", "--pool", "/p"],
    ["register", "--pools", "/p"],
    [...registerArgv, "extra"],
  ]) {
    const { status, err } = await called(argv);
    assert.equal(status, 2, argv.join(" "));
    assert.match(err, /usage: chuggy-darwin/u, argv.join(" "));
  }
});

test("register writes the pool file it redeems the token for where chuggy-linux would, and prints no secret", async (t) => {
  const machine = await home(t);
  const { fetch, requests } = answeringFetch(201, registered);
  const { status, out, err } = await called(registerArgv, {
    home: machine,
    hostname: "Shame.local",
    fetch,
  });
  assert.equal(status, 0, err);
  const pools = join(machine, ".config", "chuggy", "pools");
  const file = join(pools, "newtenant.arbbot.shame.json");
  assert.equal(
    out,
    [
      `wrote ${file}; next:`,
      `  chuggy-darwin doctor --pool ${file}`,
      `  chuggy-darwin install-agent --pool ${file}`,
    ].join("\n"),
  );
  assert.equal(err, "");
  const body = JSON.parse(String(requests[0].init.body));
  assert.equal(body.pool, "shame");
  assert.deepEqual(body.capabilities, ["Platform:Linux:Arm64"]);
  assert.equal((await stat(pools)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), registered);
  assert.ok(!`${out}${err}`.includes(registered.clientSecret));
  const again = await called(registerArgv, { home: machine, fetch });
  assert.match(again.out, new RegExp(`^replaced ${file}; next:`, "u"));
});

test("register --personal redeems a member's personal token for their runner's file, named for its tenant and member, asking for no pool", async (t) => {
  const machine = await home(t);
  const { fetch, requests } = answeringFetch(201, registeredPersonal);
  const { status, out, err } = await called([...registerArgv, "--personal"], {
    home: machine,
    fetch,
  });
  assert.equal(status, 0, err);
  const file = join(
    machine,
    ".config",
    "chuggy",
    "pools",
    `${personalBase}.json`,
  );
  assert.equal(
    out,
    [
      `wrote ${file}; next:`,
      `  chuggy-darwin doctor --pool ${file}`,
      `  chuggy-darwin install-agent --pool ${file}`,
    ].join("\n"),
  );
  assert.equal(
    requests[0].url,
    "https://chuggy.example/api/v1/personal-runner-registrations",
  );
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
    token: "registration-token-fixture",
    capabilities: ["Platform:Linux:Arm64"],
  });
  assert.deepEqual(
    JSON.parse(await readFile(file, "utf8")),
    registeredPersonal,
  );
});

test("doctor's first line names the copy speaking and the Node it runs under", async (t) => {
  const { home, poolFile } = await runnerFixture(t);
  const { out } = await called(["doctor", "--pool", poolFile], { home });
  assert.equal(
    out.split("\n")[0],
    `chuggy-darwin ${copyVersion} at /opt/chuggy-darwin/cli.mjs, under Node 24.0.0 at /opt/homebrew/bin/node`,
  );
});

/**
 * Catches a doctor whose poll names no copy, or another, which the plane
 * records as what the runner runs.
 */
test("doctor's poll of the plane names this copy", async (t) => {
  /** @type {(string | null)[]} */
  const named = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (/** @type {string} */ _url, /** @type {RequestInit} */ init) => {
      named.push(new globalThis.Headers(init.headers).get(workerRunnerHeader));
      return globalThis.Response.json({
        assignments: [],
        sessions: [],
        stop: [],
      });
    },
  );
  const { home, poolFile } = await runnerFixture(t);
  const { out } = await called(["doctor", "--pool", poolFile], {
    home,
    tokens: {
      acquire: async () => ({ acquired: "Token", token: "pool-token" }),
      invalidate: () => undefined,
    },
  });
  assert.match(out, /^ok {4}plane: .* answered a poll$/mu);
  assert.deepEqual(named, [`chuggy-darwin/${copyVersion}`]);
});

test("doctor names a pool's file as a pool's, by its tenant, project and pool", async (t) => {
  const { home: machine } = await runnerFixture(t);
  const { fetch } = answeringFetch(201, registered);
  assert.equal(
    (await called(registerArgv, { home: machine, fetch })).status,
    0,
  );
  const file = join(
    machine,
    ".config",
    "chuggy",
    "pools",
    "newtenant.arbbot.shame.json",
  );
  const { out } = await called(["doctor", "--pool", file], { home: machine });
  assert.match(
    out,
    new RegExp(
      `^ok {4}pool file: ${file.replaceAll(".", "\\.")} names pool newtenant/arbbot/shame$`,
      "mu",
    ),
  );
});

test("doctor names a personal runner's file as one, by its tenant and member", async (t) => {
  const { home: machine } = await runnerFixture(t);
  const { fetch } = answeringFetch(201, registeredPersonal);
  assert.equal(
    (await called([...registerArgv, "--personal"], { home: machine, fetch }))
      .status,
    0,
  );
  const file = join(
    machine,
    ".config",
    "chuggy",
    "pools",
    `${personalBase}.json`,
  );
  const { out } = await called(["doctor", "--pool", file], { home: machine });
  assert.match(
    out,
    new RegExp(
      `^ok {4}pool file: ${file.replaceAll(".", "\\.")} names personal runner newtenant/28:https:%2F%2Fauth\\.chuggy\\.example%2F0f3c9a52-member$`,
      "mu",
    ),
  );
});

test("the platform registered is docker's VM's, so an x86_64 VM registers amd64 Linux whatever the Mac is", async (t) => {
  const { fetch, requests } = answeringFetch(201, registeredFixture);
  await called(registerArgv, {
    home: await home(t),
    architecture: "x86_64",
    fetch,
  });
  assert.deepEqual(JSON.parse(String(requests[0].init.body)).capabilities, [
    "Platform:Linux:Amd64",
  ]);
});

test("register --host declares the Mac's own platform after the VM's and writes host into the pool file, and each --capability after both", async (t) => {
  const declared = {
    ...registered,
    capabilities: [
      "Platform:Linux:Arm64",
      "Platform:MacOS:Arm64",
      "Agent:Claude",
      "Tool:Xcode",
    ],
  };
  const { fetch, requests } = answeringFetch(201, declared);
  const machine = await home(t);
  const { status, err } = await called(
    [
      ...registerArgv,
      "--host",
      "--capability",
      "Agent:Claude",
      "--capability",
      "Tool:Xcode",
    ],
    { home: machine, fetch },
  );
  assert.equal(status, 0, err);
  assert.deepEqual(
    JSON.parse(String(requests[0].init.body)).capabilities,
    declared.capabilities,
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(
          machine,
          ".config",
          "chuggy",
          "pools",
          "newtenant.arbbot.shame.json",
        ),
        "utf8",
      ),
    ),
    { ...declared, host: true },
  );
});

test("register declares the agents runner.json can run, Claude, and Codex where it names codexCredential, each where an images entry declares it or with --host, once beside a --capability naming it", async (t) => {
  const vm = "Platform:Linux:Arm64";
  const claude = { images: [{ image: "x", capabilities: ["Agent:Claude"] }] };
  const codexCredential = { authFile: "/Users/you/.codex/auth.json" };
  const codexImages = [{ image: "x", capabilities: ["Agent:Codex"] }];
  for (const [runner, argv, declared] of /** @type {const} */ ([
    [claude, [], [vm, "Agent:Claude"]],
    [claude, ["--capability", "Agent:Claude"], [vm, "Agent:Claude"]],
    [{}, ["--host"], [vm, "Platform:MacOS:Arm64", "Agent:Claude"]],
    [{}, [], [vm]],
    [{ codexCredential, images: codexImages }, [], [vm, "Agent:Codex"]],
    [{ images: codexImages }, [], [vm]],
    [
      { codexCredential },
      ["--host"],
      [vm, "Platform:MacOS:Arm64", "Agent:Claude", "Agent:Codex"],
    ],
  ])) {
    const answer = answeringFetch(201, {
      ...registered,
      capabilities: declared,
    });
    const { status, err } = await called([...registerArgv, ...argv], {
      home: await home(t, { runner }),
      fetch: answer.fetch,
    });
    assert.equal(status, 0, err);
    assert.deepEqual(
      JSON.parse(String(answer.requests[0].init.body)).capabilities,
      declared,
    );
    assert.equal(err, "");
  }
});

test("register with no runner.json declares the VM's platform and each --capability, says in one line that runner.json declared no agents, and goes on", async (t) => {
  const declared = ["Platform:Linux:Arm64", "Tool:Xcode"];
  const answer = answeringFetch(201, { ...registered, capabilities: declared });
  const { status, out, err } = await called(
    [...registerArgv, "--capability", "Tool:Xcode"],
    { home: await home(t, { runner: undefined }), fetch: answer.fetch },
  );
  assert.equal(status, 0, err);
  assert.deepEqual(
    JSON.parse(String(answer.requests[0].init.body)).capabilities,
    declared,
  );
  assert.match(out, /^wrote .*newtenant\.arbbot\.shame\.json;/u);
  assert.equal(err.split("\n").length, 1);
  assert.match(
    err,
    /^runner\.json declared no agents, since it could not be read: ENOENT/u,
  );
});

test("register spends no token while docker cannot be asked", async (t) => {
  const machine = await home(t);
  const { fetch, requests } = answeringFetch(201, registered);
  const { engine, state } = fakeEngine();
  state.unreachable = true;
  const { status, err } = await called(registerArgv, {
    home: machine,
    engine,
    fetch,
  });
  assert.equal(status, 1);
  assert.match(err, /^docker could not be asked: Cannot connect/u);
  assert.deepEqual(requests, []);
});

test("register asked wrongly exits 2 before the token is spent", async (t) => {
  const machine = await home(t);
  const { fetch, requests } = answeringFetch(201, registered);
  for (const [argv, architecture, line, arch] of [
    [registerArgv, "riscv64", /^this machine is riscv64/u],
    [
      [...registerArgv, "--pool", "Shame"],
      "aarch64",
      /^--pool Shame is not a pool name/u,
    ],
    [
      [...registerArgv, "--personal", "--pool", "shame"],
      "aarch64",
      /^--pool names a pool, and a personal runner names none/u,
    ],
    [
      ["register", "--api", "https://chuggy.example"],
      "aarch64",
      /^register needs --api and --token$/u,
    ],
    [
      [...registerArgv, "--capability", "Platform:MacOS:Arm64"],
      "aarch64",
      /^--capability Platform:MacOS:Arm64 names a platform, which register finds/u,
    ],
    [
      [...registerArgv, "--host"],
      "aarch64",
      /^this Mac is ia32, and no pool runs work on the host of one$/u,
      "ia32",
    ],
  ]) {
    const { status, err } = await called(/** @type {string[]} */ (argv), {
      home: machine,
      architecture: /** @type {string} */ (architecture),
      ...(arch === undefined ? {} : { arch: /** @type {string} */ (arch) }),
      fetch,
    });
    assert.equal(status, 2, String(argv));
    assert.match(err, /** @type {RegExp} */ (line), String(argv));
  }
  assert.deepEqual(requests, []);
  await assert.rejects(stat(join(machine, ".config")), { code: "ENOENT" });
});

test("a wrong ask is refused as asked wrongly even while docker cannot be asked", async (t) => {
  const { fetch, requests } = answeringFetch(201, registered);
  const { engine, state } = fakeEngine();
  state.unreachable = true;
  for (const [argv, line] of [
    [
      ["register", "--api", "https://chuggy.example"],
      /^register needs --api and --token$/u,
    ],
    [[...registerArgv, "--pool", "Bad"], /^--pool Bad is not a pool name/u],
  ]) {
    const { status, err } = await called(/** @type {string[]} */ (argv), {
      home: await home(t),
      engine,
      fetch,
    });
    assert.equal(status, 2, String(argv));
    assert.match(err, /** @type {RegExp} */ (line));
  }
  assert.deepEqual(state.calls, []);
  assert.deepEqual(requests, []);
});

test("register writes nothing when chuggy refuses the token, and exits 1 with why", async (t) => {
  const machine = await home(t);
  const { status, out, err } = await called(registerArgv, {
    home: machine,
    fetch: answeringFetch(404, { error: { code: "NotFound" } }).fetch,
  });
  assert.equal(status, 1);
  assert.equal(out, "");
  assert.equal(
    err,
    "the registration token is unknown, spent or expired; mint another in chuggy's console",
  );
  assert.deepEqual(
    await readdir(join(machine, ".config", "chuggy", "pools")),
    [],
  );
});

test("register says the token is spent where chuggy answered but the pool file could not be written", async (t) => {
  const machine = await home(t);
  await mkdir(
    join(
      machine,
      ".config",
      "chuggy",
      "pools",
      "newtenant.arbbot.shame.json",
      "blocking",
    ),
    { recursive: true },
  );
  const { status, out, err } = await called(registerArgv, {
    home: machine,
    fetch: answeringFetch(201, registered).fetch,
  });
  assert.equal(status, 1);
  assert.equal(out, "");
  assert.match(
    err,
    /^the pool file could not be written, and the token is spent, so mint another: E/u,
  );
});

test("register spends no token where it could not write the pool file", async (t) => {
  const machine = await home(t);
  await mkdir(join(machine, ".config"));
  await writeFile(join(machine, ".config", "chuggy"), "");
  const { fetch, requests } = answeringFetch(201, registered);
  const { status, err } = await called(registerArgv, {
    home: machine,
    fetch,
  });
  assert.equal(status, 1);
  assert.match(
    err,
    /cannot be made a directory only you can write, so no token was spent: E(NOTDIR|EXIST)/u,
  );
  assert.deepEqual(requests, []);
});

test("a token beginning with a dash is taken as --token=<token>, as usage says, and the space form keeps working for one that does not", async (t) => {
  const machine = await home(t);
  const dashed = `-${"a".repeat(42)}`;
  for (const [argv, token] of [
    [
      ["register", "--api", "https://chuggy.example", `--token=${dashed}`],
      dashed,
    ],
    [["register", "--api", "https://chuggy.example", "--token", "t-1"], "t-1"],
  ]) {
    const { fetch, requests } = answeringFetch(201, registered);
    const { status, err } = await called(/** @type {string[]} */ (argv), {
      home: machine,
      fetch,
    });
    assert.equal(status, 0, err);
    assert.equal(JSON.parse(String(requests[0].init.body)).token, token);
  }
  const { fetch, requests } = answeringFetch(201, registered);
  const spaced = await called(
    ["register", "--api", "https://chuggy.example", "--token", dashed],
    { home: machine, fetch },
  );
  assert.equal(spaced.status, 2);
  assert.match(spaced.err, /--token=-XYZ/u);
  assert.deepEqual(requests, []);
  assert.match(
    (await called(["help"])).out,
    /^ +chuggy-darwin register --api <origin> --token=<token> \[--pool <name> \| --personal\]$/mu,
  );
});

test("a command needs a pool file, named by --pool or CHUGGY_DARWIN_POOL", async () => {
  const { status, err } = await called(["status"]);
  assert.equal(status, 2);
  assert.match(
    err,
    /^no pool file: name one with --pool or CHUGGY_DARWIN_POOL/u,
  );
});

test("a run the plane denies is done, making the job network and leaving no socket behind", async (t) => {
  const { home, paths } = await runnerFixture(t);
  const { engine, state } = fakeEngine();
  const runtime = poolRuntimeDirectory(paths, fixturePool);
  const { status, out, err } = await called(["run"], {
    home,
    environment: {
      CHUGGY_DARWIN_POOL: join(paths.pools, "vteng.chuggy.shame.json"),
    },
    engine,
  });
  assert.equal(status, 0, err);
  assert.equal(
    out,
    [
      "made the job network chuggy-jobs",
      "the plane denied this pool: the pool was revoked",
    ].join("\n"),
  );
  assert.ok(state.networks.has("chuggy-jobs"));
  assert.deepEqual(await readdir(runtime), []);
  assert.equal((await stat(runtime)).mode & 0o777, 0o700);
});

test("once the plane denies fails with why, and is refused while this pool's service runs", async (t) => {
  const { home, poolFile, paths } = await runnerFixture(t);
  const passed = await called(["once", "--pool", poolFile], { home });
  assert.equal(passed.status, 1);
  assert.equal(passed.err, "Denied: the pool was revoked");
  await controlServed(
    t,
    controlSocketPath(poolRuntimeDirectory(paths, fixturePool)),
  );
  const refused = await called(["once", "--pool", poolFile], { home });
  assert.equal(refused.status, 1);
  assert.equal(
    refused.err,
    "a chuggy-darwin service is running this pool; stop it before a pass of your own",
  );
});

test("status and stop reach this pool's service, and status names each workload's kind and the runner's limits", async (t) => {
  const { home, poolFile, paths } = await runnerFixture(t, {
    runner: { concurrencyMax: 3, sessionsMax: 4 },
  });
  const { stopped } = await controlServed(
    t,
    controlSocketPath(poolRuntimeDirectory(paths, fixturePool)),
  );
  const { engine, state } = fakeEngine();
  state.containers.set("chuggy-shame-a", {
    id: "id-a",
    name: "chuggy-shame-a",
    status: "running",
    image: "i",
    labels: {
      "io.chuggy.pool": "vteng/chuggy/shame",
      "io.chuggy.deadline": "1800000000",
      "io.chuggy.assignment": "asg-2",
      "io.chuggy.kind": "Job",
    },
  });
  const status = await called(["status", "--pool", poolFile], {
    home,
    engine,
  });
  assert.equal(
    status.out,
    [
      "service: running",
      "limits: concurrencyMax 3, sessionsMax 4",
      "disk floor: 90 GiB free at /var/lib/docker in Colima's VM, over the floor of 20 GiB",
      "memory: 2 GiB room · 2 GiB budget · 2 GiB ceiling · 0 GiB sessions · Taking",
      `${inFlightFixture.name}  session  pulling  i  asg-1`,
      "chuggy-shame-a  job  running  deadline 2027-01-15T08:00:00.000Z  asg-2",
    ].join("\n"),
  );
  const stop = await called(["stop", "asg-1", "--pool", poolFile], { home });
  assert.equal(stop.status, 0);
  assert.equal(stop.out, "stopped asg-1");
  assert.deepEqual(stopped, ["asg-1"]);
});

/**
 * Catches `status` or `stop` finding what a run advertises, which neither
 * names, and refused where a run would be.
 */
test("status and stop answer on a VM no pool runs on, since neither polls", async (t) => {
  const { home, poolFile, paths } = await runnerFixture(t);
  const { stopped } = await controlServed(
    t,
    controlSocketPath(poolRuntimeDirectory(paths, fixturePool)),
  );
  const machine = { home, architecture: "riscv64" };
  const status = await called(["status", "--pool", poolFile], machine);
  assert.equal(status.status, 0, status.err);
  assert.match(status.out, /^service: running$/mu);
  const stop = await called(["stop", "asg-1", "--pool", poolFile], machine);
  assert.equal(stop.status, 0, stop.err);
  assert.deepEqual(stopped, ["asg-1"]);
  const once = await called(["once", "--pool", poolFile], machine);
  assert.equal(once.status, 1);
  assert.match(once.err, /docker's VM is riscv64, which no pool runs/u);
});

test("status names a job held for room and what it waits for, and the memory of Colima's VM it waits on", async (t) => {
  const { home, poolFile, paths } = await runnerFixture(t);
  await controlServed(
    t,
    controlSocketPath(poolRuntimeDirectory(paths, fixturePool)),
    [
      {
        ...inFlightFixture,
        kind: "Job",
        phase: "Held",
        memoryMib: 4096,
        waiting: "needs 4 GiB, room 2 GiB",
      },
    ],
  );
  const { engine, state } = fakeEngine();
  state.machine = { ...state.machine, memoryBytes: 8 * 2 ** 30 };
  state.containers.set("chuggy-jobs-postgres", {
    id: "id-postgres",
    name: "chuggy-jobs-postgres",
    labels: {},
    status: "running",
    image: "postgres",
    usedBytes: 2 * 2 ** 30,
  });
  await engine.exec(
    heldCreateArgv({
      name: `${inFlightFixture.name}-held`,
      pool: "vteng/chuggy/shame",
      assignment: inFlightFixture.assignment,
      memoryMib: 4096,
      heldMs: 1,
      pid: process.pid,
      untilMs: Date.now() + 3_600_000,
      starting: false,
    }),
  );
  const status = await called(["status", "--pool", poolFile], {
    home,
    engine,
  });
  assert.deepEqual(status.out.split("\n").slice(3), [
    "memory: 2 GiB room · 8 GiB budget · 8 GiB ceiling · 0 GiB sessions · Held",
    `${inFlightFixture.name}  job  held  i  asg-1  waiting: needs 4 GiB, room 2 GiB`,
  ]);
});

test("status names the limits this pool's entry in pools sets its service", async (t) => {
  const { home, poolFile } = await runnerFixture(t, {
    runner: {
      concurrencyMax: 2,
      pools: {
        "vteng.chuggy.shame": { concurrencyMax: 0, sessionsMax: 1 },
        other: { concurrencyMax: 5 },
      },
    },
  });
  const status = await called(["status", "--pool", poolFile], { home });
  assert.deepEqual(status.out.split("\n").slice(0, 2), [
    "service: not running",
    "limits: concurrencyMax 0, sessionsMax 1, as pools.vteng.chuggy.shame sets them",
  ]);
});

/**
 * Catches a run that names no copy, or another, on its polls, or one that
 * ignores the release a poll names, or takes it where the runner's file
 * turns updates off.
 */
test("a run names its copy on each poll, and takes the release chuggy names unless the runner's file turns updates off", async (t) => {
  const release = {
    package: "chuggy-darwin",
    version: "9.8.8",
    url: "https://github.com/kasofsk/chuggy-darwin/releases/download/v9.8.8/chuggy-darwin-9.8.8.tgz",
    integrity: `sha512-${"A".repeat(86)}==`,
  };
  /** @type {(string | null)[]} */
  const named = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
      if (String(url) !== release.url)
        named.push(
          new globalThis.Headers(init.headers).get(workerRunnerHeader),
        );
      return globalThis.Response.json({
        assignments: [],
        sessions: [],
        stop: [],
        release,
      });
    },
  );
  for (const [runner, said] of [
    [
      {},
      "did not update to chuggy-darwin 9.8.8: this runner is installed at /opt/chuggy-darwin, which is not where npm installs a package globally",
    ],
    [
      { autoUpdate: false },
      "chuggy-darwin 9.8.8 is out, and this runner, 9.8.7, does not update itself",
    ],
  ]) {
    const { home, poolFile } = await runnerFixture(t, { runner });
    let acquired = 0;
    const { status, out } = await called(["run", "--pool", poolFile], {
      home,
      tokens: {
        acquire: async () =>
          (acquired += 1) <= 2
            ? { acquired: "Token", token: "pool-token" }
            : deniedTokens.acquire(),
        invalidate: () => undefined,
      },
    });
    assert.equal(status, 0, out);
    assert.ok(
      out.split("\n").some((line) => line.startsWith(said)),
      out,
    );
  }
  assert.ok(named.length > 0);
  assert.deepEqual(new Set(named), new Set(["chuggy-darwin/9.8.7"]));
});

/**
 * A copy at `copyVersion` installed where `npm install --global` puts one,
 * and what an update of it reaches, under which a release installs: its
 * download is the bytes its integrity names, `tar` unpacks a manifest naming
 * it, its bin answers its version, and npm writes that version over the
 * installed copy's.
 *
 * @param {import("node:test").TestContext} t
 */
async function installingCopy(t) {
  const prefix = await mkdtemp(join(tmpdir(), "chuggy-darwin-prefix-"));
  t.after(() => rm(prefix, { recursive: true, force: true }));
  const installed = join(prefix, "lib", "node_modules", "chuggy-darwin");
  await mkdir(join(prefix, "bin"), { recursive: true });
  /** @param {string} version */
  const manifest = (version) =>
    JSON.stringify({
      name: "chuggy-darwin",
      version,
      bin: { "chuggy-darwin": "cli.mjs" },
    });
  await mkdir(installed, { recursive: true });
  await writeFile(join(installed, "package.json"), manifest(copyVersion));
  const bytes = Buffer.from("chuggy-darwin 9.8.8 tarball");
  const release = {
    package: "chuggy-darwin",
    version: "9.8.8",
    url: `${runnerReleasePrefix}v9.8.8/chuggy-darwin-9.8.8.tgz`,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
  /** @type {import("@chuggy/worker-core/runnerUpdate.mjs").RunnerUpdateRun} */
  const run = async (file, args) => {
    if (file === "tar") {
      const root = join(args[3], "package");
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "package.json"), manifest(release.version));
    } else if (file === "npm")
      await writeFile(
        join(installed, "package.json"),
        manifest(release.version),
      );
    return {
      code: 0,
      stdout: file === "/node" ? `chuggy-darwin ${release.version}\n` : "",
      stderr: "",
    };
  };
  return {
    cli: join(installed, "cli.mjs"),
    release,
    ports: {
      fetch: async () => new globalThis.Response(bytes),
      run,
      execPath: "/node",
      executable: async () => false,
      temporary: prefix,
    },
  };
}

/** The passes a run that installs a release may make before its pool is denied, which ends one that never installs it. */
const passesMax = 500;

/**
 * Catches a run that installed a release ending as a denied one does, which
 * its agent would not restart, or one launchd started told to be started by
 * hand, or one started by hand told launchd restarts it.
 */
test("a run that installs the release chuggy names ends with the status its agent restarts after, saying who starts it again", async (t) => {
  for (const [agent, said] of [
    [true, "ending, for launchd to restart this run on chuggy-darwin 9.8.8"],
    [false, "ending: start this run again to run chuggy-darwin 9.8.8"],
  ]) {
    const { cli, release, ports } = await installingCopy(t);
    t.mock.method(globalThis, "fetch", async () => {
      await delay(10);
      return globalThis.Response.json({
        assignments: [],
        sessions: [],
        stop: [],
        release,
      });
    });
    const { home, poolFile } = await runnerFixture(t);
    let acquired = 0;
    const { status, out } = await called(["run", "--pool", poolFile], {
      home,
      cli,
      updatePorts: ports,
      environment: agent
        ? { XPC_SERVICE_NAME: launchAgentLabel(poolFile) }
        : {},
      tokens: {
        acquire: async () =>
          (acquired += 1) <= passesMax
            ? { acquired: "Token", token: "pool-token" }
            : deniedTokens.acquire(),
        invalidate: () => undefined,
      },
    });
    assert.equal(status, updatedExitStatus, out);
    assert.equal(out.split("\n").at(-1), said);
    t.mock.restoreAll();
  }
});

test("--version names this copy, whatever else is asked, and usage names it", async () => {
  for (const argv of [["--version"], ["doctor", "--version"]]) {
    const { status, out, err } = await called(argv);
    assert.equal(status, 0, argv.join(" "));
    assert.equal(out, `chuggy-darwin ${copyVersion}`);
    assert.equal(err, "");
  }
  assert.match((await called(["help"])).out, /^ {7}chuggy-darwin --version$/mu);
});

test("a second run of a pool is refused before it removes anything of the first's", async (t) => {
  const { home, poolFile, paths } = await runnerFixture(t);
  const runtime = poolRuntimeDirectory(paths, fixturePool);
  await controlServed(t, controlSocketPath(runtime));
  await mkdir(join(runtime, "pull-1-inflight"));
  const { status, err } = await called(["run", "--pool", poolFile], { home });
  assert.equal(status, 1);
  assert.match(err, /^a runner's service already answers at /u);
  assert.deepEqual((await readdir(runtime)).sort(), [
    "control.sock",
    "pull-1-inflight",
  ]);
});

/**
 * A PATH with executables of these names on it, as Homebrew links them, and
 * the directory they are in.
 *
 * @param {import("node:test").TestContext} t
 * @param {readonly string[]} names
 */
async function binPath(t, names = ["docker", "node"]) {
  const bin = await mkdtemp(join(tmpdir(), "chuggy-darwin-bin-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  for (const name of names) {
    await writeFile(join(bin, name), "#!/bin/sh\n");
    await chmod(join(bin, name), 0o755);
  }
  return { bin, PATH: `/nonexistent:${bin}` };
}

/** @param {import("node:test").TestContext} t */
async function dockerPath(t) {
  return (await binPath(t)).PATH;
}

test("install-agent writes the pool file's own agent, which runs this CLI under the node this PATH finds, on this PATH, and prints how to start it", async (t) => {
  const { home, poolFile, paths } = await runnerFixture(t);
  const { bin, PATH } = await binPath(t);
  const { status, out, err } = await called(
    ["install-agent", "--pool", poolFile],
    { home, environment: { PATH } },
  );
  assert.equal(status, 0, err);
  const label = "chuggy-darwin.vteng.chuggy.shame";
  const plist = join(paths.agents, `${label}.plist`);
  const uid = String(process.getuid?.());
  assert.equal(
    out,
    [
      `wrote ${plist}; start it, and Colima at login, with:`,
      `  launchctl bootout gui/${uid}/${label} 2>/dev/null`,
      `  launchctl bootstrap gui/${uid} ${plist}`,
      "  brew services start colima",
    ].join("\n"),
  );
  const text = await readFile(plist, "utf8");
  for (const line of [
    `<string>${label}</string>`,
    `<string>${join(bin, "node")}</string>`,
    "<string>/opt/chuggy-darwin/cli.mjs</string>",
    `<string>${poolFile}</string>`,
    `<string>${PATH}</string>`,
    `<string>${join(paths.logs, `${label}.log`)}</string>`,
  ])
    assert.ok(text.includes(line), line);
  assert.ok(!text.includes("LimitLoadToSessionType"));
  assert.equal((await stat(paths.logs)).mode & 0o777, 0o700);
  const again = await called(["install-agent", "--pool", poolFile], {
    home,
    environment: { PATH },
  });
  assert.equal(again.status, 0, again.err);
});

test("install-agent refuses a PATH without docker or node, and writes nothing for a pool file it cannot read", async (t) => {
  const { home, poolFile, paths } = await runnerFixture(t);
  for (const [names, line] of /** @type {const} */ ([
    [["node"], /^docker is not on this shell's PATH/u],
    [["docker"], /^node is not on this shell's PATH/u],
  ])) {
    const { PATH } = await binPath(t, names);
    const refused = await called(["install-agent", "--pool", poolFile], {
      home,
      environment: { PATH },
    });
    assert.equal(refused.status, 1);
    assert.match(refused.err, line);
  }
  const unread = await called(
    ["install-agent", "--pool", join(home, "absent.json")],
    { home, environment: { PATH: await dockerPath(t) } },
  );
  assert.equal(unread.status, 1);
  await assert.rejects(stat(paths.agents), { code: "ENOENT" });
});

test("install-agent refuses an agent of the pool file's name serving another file, or none it wrote", async (t) => {
  const { home, poolFile, paths } = await runnerFixture(t);
  const PATH = await dockerPath(t);
  const other = join(home, "elsewhere", "vteng.chuggy.shame.json");
  await mkdir(dirname(other), { recursive: true });
  await writeFile(other, await readFile(poolFile, "utf8"), { mode: 0o600 });
  const installed = await called(["install-agent", "--pool", other], {
    home,
    environment: { PATH },
  });
  assert.equal(installed.status, 0, installed.err);
  const plist = join(paths.agents, "chuggy-darwin.vteng.chuggy.shame.plist");
  const before = await readFile(plist, "utf8");
  const serving = await called(["install-agent", "--pool", poolFile], {
    home,
    environment: { PATH },
  });
  assert.equal(serving.status, 1);
  assert.equal(
    serving.err,
    `${plist} serves ${other}, not ${poolFile}; remove that agent if it is stale, or rename the pool file`,
  );
  assert.equal(await readFile(plist, "utf8"), before);
  await writeFile(plist, "<plist/>");
  const refused = await called(["install-agent", "--pool", poolFile], {
    home,
    environment: { PATH },
  });
  assert.equal(refused.status, 1);
  assert.equal(
    refused.err,
    `${plist} serves no pool file this runner named, not ${poolFile}; remove that agent if it is stale, or rename the pool file`,
  );
  assert.equal(await readFile(plist, "utf8"), "<plist/>");
});

test("registering a pool its agent here runs says the agent stops until restarted, and how", async (t) => {
  const machine = await home(t);
  const { fetch } = answeringFetch(201, registered);
  const PATH = await dockerPath(t);
  const first = await called(registerArgv, { home: machine, fetch });
  const file = join(
    machine,
    ".config",
    "chuggy",
    "pools",
    "newtenant.arbbot.shame.json",
  );
  assert.equal(first.status, 0, first.err);
  const installed = await called(["install-agent", "--pool", file], {
    home: machine,
    environment: { PATH },
  });
  assert.equal(installed.status, 0, installed.err);
  const again = await called(registerArgv, { home: machine, fetch });
  assert.equal(
    again.out,
    [
      `replaced ${file}; chuggy denies the pool's earlier registration, so its agent stops until it is restarted:`,
      `  launchctl kickstart -k gui/${String(process.getuid?.())}/chuggy-darwin.newtenant.arbbot.shame`,
    ].join("\n"),
  );
});

/**
 * Catches an agent written for a desktop session nobody is logged in to,
 * which launchd refuses to load, or loaded into the background session but
 * restarted in the desktop session's domain, which has no such agent.
 */
test("where nobody is logged in at the Mac's screen, install-agent writes the background session's agent and loads it into launchd's user domain, where registering again restarts it", async (t) => {
  const machine = await home(t);
  const { fetch } = answeringFetch(201, registered);
  const PATH = await dockerPath(t);
  assert.equal(
    (await called(registerArgv, { home: machine, fetch })).status,
    0,
  );
  const file = join(
    machine,
    ".config",
    "chuggy",
    "pools",
    "newtenant.arbbot.shame.json",
  );
  const label = "chuggy-darwin.newtenant.arbbot.shame";
  const plist = join(machine, "Library", "LaunchAgents", `${label}.plist`);
  const uid = String(process.getuid?.());
  const installed = await called(["install-agent", "--pool", file], {
    home: machine,
    environment: { PATH },
    desktop: false,
  });
  assert.equal(installed.status, 0, installed.err);
  assert.equal(
    installed.out,
    [
      `wrote ${plist} for your background session, since you are not logged in at this Mac's screen; start it with:`,
      `  launchctl bootout user/${uid}/${label} 2>/dev/null`,
      `  launchctl bootstrap user/${uid} ${plist}`,
    ].join("\n"),
  );
  assert.match(
    await readFile(plist, "utf8"),
    /<key>LimitLoadToSessionType<\/key>\s*<string>Background<\/string>/u,
  );
  const again = await called(registerArgv, { home: machine, fetch });
  assert.equal(
    again.out.split("\n")[1],
    `  launchctl kickstart -k user/${uid}/${label}`,
  );
});

test("registering a personal runner its agent here runs says the agent runs the earlier registration, and restarts the agent labelled for its file", async (t) => {
  const machine = await home(t);
  const argv = [...registerArgv, "--personal"];
  const { fetch } = answeringFetch(201, registeredPersonal);
  const PATH = await dockerPath(t);
  const file = join(
    machine,
    ".config",
    "chuggy",
    "pools",
    `${personalBase}.json`,
  );
  assert.equal((await called(argv, { home: machine, fetch })).status, 0);
  const installed = await called(["install-agent", "--pool", file], {
    home: machine,
    environment: { PATH },
  });
  assert.equal(installed.status, 0, installed.err);
  assert.equal(
    installed.out.split("\n")[0],
    `wrote ${join(machine, "Library", "LaunchAgents", `chuggy-darwin.${personalBase}.plist`)}; start it, and Colima at login, with:`,
  );
  const again = await called(argv, { home: machine, fetch });
  assert.equal(
    again.out,
    [
      `replaced ${file}; its agent runs the registration it read when it started until it is restarted:`,
      `  launchctl kickstart -k gui/${String(process.getuid?.())}/chuggy-darwin.${personalBase}`,
    ].join("\n"),
  );
});

test("doctor exits 1 on a failed check, printing every check it made", async (t) => {
  const { home, poolFile } = await runnerFixture(t);
  const { status, out, err } = await called(["doctor", "--pool", poolFile], {
    home,
  });
  assert.equal(status, 1);
  assert.match(out, /^ok {4}pool file: /mu);
  assert.match(
    out,
    /^ok {4}docker: at unix:\/\/\/Users\/shame\/\.colima\/default\/docker\.sock, its VM arm64 with 2 CPUs and 2048 MiB, listing 0 of this pool's containers$/mu,
  );
  assert.match(
    out,
    /^ok {4}capabilities: a run advertises Platform:Linux:Arm64, Platform:Linux:Amd64 on each poll: /mu,
  );
  assert.match(err, /^warn {2}launchd agent: none; install-agent writes /mu);
  assert.match(err, /^FAIL {2}pool token: the pool was revoked$/mu);
});

test("doctor on a pool registered with --host names the claude a job there runs and the version it says, on the PATH its agent was given ahead of doctor's own", async (t) => {
  const { home, poolFile } = await runnerFixture(t, {
    pool: { ...fixturePool, host: true },
  });
  const agent = await binPath(t);
  const shell = await binPath(t, []);
  for (const [{ bin }, version] of [
    [agent, "2.1.282 (Claude Code)"],
    [shell, "1.0.0 (Claude Code)"],
  ])
    await writeFile(join(bin, "claude"), `#!/bin/sh\necho '${version}'\n`, {
      mode: 0o700,
    });
  /** @param {string} PATH */
  const said = async (PATH) => {
    const { out, err } = await called(["doctor", "--pool", poolFile], {
      home,
      environment: { PATH },
    });
    return `${out}\n${err}`
      .split("\n")
      .find((line) => line.includes(" Claude credential: "));
  };
  const runs = (
    /** @type {string} */ bin,
    /** @type {string} */ version,
    /** @type {string} */ whose,
  ) =>
    `; a job on the Mac itself runs ${join(bin, "claude")}, ${version} (Claude Code), found on ${whose}`;
  const unserved = await said(shell.bin);
  assert.ok(unserved?.startsWith("ok    "), unserved);
  assert.ok(unserved?.endsWith(runs(shell.bin, "1.0.0", "doctor's own PATH")));
  const installed = await called(["install-agent", "--pool", poolFile], {
    home,
    environment: { PATH: agent.PATH },
  });
  assert.equal(installed.status, 0, installed.err);
  const served = await said(shell.bin);
  assert.ok(
    served?.endsWith(
      runs(
        agent.bin,
        "2.1.282",
        "the PATH the launchd agent runs the runner with",
      ),
    ),
    served,
  );
});

test("install-agent writes an absolute node and PATH for a PATH entry relative to where it ran, since launchd runs the agent from /", async (t) => {
  const { home, poolFile, paths } = await runnerFixture(t);
  const { bin } = await binPath(t);
  const installed = await called(["install-agent", "--pool", poolFile], {
    home,
    environment: { PATH: relative(process.cwd(), bin) },
  });
  assert.equal(installed.status, 0, installed.err);
  const plist = await readFile(
    join(paths.agents, "chuggy-darwin.vteng.chuggy.shame.plist"),
    "utf8",
  );
  assert.ok(plist.includes(`<string>${join(bin, "node")}</string>`), plist);
  assert.match(
    plist,
    new RegExp(`<key>PATH</key>\\s*<string>${bin}</string>`, "u"),
  );
});
