import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  claudeCredentialProviderVariables,
  claudeCredentialVariables,
} from "@chuggy/worker-core/claudeCredential.mjs";
import { reservedJobVariables } from "@chuggy/worker-core/job.mjs";

import { ownerOnly, runnerFixture } from "./runner.fixture.mjs";
import {
  claudeCredentialFileRefusal,
  runnerClaudeHanded,
  runnerConfig,
} from "./runnerConfig.mjs";
import { runnerPaths } from "./runnerPaths.mjs";

/** The setting a subscription's token is told by. */
const subscription = { kind: /** @type {const} */ ("Subscription") };

/** A Claude credential of each kind, as a runner's file names one. */
const credentials = [
  {
    kind: "Subscription",
    tokenFile: "/Users/shame/.config/chuggy/claude-token",
  },
  {
    kind: "ApiKey",
    apiKeyFile: "/Users/shame/.config/chuggy/anthropic-api-key",
  },
  {
    kind: "Bedrock",
    region: "us-west-2",
    apiKeyFile: "/Users/shame/.config/chuggy/bedrock-api-key",
  },
  {
    kind: "Bedrock",
    region: "us-west-2",
    credentialsFile: "/Users/shame/.aws/credentials",
    profile: "chuggy",
  },
  {
    kind: "Vertex",
    region: "us-east5",
    project: "chuggy-jobs",
    credentialsFile: "/Users/shame/.config/gcloud/chuggy-jobs.json",
  },
  {
    kind: "Foundry",
    resource: "chuggy-jobs",
    apiKeyFile: "/Users/shame/.config/chuggy/foundry-api-key",
  },
];

test("the runner keeps its file, agents, logs, host jobs and runtime where a Mac keeps each, and pool files and sign-ins where chuggy-linux does", () => {
  assert.deepEqual(runnerPaths("/Users/shame"), {
    config:
      "/Users/shame/Library/Application Support/chuggy-darwin/runner.json",
    agents: "/Users/shame/Library/LaunchAgents",
    pools: "/Users/shame/.config/chuggy/pools",
    signIns: "/Users/shame/.config/chuggy/sign-ins",
    logs: "/Users/shame/Library/Logs/chuggy-darwin",
    jobs: "/Users/shame/Library/Application Support/chuggy-darwin/jobs",
    runtime: "/Users/shame/Library/Caches/chuggy-darwin",
  });
});

test("the runner's file takes the limits' defaults, and refuses an engine, since docker is the one", async (t) => {
  const { paths } = await runnerFixture(t);
  const config = await runnerConfig(paths.config);
  assert.equal(config.concurrencyMax, 1);
  assert.equal(config.sessionsMax, 2);
  assert.equal(config.network, "chuggy-jobs");
  assert.deepEqual(config.images, []);
  const engined = await runnerFixture(t, { runner: { engine: "docker" } });
  await assert.rejects(runnerConfig(engined.paths.config), /engine/u);
});

test("the runner's file is refused where anyone but its owner can read it", async (t) => {
  const { paths } = await runnerFixture(t);
  await chmod(paths.config, 0o644);
  await assert.rejects(
    runnerConfig(paths.config),
    /is mode 644; only its owner may read or write it/u,
  );
});

test("a token file the runner owns alone, under the home the VM shares, can be handed to a job", async (t) => {
  const { home, tokenFile } = await runnerFixture(t);
  const uid = /** @type {() => number} */ (process.getuid)();
  assert.equal(
    await claudeCredentialFileRefusal(subscription, tokenFile, { uid, home }),
    undefined,
  );
});

test("a token file outside the home, linked to from inside it, or named outside it by a link leading in, is refused, since the VM would show a job nothing there", async (t) => {
  const { home, tokenFile } = await runnerFixture(t);
  const elsewhere = await mkdtemp(join(tmpdir(), "chuggy-darwin-elsewhere-"));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  const outside = await ownerOnly(join(elsewhere, "token"), "t");
  const linkedOut = join(home, "linked-token");
  await symlink(outside, linkedOut);
  const linkedIn = join(elsewhere, "linked-in");
  await symlink(tokenFile, linkedIn);
  const uid = /** @type {() => number} */ (process.getuid)();
  for (const file of [outside, linkedOut, linkedIn])
    assert.match(
      /** @type {string} */ (
        await claudeCredentialFileRefusal(subscription, file, { uid, home })
      ),
      /^the Claude token file .* is not under .*, or leads outside it, and .* is the only directory Colima shares with its VM by default/u,
      file,
    );
  const linkedWithin = join(home, "within");
  await symlink(tokenFile, linkedWithin);
  assert.equal(
    await claudeCredentialFileRefusal(subscription, linkedWithin, {
      uid,
      home,
    }),
    undefined,
  );
});

test("a token file anyone else can read, that is empty, missing, or another user's, is refused", async (t) => {
  const { home, tokenFile } = await runnerFixture(t);
  const uid = /** @type {() => number} */ (process.getuid)();
  /** @param {string} file */
  const refusal = async (file, runner = { uid, home }) =>
    (await claudeCredentialFileRefusal(subscription, file, runner)) ?? "";
  assert.match(
    await refusal(tokenFile, { uid: uid + 1, home }),
    /is owned by uid \d+, not by this runner's uid \d+$/u,
  );
  const absent = join(home, "absent");
  assert.equal(
    await refusal(absent),
    `the Claude token file ${absent} cannot be found; save \`claude setup-token\`'s output there, alone`,
  );
  await writeFile(tokenFile, "");
  assert.match(
    await refusal(tokenFile),
    /is empty; save `claude setup-token`'s output there, alone$/u,
  );
  await chmod(tokenFile, 0o644);
  assert.match(await refusal(tokenFile), /is mode 644/u);
});

test("a Claude credential's file a job cannot be handed is refused, naming the file its kind is and what to save there", async (t) => {
  const { home } = await runnerFixture(t);
  const uid = /** @type {() => number} */ (process.getuid)();
  const missing = join(home, "missing");
  const elsewhere = await mkdtemp(join(tmpdir(), "chuggy-darwin-elsewhere-"));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  const outside = await ownerOnly(join(elsewhere, "key.json"), "{}");
  for (const [setting, file, said] of [
    [
      { kind: "ApiKey" },
      missing,
      `the Anthropic API key file ${missing} cannot be found; save a key from the Claude Console there, alone`,
    ],
    [
      { kind: "Bedrock", region: "us-west-2", profile: "chuggy" },
      missing,
      `the AWS credentials file ${missing} cannot be found; give its [chuggy] profile an access key's aws_access_key_id and aws_secret_access_key`,
    ],
    [
      { kind: "Vertex", region: "us-east5", project: "chuggy-jobs" },
      outside,
      `the Google service account key file ${outside} is not under ${home}, or leads outside it, and ${home} is the only directory Colima shares with its VM by default, so a job would find nothing at its mount`,
    ],
  ])
    assert.equal(
      await claudeCredentialFileRefusal(
        /** @type {any} */ (setting),
        /** @type {string} */ (file),
        { uid, home },
      ),
      said,
    );
});

test("a file names a Claude credential of any kind in claudeCredential, read as it is named and handed as its file and kind", async (t) => {
  for (const claudeCredential of credentials) {
    const { paths } = await runnerFixture(t, {
      runner: { claudeTokenFile: undefined, claudeCredential },
    });
    const read = await runnerConfig(paths.config);
    assert.deepEqual(read.claudeCredential, claudeCredential);
    assert.equal("claudeTokenFile" in read, false);
    const { kind, ...rest } = claudeCredential;
    const handed = runnerClaudeHanded(read);
    assert.equal(
      handed.tokenFile,
      rest.tokenFile ?? rest.apiKeyFile ?? rest.credentialsFile,
    );
    assert.equal(handed.claudeCredential.kind, kind);
  }
  const { paths, tokenFile } = await runnerFixture(t);
  assert.deepEqual(runnerClaudeHanded(await runnerConfig(paths.config)), {
    tokenFile,
    claudeCredential: subscription,
  });
});

test("a file naming a Claude credential by both keys, or by neither, is refused, one naming neither as one naming no token file always was", async (t) => {
  const neither = await runnerFixture(t, {
    runner: { claudeTokenFile: undefined },
  });
  await assert.rejects(runnerConfig(neither.paths.config), {
    message: `runner configuration ${neither.paths.config}: claudeTokenFile Invalid input: expected string, received undefined`,
  });
  const unlimited = await runnerFixture(t, {
    runner: { claudeTokenFile: undefined, timeoutSecsMax: undefined },
  });
  await assert.rejects(
    runnerConfig(unlimited.paths.config),
    /timeoutSecsMax .*; claudeTokenFile Invalid input: expected string, received undefined$/u,
  );
  for (const claudeCredential of credentials) {
    const both = await runnerFixture(t, { runner: { claudeCredential } });
    await assert.rejects(runnerConfig(both.paths.config), {
      message: `runner configuration ${both.paths.config}: claudeCredential names a Claude credential, and so does claudeTokenFile; keep one`,
    });
  }
});

test("what a Claude credential may not say is refused, naming where", async (t) => {
  const refused = [
    [
      { kind: "OAuth" },
      /claudeCredential\.kind names no kind of Claude credential/u,
    ],
    [
      { kind: "Subscription", tokenFile: "claude-token" },
      /claudeCredential\.tokenFile must be an absolute path/u,
    ],
    [
      { kind: "ApiKey", apiKeyFile: "/Users/shame/a,readonly=false" },
      /claudeCredential\.apiKeyFile cannot be named in a bind mount/u,
    ],
    [
      {
        kind: "Vertex",
        region: "r",
        project: "p",
        credentialsFile: "key.json",
      },
      /claudeCredential\.credentialsFile must be an absolute path/u,
    ],
    [
      { kind: "ApiKey", apiKeyFile: "/k", region: "us-west-2" },
      /claudeCredential Unrecognized key: "region"/u,
    ],
    [{ kind: "Bedrock", apiKeyFile: "/k" }, /claudeCredential\.region /u],
  ];
  for (const [claudeCredential, why] of refused) {
    const { paths } = await runnerFixture(t, {
      runner: { claudeTokenFile: undefined, claudeCredential },
    });
    await assert.rejects(
      runnerConfig(paths.config),
      why,
      JSON.stringify(claudeCredential),
    );
  }
});

test("the environment may name any other variable that chooses Claude Code's credential or where it is sent, read as written whatever kind is named", async (t) => {
  const environment = Object.fromEntries(
    [
      ...claudeCredentialVariables.filter(
        (name) => !reservedJobVariables.includes(name),
      ),
      ...credentials.flatMap(({ kind }) =>
        claudeCredentialProviderVariables(kind),
      ),
    ].map((name) => [name, "elsewhere"]),
  );
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "AWS_PROFILE"])
    assert.ok(Object.hasOwn(environment, name), name);
  for (const named of [
    {},
    ...credentials.map((claudeCredential) => ({
      claudeTokenFile: undefined,
      claudeCredential,
    })),
  ]) {
    const { paths } = await runnerFixture(t, {
      runner: { ...named, environment },
    });
    assert.deepEqual(
      (await runnerConfig(paths.config)).environment,
      environment,
    );
  }
});

test("what the file may not say is refused, naming where", async (t) => {
  const refused = [
    [{ claudeTokenFile: "token" }, /claudeTokenFile must be an absolute path/u],
    [
      { claudeTokenFile: "/Users/shame/a,b" },
      /claudeTokenFile cannot be named in a bind mount/u,
    ],
    [{ network: "host" }, /network may not be the host's network/u],
    [
      { environment: { CHUG_WORKER_TASK: "{}" } },
      /environment\.CHUG_WORKER_TASK is the runner's to set/u,
    ],
    [
      { environment: { CLAUDE_CODE_OAUTH_TOKEN: "x" } },
      /environment\.CLAUDE_CODE_OAUTH_TOKEN is the runner's to set/u,
    ],
    [
      { environment: { CHUG_WORKER_CLAUDE_CREDENTIAL: "{}" } },
      /environment\.CHUG_WORKER_CLAUDE_CREDENTIAL is the runner's to set/u,
    ],
    [
      { environment: { NAME: "a\nB=c" } },
      /environment\.NAME may not break a line/u,
    ],
    [
      { images: [{ image: "x", capabilities: ["Platform:Linux:Arm64"] }] },
      /images\.0\.capabilities\.0 names a platform/u,
    ],
  ];
  for (const [runner, line] of refused) {
    const { paths } = await runnerFixture(t, { runner });
    await assert.rejects(runnerConfig(paths.config), line);
  }
});

test("sessionsMax may be 0, holding no sessions", async (t) => {
  const { paths } = await runnerFixture(t, { runner: { sessionsMax: 0 } });
  assert.equal((await runnerConfig(paths.config)).sessionsMax, 0);
});

test("a directory is not a runner configuration", async (t) => {
  const { paths } = await runnerFixture(t, { runner: undefined });
  await mkdir(paths.config, { recursive: true, mode: 0o700 });
  await assert.rejects(runnerConfig(paths.config), /is not a file/u);
});
