import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { registerRequest } from "@chuggy/worker-core/register.mjs";

import { doctorFindings, findingLine } from "./doctor.mjs";
import { fakeColima, fakeEngine } from "./engine.fixture.mjs";
import {
  launchAgentFileName,
  launchAgentLabel,
  launchAgentPlist,
} from "./launchAgent.mjs";
import { runnerUpdates, vmPlatform } from "./runner.mjs";
import { fixturePool, ownerOnly, runnerFixture } from "./runner.fixture.mjs";

const ownUid = process.getuid?.() ?? -1;

/**
 * @typedef {Awaited<ReturnType<typeof runnerFixture>>} MacFixture
 *
 * @typedef {object} DoctorSeen what doctor is run with besides the files
 * @property {string} [path] its own PATH
 * @property {Record<string, string>} [agentVersions] what each `claude` says its version is
 * @property {string} [installed] the directory the copy is installed in, where not Homebrew's global one
 * @property {(path: string) => Promise<boolean>} [writable] whether an update could write a path, where not every one
 */

/** Homebrew's npm prefix, under which a global install puts this package. */
const homebrewPrefix = "/opt/homebrew";

/** The copy doctor is run as, installed where `npm install --global` puts it. */
const copy = {
  package: "chuggy-darwin",
  version: "9.8.7",
  cli: join(homebrewPrefix, "lib", "node_modules", "chuggy-darwin", "cli.mjs"),
};

/**
 * @param {import("node:test").TestContext} t
 * @param {{architecture?: string, name?: string, diskGib?: number, rosetta?: "enabled" | "disabled" | "absent"}} [vm] its architecture, the name docker gives it, the GiB free on its disk and its Rosetta, when not Colima's default VM on arm64 with 90 GiB free and Rosetta enabled
 * @param {Parameters<typeof runnerFixture>[1]} [documents]
 * @param {(fixture: MacFixture) => Promise<DoctorSeen>} [prepared] what a suite makes of the Mac's files before doctor reads them
 */
async function doctored(
  t,
  vm = {},
  documents = {},
  prepared = async () => ({}),
) {
  const fixture = await runnerFixture(t, documents);
  const { home, poolFile, paths } = fixture;
  const seen = await prepared(fixture);
  const { engine, state } = fakeEngine();
  state.machine = {
    ...state.machine,
    architecture: vm.architecture ?? "aarch64",
  };
  state.info = { ...state.info, Name: vm.name ?? "colima" };
  const findings = await doctorFindings({
    poolFile,
    paths,
    uid: ownUid,
    home,
    path: seen.path,
    agentVersion: async (file) => seen.agentVersions?.[file],
    parts: {
      updates: (config) =>
        runnerUpdates(
          { config, paths },
          {
            ...copy,
            cli:
              seen.installed === undefined
                ? copy.cli
                : join(seen.installed, "cli.mjs"),
          },
          { writable: seen.writable ?? (async () => true) },
        ),
      engine: () => engine,
      colima: () =>
        fakeColima(vm.diskGib ?? 90, { rosetta: vm.rosetta ?? "enabled" })
          .colima,
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
      "ok    Claude credential",
      "warn  launchd agent",
      "ok    updates",
      "ok    docker",
      "ok    capabilities",
      "ok    job network",
      "ok    disk floor",
      "ok    pool token",
      "ok    plane",
    ],
  );
});

test("doctor names the limits a pool's entry in pools sets its service, and warns of each entry naming no pool file in the pools directory", async (t) => {
  const own = await doctored(
    t,
    {},
    {
      runner: {
        pools: { "vteng.chuggy.shame": { concurrencyMax: 0, sessionsMax: 1 } },
      },
    },
  );
  assert.match(
    own.find((line) => line.includes("runner configuration")) ?? "",
    /^ok {4}runner configuration: .+\/runner\.json: concurrencyMax 0, sessionsMax 1, as pools\.vteng\.chuggy\.shame sets them$/u,
  );

  const lines = await doctored(
    t,
    {},
    {
      runner: {
        pools: {
          "vteng.chuggy.lead": { concurrencyMax: 0, sessionsMax: 1 },
          "vteng.chuggy.leed": { concurrencyMax: 0, sessionsMax: 1 },
          "vteng.chuggy.lead.json": { concurrencyMax: 0, sessionsMax: 1 },
        },
      },
    },
    async ({ paths }) => {
      await ownerOnly(join(paths.pools, "vteng.chuggy.lead.json"), "{}");
      return {};
    },
  );
  const line = lines.find((found) => found.includes("runner configuration"));
  const [limits, ...warned] = (line ?? "").split("; ");
  assert.match(
    limits,
    /^warn {2}runner configuration: .+\/runner\.json: concurrencyMax 1, sessionsMax 2$/u,
  );
  assert.deepEqual(
    warned.map((said) =>
      said.replace(/ in \S+\/chuggy\/pools,/u, " in pools,"),
    ),
    [
      "pools.vteng.chuggy.leed names no pool file in pools, so it limits no service",
      "pools.vteng.chuggy.lead.json names no pool file in pools, so it limits no service",
    ],
  );
});

test("doctor warns of a disk in Colima's VM under the runner's floor, or one it cannot measure, and passes one over it", async (t) => {
  /** @param {string[]} lines */
  const floor = (lines) => lines.find((line) => line.includes("disk floor"));
  const where = "/var/lib/docker in Colima's VM";
  assert.equal(
    floor(
      await doctored(t, { diskGib: 30 }, { runner: { diskFreeGibMin: 50 } }),
    ),
    `warn  disk floor: 30 GiB free at ${where}, under the floor of 50 GiB: the agent removes the images it may and takes no job until it is over`,
  );
  assert.equal(
    floor(await doctored(t, { name: "docker-desktop" })),
    "warn  disk floor: none held, since the free disk could not be measured: docker names its machine docker-desktop, which is no Colima VM, so its disk cannot be measured",
  );
  assert.equal(
    floor(await doctored(t, { diskGib: 20 })),
    `ok    disk floor: 20 GiB free at ${where}, over the floor of 20 GiB`,
  );
});

test("a pool registered with --host fails doctor where the runner's file names what a host job's places set", async (t) => {
  const pool = {
    ...fixturePool,
    capabilities: [...fixturePool.capabilities, "Platform:MacOS:Arm64"],
    host: true,
  };
  const hosted = (/** @type {string[]} */ lines) =>
    lines.find((line) => line.includes("host jobs"));
  assert.match(String(hosted(await doctored(t, {}, { pool }))), /^ok /u);
  const refused = hosted(
    await doctored(
      t,
      {},
      {
        pool,
        runner: { environment: { HOME: "/Users/someone" } },
      },
    ),
  );
  assert.match(String(refused), /HOME is set for every host job/u);
  assert.equal(hosted(await doctored(t)), undefined);
});

test("doctor says what a run advertises and where it comes from, the platform of whichever VM docker runs, and fails where a run would be refused", async (t) => {
  /** @param {string[]} lines */
  const advertised = (lines) =>
    lines.find((line) => line.includes("capabilities:"));
  assert.match(
    advertised(await doctored(t, { architecture: "x86_64" })) ?? "",
    /^ok {4}capabilities: a run advertises Platform:Linux:Amd64 on each poll: docker's VM's platform, the agents .+\/runner\.json can run, and the rest of what the pool was registered with$/u,
  );
  assert.match(
    advertised(
      await doctored(
        t,
        {},
        {
          pool: {
            ...fixturePool,
            capabilities: [...fixturePool.capabilities, "Platform:MacOS:Arm64"],
            host: true,
          },
          runner: { capabilities: ["Tool:Xcode"] },
        },
      ),
    ) ?? "",
    /^ok {4}capabilities: a run advertises Platform:Linux:Arm64, Platform:Linux:Amd64, Platform:MacOS:Arm64, Tool:Xcode, Agent:Claude on each poll: docker's VM's platforms, the Mac's, the agents .+ can run, and its capabilities$/u,
  );
  assert.equal(
    advertised(await doctored(t, { architecture: "riscv64" })),
    "FAIL  capabilities: docker's VM is riscv64, which no pool runs",
  );
});

test("doctor warns where an arm64 VM runs no amd64 through Rosetta, saying how to have it, or where Rosetta cannot be asked after", async (t) => {
  /** @param {string[]} lines */
  const advertised = (lines) =>
    lines.find((line) => line.includes("capabilities:"));
  for (const rosetta of /** @type {const} */ (["absent", "disabled"]))
    assert.match(
      advertised(await doctored(t, { rosetta })) ?? "",
      /^warn {2}capabilities: a run advertises Platform:Linux:Arm64 on each poll: docker's VM's platform, .+; docker's VM runs no amd64 through Rosetta, so no job asking for Platform:Linux:Amd64 reaches this runner; install Rosetta with `softwareupdate --install-rosetta --agree-to-license`, then stop Colima and start it with `colima start --vz-rosetta`$/u,
      rosetta,
    );
  assert.match(
    advertised(await doctored(t, { name: "docker-desktop" })) ?? "",
    /^warn {2}capabilities: a run advertises Platform:Linux:Arm64 on each poll: .+; whether docker's VM runs amd64 through Rosetta could not be found, so no job asking for Platform:Linux:Amd64 reaches this runner: docker names its machine docker-desktop, which is no Colima VM$/u,
  );
  assert.match(
    advertised(await doctored(t)) ?? "",
    /^ok {4}capabilities: a run advertises Platform:Linux:Arm64, Platform:Linux:Amd64 on each poll: docker's VM's platforms, /u,
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

/**
 * Rewrites the runner's file to name `runner`'s keys beside the limits.
 *
 * @param {MacFixture["paths"]} paths
 * @param {Record<string, unknown>} runner
 */
function runnerWritten(paths, runner) {
  return ownerOnly(
    paths.config,
    JSON.stringify({ timeoutSecsMax: 3600, outputBytesMax: 65536, ...runner }),
  );
}

/** What each fixture file holds that is secret, which no finding may print. */
const claudeSecrets = {
  "claude-token": "sk-ant-oat01-fixture-token",
  "api-key": "sk-ant-api03-fixture-key",
  "bedrock-key": "ABSKfixturebedrockkey",
  aws: "fixtureAwsSecretAccessKey",
  aws_id: "AKIAFIXTUREACCESSKEY",
  google: "fixture-private-key-body",
  google_id: "fixture-private-key-id",
};

/** Each kind's file, its text holding the secrets above. */
const claudeFiles = {
  "claude-token": `${claudeSecrets["claude-token"]}\n`,
  "api-key": claudeSecrets["api-key"],
  "bedrock-key": claudeSecrets["bedrock-key"],
  aws: `[default]\naws_access_key_id = AKIAOTHERPROFILE\naws_secret_access_key = other\n[chuggy]\naws_access_key_id = ${claudeSecrets.aws_id}\naws_secret_access_key = ${claudeSecrets.aws}\n`,
  "google.json": JSON.stringify({
    type: "service_account",
    project_id: "chuggy-jobs",
    private_key_id: claudeSecrets.google_id,
    private_key: `-----BEGIN PRIVATE KEY-----\n${claudeSecrets.google}\n-----END PRIVATE KEY-----\n`,
    client_email: "jobs@chuggy-jobs.iam.gserviceaccount.com",
  }),
};

/**
 * Files a suite writes, owner-only, under the home the VM shares, and where
 * each one is.
 *
 * @param {string} home
 * @param {Record<string, string>} files each one's text, by name
 */
async function claudeFilesWritten(home, files) {
  const directory = join(home, "credentials");
  for (const [name, text] of Object.entries(files))
    await ownerOnly(join(directory, name), text);
  return (/** @type {string} */ name) => join(directory, name);
}

/**
 * The Claude credential check's line, of a runner's file naming the
 * credential `named` makes of where each fixture file is, and every line.
 *
 * @param {import("node:test").TestContext} t
 * @param {Record<string, string>} files
 * @param {(at: (name: string) => string) => Record<string, unknown>} named
 */
async function credentialDoctored(t, files, named) {
  /** @type {(name: string) => string} */
  let at = (name) => name;
  const lines = await doctored(t, {}, {}, async ({ home, paths }) => {
    at = await claudeFilesWritten(home, files);
    await runnerWritten(paths, named(at));
    return {};
  });
  return {
    at,
    lines,
    line: lines.find((line) => line.includes(" Claude credential: ")),
  };
}

test("the Claude credential check names the kind and its settings, and never what its file holds", async (t) => {
  /** @type {Array<[(at: (name: string) => string) => Record<string, unknown>, (at: (name: string) => string) => string]>} */
  const namings = [
    [
      (at) => ({ claudeTokenFile: at("claude-token") }),
      (at) =>
        `Subscription, from the Claude token file ${at("claude-token")}, this runner's own`,
    ],
    [
      (at) => ({
        claudeCredential: { kind: "ApiKey", apiKeyFile: at("api-key") },
      }),
      (at) =>
        `ApiKey, from the Anthropic API key file ${at("api-key")}, this runner's own`,
    ],
    [
      (at) => ({
        claudeCredential: {
          kind: "Bedrock",
          region: "us-west-2",
          apiKeyFile: at("bedrock-key"),
        },
      }),
      (at) =>
        `Bedrock, region us-west-2, from the Bedrock API key file ${at("bedrock-key")}, this runner's own`,
    ],
    [
      (at) => ({
        claudeCredential: {
          kind: "Bedrock",
          region: "us-west-2",
          credentialsFile: at("aws"),
          profile: "chuggy",
        },
      }),
      (at) =>
        `Bedrock, region us-west-2, profile chuggy, from the AWS credentials file ${at("aws")}, this runner's own`,
    ],
    [
      (at) => ({
        claudeCredential: {
          kind: "Vertex",
          region: "us-east5",
          project: "chuggy-jobs",
          credentialsFile: at("google.json"),
        },
      }),
      (at) =>
        `Vertex, region us-east5, project chuggy-jobs, from the Google service account key file ${at("google.json")}, this runner's own`,
    ],
    [
      (at) => ({
        claudeCredential: {
          kind: "Foundry",
          resource: "chuggy-jobs",
          apiKeyFile: at("api-key"),
        },
      }),
      (at) =>
        `Foundry, resource chuggy-jobs, from the Foundry API key file ${at("api-key")}, this runner's own`,
    ],
  ];
  for (const [named, detail] of namings) {
    const { at, lines, line } = await credentialDoctored(t, claudeFiles, named);
    assert.equal(line, `ok    Claude credential: ${detail(at)}`);
    const said = lines.join("\n");
    for (const secret of Object.values(claudeSecrets))
      assert.equal(said.includes(secret), false, secret);
  }
});

test("a Claude credential's file that is no credential of its kind, or lies outside the home the VM shares, fails the check, saying what it lacks and never what it holds", async (t) => {
  const secret = "sk-ant-fixture-never-printed";
  const files = {
    "two-lines": `${secret}\n${secret}\n`,
    blank: " \n\n",
    "no-profile": `[default]\naws_access_key_id = ${secret}\naws_secret_access_key = ${secret}\n`,
    "not-service-account": JSON.stringify({
      type: "authorized_user",
      refresh_token: secret,
    }),
  };
  const elsewhere = await mkdtemp(join(tmpdir(), "chuggy-darwin-elsewhere-"));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  const outside = await ownerOnly(join(elsewhere, "api-key"), secret);
  /** @type {Array<[(at: (name: string) => string) => Record<string, unknown>, (at: (name: string) => string, home: string) => string]>} */
  const refused = [
    [
      (at) => ({
        claudeCredential: { kind: "Subscription", tokenFile: at("two-lines") },
      }),
      (at) =>
        `the Claude token file ${at("two-lines")} holds more than one line; save \`claude setup-token\`'s output there, alone`,
    ],
    [
      (at) => ({
        claudeCredential: { kind: "ApiKey", apiKeyFile: at("blank") },
      }),
      (at) =>
        `the Anthropic API key file ${at("blank")} is empty; save a key from the Claude Console there, alone`,
    ],
    [
      (at) => ({
        claudeCredential: {
          kind: "Bedrock",
          region: "us-west-2",
          credentialsFile: at("no-profile"),
          profile: "chuggy",
        },
      }),
      (at) =>
        `the AWS credentials file ${at("no-profile")} has no [chuggy] profile; name the profile its keys are under, or give its [chuggy] profile an access key's aws_access_key_id and aws_secret_access_key`,
    ],
    [
      (at) => ({
        claudeCredential: {
          kind: "Vertex",
          region: "us-east5",
          project: "chuggy-jobs",
          credentialsFile: at("not-service-account"),
        },
      }),
      (at) =>
        `the Google service account key file ${at("not-service-account")} is not a service account's key; save the JSON key Google Cloud made for a service account there`,
    ],
    [
      () => ({ claudeCredential: { kind: "ApiKey", apiKeyFile: outside } }),
      (_at, home) =>
        `the Anthropic API key file ${outside} is not under ${home}, or leads outside it, and ${home} is the only directory Colima shares with its VM by default, so a job would find nothing at its mount`,
    ],
  ];
  for (const [named, detail] of refused) {
    const { at, lines, line } = await credentialDoctored(t, files, named);
    const home = at("x").slice(0, -"/credentials/x".length);
    assert.equal(line, `FAIL  Claude credential: ${detail(at, home)}`);
    assert.equal(lines.join("\n").includes(secret), false);
  }
});

/**
 * @typedef {object} HostSeen
 * @property {Record<string, unknown>} [runner] the runner's file's keys past the fixture's
 * @property {string} [agentPath] the PATH an agent's property list names
 * @property {string} [agentPoolFile] the pool file it serves, the fixture's where absent
 * @property {string} [path] doctor's own
 * @property {Record<string, string>} [agentVersions] the fixture's `claude`'s alone where absent
 * @property {Record<string, unknown>} [pool] a host pool's where absent
 */

/**
 * Directories to find a `claude` in: one holding a `claude` to run, one
 * holding another, and one whose `claude` is a directory.
 *
 * @param {import("node:test").TestContext} t
 */
async function claudeBins(t) {
  /** @type {string[]} */
  const directories = [];
  for (const name of ["bin", "agent-bin", "empty"])
    directories.push(await mkdtemp(join(tmpdir(), `chuggy-darwin-${name}-`)));
  t.after(() =>
    Promise.all(
      directories.map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    ),
  );
  const [bin, agentBin, empty] = directories;
  for (const directory of [bin, agentBin])
    await writeFile(join(directory, "claude"), "#!/bin/sh\n", { mode: 0o700 });
  await mkdir(join(empty, "claude"));
  return { bin, agentBin, empty, claude: join(bin, "claude") };
}

/**
 * Whether doctor's Claude credential check warned, and what it says past the
 * credential, of a runner whose agent, where `seen` names one, runs it on the
 * PATH `seen` names.
 *
 * @param {import("node:test").TestContext} t
 * @param {string} claude the `claude` whose version the fixture knows
 * @param {HostSeen} seen
 */
async function hostClaudeSaid(t, claude, seen) {
  const documents = {
    pool: seen.pool ?? { ...fixturePool, host: true },
    runner: seen.runner ?? {},
  };
  const lines = await doctored(t, {}, documents, async (fixture) => {
    if (seen.agentPath !== undefined) {
      const label = launchAgentLabel(fixture.poolFile);
      await mkdir(fixture.paths.agents, { recursive: true });
      await writeFile(
        join(fixture.paths.agents, launchAgentFileName(label)),
        launchAgentPlist({
          label,
          node: "/opt/homebrew/bin/node",
          cli: "/opt/chuggy-darwin/cli.mjs",
          poolFile: seen.agentPoolFile ?? fixture.poolFile,
          path: seen.agentPath,
          log: join(fixture.paths.logs, `${label}.log`),
          background: false,
        }),
      );
    }
    return {
      path: seen.path,
      agentVersions: seen.agentVersions ?? {
        [claude]: "2.1.282 (Claude Code)",
      },
    };
  });
  const line = lines.find((said) => said.includes(" Claude credential: "));
  const [credential, ...rest] = (line ?? "").split("; ");
  assert.match(
    credential,
    /^(?:ok {4}|warn {2})Claude credential: Subscription, from the Claude token file \/.*\/\.claude-token, this runner's own$/u,
  );
  return { warning: line?.startsWith("warn") ?? false, host: rest.join("; ") };
}

test("on a pool registered with --host, the Claude credential check names the claude a job on the Mac itself runs, on the PATH it is started with", async (t) => {
  const { bin, agentBin, empty, claude } = await claudeBins(t);
  for (const [seen, whose] of /** @type {Array<[HostSeen, string]>} */ ([
    [
      {
        runner: { environment: { PATH: `${empty}:relative:${bin}` } },
        agentPath: agentBin,
      },
      "the PATH the runner's file sets",
    ],
    [
      { agentPath: `${empty}:${bin}`, path: agentBin },
      "the PATH the launchd agent runs the runner with",
    ],
    [
      { agentPath: agentBin, agentPoolFile: "/elsewhere.json", path: bin },
      "doctor's own PATH",
    ],
    [{ path: bin }, "doctor's own PATH"],
  ]))
    assert.deepEqual(await hostClaudeSaid(t, claude, seen), {
      warning: false,
      host: `a job on the Mac itself runs ${claude}, 2.1.282 (Claude Code), found on ${whose}`,
    });
  assert.deepEqual(
    await hostClaudeSaid(t, claude, { path: bin, agentVersions: {} }),
    {
      warning: false,
      host: `a job on the Mac itself runs ${claude}, which says no version, found on doctor's own PATH`,
    },
  );
  assert.deepEqual(
    await hostClaudeSaid(t, claude, { pool: fixturePool, path: bin }),
    { warning: false, host: "" },
  );
});

test("on a pool registered with --host, the Claude credential check warns, passing, where no claude a job on the Mac itself could run is on its PATH", async (t) => {
  const { bin, empty, claude } = await claudeBins(t);
  assert.deepEqual(
    await hostClaudeSaid(t, claude, { agentPath: empty, path: bin }),
    {
      warning: true,
      host: `no claude is on the PATH the launchd agent runs the runner with, ${empty}, so a job on the Mac itself runs no Claude Code`,
    },
  );
  assert.deepEqual(await hostClaudeSaid(t, claude, {}), {
    warning: true,
    host: "no claude is on doctor's own PATH, which is empty, so a job on the Mac itself runs no Claude Code",
  });
  assert.equal(
    (await hostClaudeSaid(t, claude, { path: relative(process.cwd(), bin) }))
      .warning,
    true,
  );
  await chmod(claude, 0o600);
  assert.equal((await hostClaudeSaid(t, claude, { path: bin })).warning, true);
});

/** The remedy a refusal of the Codex credential's file names. */
const codexRemedy = "run codex login, which writes it to ~/.codex/auth.json";

/** What the Codex fixture file holds that is secret, which no finding may print. */
const codexSecret = "codex-refresh-token-fixture";

/** A pool registered declaring `Agent:Codex`. */
const codexPool = {
  ...fixturePool,
  capabilities: ["Platform:Linux:Arm64", "Agent:Codex"],
};

/** An image its owner lists as running Codex. */
const codexImages = [
  { image: "registry.example/codex", capabilities: ["Agent:Codex"] },
];

/**
 * @typedef {object} CodexSeen
 * @property {Record<string, unknown>} [pool] this pool's file, where not `codexPool`
 * @property {Record<string, unknown>} [runner] the runner's file's keys beside its Claude token file and limits
 * @property {boolean} [named] whether the runner's file names a Codex credential, which it does unless false
 * @property {boolean} [absent] whether the auth file it names is missing
 * @property {string} [text] what the Codex auth file holds, `{}` where absent
 * @property {number} [mode] the auth file's mode, where not owner-only
 * @property {boolean} [outside] whether the auth file lies outside the home
 * @property {Record<string, Record<string, unknown>>} [registered] other pool files, by name
 * @property {string} [path] doctor's own PATH
 * @property {Record<string, string>} [agentVersions]
 */

/**
 * The Codex credential check's line, or nothing, every line doctor printed,
 * and the Codex auth file a runner's file names under the home, or outside
 * it, holding `text`.
 *
 * @param {import("node:test").TestContext} t
 * @param {CodexSeen} [seen]
 */
async function codexDoctored(t, seen = {}) {
  let authFile = "";
  const lines = await doctored(
    t,
    {},
    { pool: seen.pool ?? codexPool },
    async ({ home, paths, tokenFile }) => {
      const directory = seen.outside
        ? await mkdtemp(join(tmpdir(), "chuggy-darwin-codex-"))
        : join(home, ".codex");
      t.after(() => rm(directory, { recursive: true, force: true }));
      authFile = join(directory, "auth.json");
      if (seen.absent !== true) {
        await ownerOnly(authFile, seen.text ?? "{}");
        if (seen.mode !== undefined) await chmod(authFile, seen.mode);
      }
      await runnerWritten(paths, {
        claudeTokenFile: tokenFile,
        ...(seen.named === false ? {} : { codexCredential: { authFile } }),
        ...seen.runner,
      });
      for (const [name, pool] of Object.entries(seen.registered ?? {}))
        await ownerOnly(join(paths.pools, name), JSON.stringify(pool));
      return { path: seen.path, agentVersions: seen.agentVersions };
    },
  );
  return {
    authFile,
    lines,
    line: lines.find((line) => line.includes(" Codex credential: ")),
  };
}

/**
 * Catches the Codex file's check printing what it holds, or appearing on a
 * runner neither whose file nor whose pool names Codex.
 */
test("the Codex credential check names its file and never what it holds, and is made only where the runner's file or the pool names Codex", async (t) => {
  const { authFile, lines, line } = await codexDoctored(t, {
    text: JSON.stringify({ tokens: { refresh_token: codexSecret } }),
    runner: { images: codexImages },
  });
  assert.equal(
    line,
    `ok    Codex credential: the Codex auth file ${authFile}, this runner's own`,
  );
  assert.equal(lines.join("\n").includes(codexSecret), false);
  const unnamed = await doctored(t);
  assert.equal(
    unnamed.some((said) => said.includes(" Codex credential: ")),
    false,
  );
});

/**
 * Catches a Codex file no core could read passed, its text or a parser's
 * message printed, or one a job cannot be handed passed.
 */
test("a Codex credential's file that is no JSON object, or that a job cannot be handed, fails the check, never naming what it holds", async (t) => {
  for (const text of [
    `["${codexSecret}"]`,
    `{"refresh_token": ${codexSecret}`,
    "null",
    `"${codexSecret}"`,
  ]) {
    const { authFile, lines, line } = await codexDoctored(t, { text });
    assert.equal(
      line,
      `FAIL  Codex credential: the Codex auth file ${authFile} is not a JSON object; ${codexRemedy}`,
      text,
    );
    assert.equal(lines.join("\n").includes(codexSecret), false);
  }
  for (const [seen, detail] of /** @type {Array<[CodexSeen, RegExp]>} */ ([
    [{ mode: 0o640 }, /is mode 640; only its owner may read or write it/u],
    [{ absent: true }, /^the Codex auth file \S+ cannot be found; /u],
    [
      { outside: true },
      /is not under \S+, or leads outside it, and \S+ is the only directory Colima shares with its VM by default/u,
    ],
  ])) {
    const { line } = await codexDoctored(t, seen);
    assert.match(line ?? "", /^FAIL {2}Codex credential: /u);
    assert.match((line ?? "").slice("FAIL  Codex credential: ".length), detail);
  }
});

/**
 * Catches a pool whose Codex jobs are handed the Claude credential's file
 * passing unwarned, or failing doctor, and one warned of that advertises no
 * Codex.
 */
test("a pool advertising Agent:Codex is warned of, and passes, where the runner's file names no codexCredential, its Codex jobs handed the Claude credential's file", async (t) => {
  for (const runner of [
    { images: codexImages },
    { capabilities: ["Agent:Codex"] },
  ])
    assert.match(
      (await codexDoctored(t, { named: false, runner })).line ?? "",
      /^warn {2}Codex credential: this pool advertises Agent:Codex and \/.*\/runner\.json names no codexCredential, so its Codex jobs are handed the Claude credential's file; add codexCredential to hand them a Codex auth\.json$/u,
      JSON.stringify(runner),
    );
  assert.equal((await codexDoctored(t, { named: false })).line, undefined);
});

/**
 * Catches a Codex credential no pool here brings a job to passing unwarned,
 * or warned of where this pool or another here advertises Agent:Codex.
 */
test("a Codex credential no pool here advertises Agent:Codex for is warned of, and passes where an image, or another pool's host, runs Codex", async (t) => {
  for (const seen of /** @type {CodexSeen[]} */ ([
    { runner: { images: codexImages } },
    {
      registered: {
        "vteng.chuggy.other.json": {
          ...fixturePool,
          pool: "other",
          host: true,
        },
      },
    },
  ])) {
    const { authFile, line } = await codexDoctored(t, seen);
    assert.equal(
      line,
      `ok    Codex credential: the Codex auth file ${authFile}, this runner's own`,
    );
  }
  for (const seen of /** @type {CodexSeen[]} */ ([
    {},
    { registered: { "vteng.chuggy.other.json": codexPool } },
  ])) {
    const { authFile, line } = await codexDoctored(t, seen);
    assert.equal(
      line,
      `warn  Codex credential: the Codex auth file ${authFile}, this runner's own; no pool here advertises Agent:Codex, since no images entry declares it and no pool here was registered with --host, so no job requiring Agent:Codex reaches this runner`,
    );
  }
});

/**
 * Catches a host job's Codex left unnamed, or its absence passing unwarned.
 */
test("on a pool registered with --host, the Codex credential check names the codex a job on the Mac itself runs, and warns, passing, where there is none", async (t) => {
  const bin = await mkdtemp(join(tmpdir(), "chuggy-darwin-bin-"));
  const empty = await mkdtemp(join(tmpdir(), "chuggy-darwin-empty-"));
  t.after(() =>
    Promise.all(
      [bin, empty].map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    ),
  );
  const codex = join(bin, "codex");
  await writeFile(codex, "#!/bin/sh\n", { mode: 0o700 });
  /** @param {string} path */
  const found = (path) =>
    codexDoctored(t, {
      pool: { ...codexPool, host: true },
      path,
      agentVersions: { [codex]: "codex-cli 0.50.0" },
    });
  const named = await found(bin);
  assert.equal(
    named.line,
    `ok    Codex credential: the Codex auth file ${named.authFile}, this runner's own; a job on the Mac itself runs ${codex}, codex-cli 0.50.0, found on doctor's own PATH`,
  );
  const none = await found(empty);
  assert.equal(
    none.line,
    `warn  Codex credential: the Codex auth file ${none.authFile}, this runner's own; no codex is on doctor's own PATH, ${empty}, so a job on the Mac itself runs no Codex`,
  );
});

/**
 * Catches updates said to be on where the runner's file turns them off, or
 * the reverse.
 */
test("doctor says the runner updates itself unless its file turns that off", async (t) => {
  /** @param {string[]} lines */
  const updates = (lines) => lines.find((line) => line.includes(" updates: "));
  assert.equal(
    updates(await doctored(t)),
    "ok    updates: on: a run installs the release chuggy names",
  );
  assert.equal(
    updates(
      await doctored(t, {}, { runner: { autoUpdate: false } }, async () => ({
        writable: async () => false,
      })),
    ),
    "ok    updates: off: the runner's file sets autoUpdate to false",
  );
});

/**
 * Catches an install that could not take a release passing unwarned, or
 * failing doctor, or the update asked of other directories than npm's.
 */
test("an install that could not update itself is warned of with why, and passes", async (t) => {
  const remedy =
    "install it with npm under a prefix you own, such as Homebrew's";
  /** @param {string[]} lines */
  const updates = (lines) => lines.find((line) => line.includes(" updates: "));
  assert.equal(
    updates(
      await doctored(t, {}, {}, async () => ({
        installed: "/opt/chuggy-darwin",
      })),
    ),
    `warn  updates: on, but this install cannot take a release: this runner is installed at /opt/chuggy-darwin, which is not where npm installs a package globally; ${remedy}`,
  );
  /** @type {string[]} */
  const asked = [];
  const unwritable = await doctored(t, {}, {}, async () => ({
    writable: async (path) => {
      asked.push(path);
      return !path.endsWith("bin");
    },
  }));
  assert.deepEqual(asked, [
    join(homebrewPrefix, "lib", "node_modules"),
    join(homebrewPrefix, "bin"),
  ]);
  assert.equal(
    updates(unwritable),
    `warn  updates: on, but this install cannot take a release: this runner cannot write ${join(homebrewPrefix, "bin")}, where npm would install it; ${remedy}`,
  );
});
