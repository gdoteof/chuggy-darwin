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
  claudeCredentialDescribed,
  claudeCredentialProviderVariables,
  claudeCredentialVariables,
} from "@chuggy/worker-core/claudeCredential.mjs";
import { reservedJobVariables } from "@chuggy/worker-core/job.mjs";

import { ownerOnly, runnerFixture } from "./runner.fixture.mjs";
import {
  credentialFileRefusal,
  runnerCredentialDescribed,
  runnerCredentialsHanded,
  runnerConfig,
  runnerConfigLimits,
  runnerPoolLimits,
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

test("the runner keeps its file, agents, logs, host jobs, image record and runtime where a Mac keeps each, and pool files and sign-ins where chuggy-linux does", () => {
  assert.deepEqual(runnerPaths("/Users/shame"), {
    config:
      "/Users/shame/Library/Application Support/chuggy-darwin/runner.json",
    agents: "/Users/shame/Library/LaunchAgents",
    pools: "/Users/shame/.config/chuggy/pools",
    signIns: "/Users/shame/.config/chuggy/sign-ins",
    logs: "/Users/shame/Library/Logs/chuggy-darwin",
    jobs: "/Users/shame/Library/Application Support/chuggy-darwin/jobs",
    images: "/Users/shame/Library/Application Support/chuggy-darwin/images",
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
  assert.deepEqual(config.pools, {});
  assert.equal(config.imageUnusedSecsMax, 604_800);
  assert.equal(config.diskFreeGibMin, 20);
  assert.equal(config.memoryFreeGibMin, 0);
  assert.equal(config.memoryReservedGib, 0);
  const engined = await runnerFixture(t, { runner: { engine: "docker" } });
  await assert.rejects(runnerConfig(engined.paths.config), /engine/u);
});

test("the runner updates itself unless its file turns that off", async (t) => {
  for (const [runner, autoUpdate] of /** @type {const} */ ([
    [{}, true],
    [{ autoUpdate: true }, true],
    [{ autoUpdate: false }, false],
  ])) {
    const { paths } = await runnerFixture(t, { runner });
    assert.equal((await runnerConfig(paths.config)).autoUpdate, autoUpdate);
  }
  for (const autoUpdate of ["false", 0, null]) {
    const { paths } = await runnerFixture(t, { runner: { autoUpdate } });
    await assert.rejects(runnerConfig(paths.config), {
      message: new RegExp(
        `^runner configuration ${paths.config}: autoUpdate Invalid input: expected boolean`,
        "u",
      ),
    });
  }
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
    await credentialFileRefusal(
      claudeCredentialDescribed(subscription),
      tokenFile,
      { uid, home },
    ),
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
        await credentialFileRefusal(
          claudeCredentialDescribed(subscription),
          file,
          { uid, home },
        )
      ),
      /^the Claude token file .* is not under .*, or leads outside it, and .* is the only directory Colima shares with its VM by default/u,
      file,
    );
  const linkedWithin = join(home, "within");
  await symlink(tokenFile, linkedWithin);
  assert.equal(
    await credentialFileRefusal(
      claudeCredentialDescribed(subscription),
      linkedWithin,
      {
        uid,
        home,
      },
    ),
    undefined,
  );
});

/**
 * Catches a Codex credential's file a bind mount cannot name, or a line
 * naming more than it, accepted; one named and not handed to the backends as
 * Codex's; or one handed where the file names none.
 */
test("a file may name a Codex credential's auth.json beside the Claude one, handed to the backends as Codex's, and one naming none hands no other agent's", async (t) => {
  const authFile = "/Users/you/.codex/auth.json";
  const { paths, tokenFile } = await runnerFixture(t, {
    runner: { codexCredential: { authFile } },
  });
  const read = await runnerConfig(paths.config);
  assert.deepEqual(read.codexCredential, { authFile });
  assert.deepEqual(runnerCredentialsHanded(read), {
    tokenFile,
    claudeCredential: subscription,
    agentCredentialFiles: { Codex: authFile },
  });
  for (const [codexCredential, why] of [
    [
      { authFile: "auth.json" },
      /codexCredential\.authFile must be an absolute path/u,
    ],
    [
      { authFile: "/a,readonly=false" },
      /codexCredential\.authFile cannot be named in a bind mount/u,
    ],
    [
      { authFile, kind: "ChatGPT" },
      /codexCredential Unrecognized key: "kind"/u,
    ],
    [{}, /codexCredential\.authFile Invalid input/u],
  ]) {
    const refused = await runnerFixture(t, { runner: { codexCredential } });
    await assert.rejects(
      runnerConfig(refused.paths.config),
      why,
      JSON.stringify(codexCredential),
    );
  }
});

/**
 * Catches the Codex file's refusal naming it as Claude's, or telling its
 * owner to save a Claude credential there.
 */
test("a Codex credential's file a job cannot be handed is refused as a Claude one's is, naming the Codex auth file and how to make one", async (t) => {
  const { home } = await runnerFixture(t);
  const uid = /** @type {() => number} */ (process.getuid)();
  const file = join(home, ".codex", "auth.json");
  const codex = runnerCredentialDescribed(subscription, "Codex");
  assert.equal(
    await credentialFileRefusal(codex, file, { uid, home }),
    `the Codex auth file ${file} cannot be found; run codex login, which writes it to ~/.codex/auth.json`,
  );
  await ownerOnly(file, "");
  assert.equal(
    await credentialFileRefusal(codex, file, { uid, home }),
    `the Codex auth file ${file} is empty; run codex login, which writes it to ~/.codex/auth.json`,
  );
  assert.deepEqual(
    runnerCredentialDescribed(subscription, "Claude"),
    claudeCredentialDescribed(subscription),
  );
});

test("a token file anyone else can read, that is empty, missing, or another user's, is refused", async (t) => {
  const { home, tokenFile } = await runnerFixture(t);
  const uid = /** @type {() => number} */ (process.getuid)();
  /** @param {string} file */
  const refusal = async (file, runner = { uid, home }) =>
    (await credentialFileRefusal(
      claudeCredentialDescribed(subscription),
      file,
      runner,
    )) ?? "";
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
      await credentialFileRefusal(
        claudeCredentialDescribed(/** @type {any} */ (setting)),
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
    const handed = runnerCredentialsHanded(read);
    assert.equal(
      handed.tokenFile,
      rest.tokenFile ?? rest.apiKeyFile ?? rest.credentialsFile,
    );
    assert.equal(handed.claudeCredential.kind, kind);
  }
  const { paths, tokenFile } = await runnerFixture(t);
  assert.deepEqual(runnerCredentialsHanded(await runnerConfig(paths.config)), {
    tokenFile,
    claudeCredential: subscription,
    agentCredentialFiles: {},
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

test("concurrencyMax may be 0 beside sessions, for a runner that takes sessions alone, and not where sessionsMax is 0 too", async (t) => {
  for (const sessions of [{}, { sessionsMax: 1 }]) {
    const { paths } = await runnerFixture(t, {
      runner: { concurrencyMax: 0, ...sessions },
    });
    const config = await runnerConfig(paths.config);
    assert.equal(config.concurrencyMax, 0);
    assert.equal(config.sessionsMax, sessions.sessionsMax ?? 2);
  }
  const { paths } = await runnerFixture(t, {
    runner: { concurrencyMax: 0, sessionsMax: 0 },
  });
  await assert.rejects(runnerConfig(paths.config), {
    message: `runner configuration ${paths.config}: concurrencyMax is 0 and so is sessionsMax, so this runner would take no work`,
  });
});

test("a pool's entry in pools sets its own service's limits in place of the file's, each it names, and no other pool's", async (t) => {
  const pools = {
    "vteng.chuggy.lead": { concurrencyMax: 0, sessionsMax: 1 },
    "vteng.chuggy.builds": { sessionsMax: 0 },
  };
  const { paths } = await runnerFixture(t, {
    runner: { concurrencyMax: 2, pools },
  });
  const config = await runnerConfig(paths.config);
  assert.deepEqual(config.pools, pools);
  /** @type {[string, {concurrencyMax: number, sessionsMax: number}, string][]} */
  const cases = [
    [
      "vteng.chuggy.lead",
      { concurrencyMax: 0, sessionsMax: 1 },
      "concurrencyMax 0, sessionsMax 1, as pools.vteng.chuggy.lead sets them",
    ],
    [
      "vteng.chuggy.builds",
      { concurrencyMax: 2, sessionsMax: 0 },
      "concurrencyMax 2, sessionsMax 0, as pools.vteng.chuggy.builds sets them",
    ],
    [
      "vteng.28_3ahttps_3a_2f_2fauth_2echuggy_2eexample_2fmember",
      { concurrencyMax: 2, sessionsMax: 2 },
      "concurrencyMax 2, sessionsMax 2",
    ],
    [
      "vteng.chuggy",
      { concurrencyMax: 2, sessionsMax: 2 },
      "concurrencyMax 2, sessionsMax 2",
    ],
    [
      "constructor",
      { concurrencyMax: 2, sessionsMax: 2 },
      "concurrencyMax 2, sessionsMax 2",
    ],
  ];
  for (const [name, limits, line] of cases) {
    const poolFile = `${paths.pools}/${name}.json`;
    assert.deepEqual(runnerPoolLimits(config, poolFile), limits, name);
    assert.equal(runnerConfigLimits(config, poolFile), line, name);
  }
});

test("a pool's entry is refused where it leaves that pool's service no work, whichever limit it takes from the file, or names a key a pool's limits do not have", async (t) => {
  const refusal =
    "pools.vteng.chuggy.lead leaves this pool's service concurrencyMax 0 and sessionsMax 0, so it would take no work";
  /** @type {[Record<string, unknown>, string][]} */
  const refused = [
    [
      { pools: { "vteng.chuggy.lead": { concurrencyMax: 0, sessionsMax: 0 } } },
      refusal,
    ],
    [
      { sessionsMax: 0, pools: { "vteng.chuggy.lead": { concurrencyMax: 0 } } },
      refusal,
    ],
    [
      {
        concurrencyMax: 0,
        sessionsMax: 1,
        pools: { "vteng.chuggy.lead": { sessionsMax: 0 } },
      },
      refusal,
    ],
    [
      { pools: { "vteng.chuggy.lead": { timeoutSecsMax: 60 } } },
      'pools.vteng.chuggy.lead Unrecognized key: "timeoutSecsMax"',
    ],
    [
      { pools: { "vteng.chuggy.lead": { concurrencyMax: -1 } } },
      "pools.vteng.chuggy.lead.concurrencyMax Too small: expected number to be >=0",
    ],
  ];
  for (const [runner, why] of refused) {
    const { paths } = await runnerFixture(t, { runner });
    await assert.rejects(runnerConfig(paths.config), {
      message: `runner configuration ${paths.config}: ${why}`,
    });
  }
  const { paths } = await runnerFixture(t, {
    runner: {
      concurrencyMax: 0,
      sessionsMax: 1,
      pools: { "vteng.chuggy.builds": { concurrencyMax: 2, sessionsMax: 0 } },
    },
  });
  assert.deepEqual((await runnerConfig(paths.config)).pools, {
    "vteng.chuggy.builds": { concurrencyMax: 2, sessionsMax: 0 },
  });
});

test("a job's image this runner pulled is kept a week unused unless the file says otherwise, and 0 keeps it", async (t) => {
  for (const imageUnusedSecsMax of [0, 86_400]) {
    const { paths } = await runnerFixture(t, {
      runner: { imageUnusedSecsMax },
    });
    assert.equal(
      (await runnerConfig(paths.config)).imageUnusedSecsMax,
      imageUnusedSecsMax,
    );
  }
  for (const imageUnusedSecsMax of [-1, 1.5, "604800"]) {
    const { paths } = await runnerFixture(t, {
      runner: { imageUnusedSecsMax },
    });
    await assert.rejects(runnerConfig(paths.config), /imageUnusedSecsMax/u);
  }
});

test("what the VM keeps free of its disk and of its memory, and what it reserves of that memory from jobs, is any whole GiB the file sets, 0 among them", async (t) => {
  const most = Math.floor(Number.MAX_SAFE_INTEGER / 2 ** 30);
  for (const key of /** @type {const} */ ([
    "diskFreeGibMin",
    "memoryFreeGibMin",
    "memoryReservedGib",
  ])) {
    for (const gib of [0, 50, most]) {
      const { paths } = await runnerFixture(t, { runner: { [key]: gib } });
      assert.equal((await runnerConfig(paths.config))[key], gib);
    }
    for (const gib of [-1, 1.5, "20", most + 1]) {
      const { paths } = await runnerFixture(t, { runner: { [key]: gib } });
      await assert.rejects(runnerConfig(paths.config), new RegExp(key, "u"));
    }
  }
});

test("a file may declare what its Mac meets, read as written, and a platform, a token no requirement can name, or one named twice is refused, naming where", async (t) => {
  const { paths } = await runnerFixture(t, {
    runner: { capabilities: ["gpu", "Tool:Xcode"] },
  });
  assert.deepEqual((await runnerConfig(paths.config)).capabilities, [
    "gpu",
    "Tool:Xcode",
  ]);
  for (const [capabilities, why] of [
    [
      ["gpu", "Platform:Linux:Arm64"],
      /capabilities\.1 is a platform, which the runner finds of this machine/u,
    ],
    [["gpu", "gpu"], /capabilities\.1 is named by an earlier entry/u],
    [["no spaces"], /capabilities\.0 /u],
  ]) {
    const refused = await runnerFixture(t, { runner: { capabilities } });
    await assert.rejects(
      runnerConfig(refused.paths.config),
      why,
      JSON.stringify(capabilities),
    );
  }
});

test("a directory is not a runner configuration", async (t) => {
  const { paths } = await runnerFixture(t, { runner: undefined });
  await mkdir(paths.config, { recursive: true, mode: 0o700 });
  await assert.rejects(runnerConfig(paths.config), /is not a file/u);
});
