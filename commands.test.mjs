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

import { controlSocketPath } from "@chuggy/worker-core/control.mjs";

import { cliMain } from "./commands.mjs";
import { controlServed, inFlightFixture } from "./control.fixture.mjs";
import { fakeEngine } from "./engine.fixture.mjs";
import {
  answeringFetch,
  registeredFixture,
  registeredPersonalFixture,
} from "./register.fixture.mjs";
import { poolRuntimeDirectory } from "./runner.mjs";
import { fixturePool, runnerFixture } from "./runner.fixture.mjs";

/**
 * @typedef {object} Machine
 * @property {Record<string, string>} [environment]
 * @property {string} [home]
 * @property {string} [hostname]
 * @property {string} [architecture] the docker VM's, as `docker info` names it
 * @property {string} [arch] the Mac's own, as `process.arch` names it
 * @property {typeof globalThis.fetch} [fetch]
 * @property {import("@chuggy/worker-core/engine.mjs").Engine} [engine]
 */

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
    tokens: deniedTokens,
    cli: "/opt/chuggy-darwin/cli.mjs",
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { status, out: out.join("\n"), err: err.join("\n") };
}

/** @param {import("node:test").TestContext} t */
async function home(t) {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-darwin-home-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
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
      /^--pool names a pool, and a personal runner is its member's one in the tenant/u,
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
      `${inFlightFixture.name}  session  pulling  i  asg-1`,
      "chuggy-shame-a  job  running  deadline 2027-01-15T08:00:00.000Z  asg-2",
    ].join("\n"),
  );
  const stop = await called(["stop", "asg-1", "--pool", poolFile], { home });
  assert.equal(stop.status, 0);
  assert.equal(stop.out, "stopped asg-1");
  assert.deepEqual(stopped, ["asg-1"]);
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

test("registering a personal runner its agent here runs says so of the runner, and restarts the agent labelled for its file", async (t) => {
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
      `replaced ${file}; chuggy denies this personal runner's earlier registration, so its agent stops until it is restarted:`,
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
    /^ok {4}platform: docker's VM runs Platform:Linux:Arm64, as the pool registered$/mu,
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
