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

import { ownerOnly, runnerFixture } from "./runner.fixture.mjs";
import { claudeTokenFileRefusal, runnerConfig } from "./runnerConfig.mjs";
import { runnerPaths } from "./runnerPaths.mjs";

test("the runner keeps its file, agents, logs, host jobs and runtime where a Mac keeps each, and pool files where chuggy-linux does", () => {
  assert.deepEqual(runnerPaths("/Users/shame"), {
    config:
      "/Users/shame/Library/Application Support/chuggy-darwin/runner.json",
    agents: "/Users/shame/Library/LaunchAgents",
    pools: "/Users/shame/.config/chuggy/pools",
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
    await claudeTokenFileRefusal(tokenFile, { uid, home }),
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
      /** @type {string} */ (await claudeTokenFileRefusal(file, { uid, home })),
      /is not under .*, or leads outside it, and .* is the only directory Colima shares with its VM by default/u,
      file,
    );
  const linkedWithin = join(home, "within");
  await symlink(tokenFile, linkedWithin);
  assert.equal(
    await claudeTokenFileRefusal(linkedWithin, { uid, home }),
    undefined,
  );
});

test("a token file anyone else can read, that is empty, missing, or another user's, is refused", async (t) => {
  const { home, tokenFile } = await runnerFixture(t);
  const uid = /** @type {() => number} */ (process.getuid)();
  assert.match(
    /** @type {string} */ (
      await claudeTokenFileRefusal(tokenFile, { uid: uid + 1, home })
    ),
    /is owned by uid \d+, not by this runner's uid \d+$/u,
  );
  assert.match(
    /** @type {string} */ (
      await claudeTokenFileRefusal(join(home, "absent"), { uid, home })
    ),
    /cannot be found/u,
  );
  await writeFile(tokenFile, "");
  assert.match(
    /** @type {string} */ (
      await claudeTokenFileRefusal(tokenFile, { uid, home })
    ),
    /is empty$/u,
  );
  await chmod(tokenFile, 0o644);
  assert.match(
    /** @type {string} */ (
      await claudeTokenFileRefusal(tokenFile, { uid, home })
    ),
    /is mode 644/u,
  );
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
