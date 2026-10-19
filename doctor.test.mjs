import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { registerRequest } from "@chuggy/worker-core/register.mjs";

import { doctorFindings, findingLine } from "./doctor.mjs";
import { fakeEngine } from "./engine.fixture.mjs";
import {
  launchAgentFileName,
  launchAgentLabel,
  launchAgentPlist,
} from "./launchAgent.mjs";
import { vmPlatform } from "./runner.mjs";
import { fixturePool, ownerOnly, runnerFixture } from "./runner.fixture.mjs";

const ownUid = process.getuid?.() ?? -1;

/**
 * @typedef {Awaited<ReturnType<typeof runnerFixture>>} MacFixture
 *
 * @typedef {object} DoctorSeen what doctor is run with besides the files
 * @property {string} [path] its own PATH
 * @property {Record<string, string>} [claudeVersions] what each `claude` says its version is
 */

/**
 * @param {import("node:test").TestContext} t
 * @param {{architecture?: string}} [vm]
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
  const findings = await doctorFindings({
    poolFile,
    paths,
    uid: ownUid,
    home,
    path: seen.path,
    claudeVersion: async (file) => seen.claudeVersions?.[file],
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
      "ok    Claude credential",
      "warn  launchd agent",
      "ok    docker",
      "ok    platform",
      "ok    job network",
      "ok    pool token",
      "ok    plane",
    ],
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
 * @property {Record<string, string>} [claudeVersions] the fixture's `claude`'s alone where absent
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
        }),
      );
    }
    return {
      path: seen.path,
      claudeVersions: seen.claudeVersions ?? {
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
    await hostClaudeSaid(t, claude, { path: bin, claudeVersions: {} }),
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
