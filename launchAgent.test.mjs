import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerPoolFileName } from "@chuggy/worker-core/register.mjs";

import {
  launchAgentBackground,
  launchAgentBaseCharsMax,
  launchAgentCommands,
  launchAgentDesktop,
  launchAgentLabel,
  launchAgentPath,
  launchAgentPlist,
  launchAgentPoolFile,
  launchAgentRestart,
  launchAgentRunning,
  shellQuoted,
} from "./launchAgent.mjs";

test("every pool file register names under the agent bound leaves its property list's name within a file name", () => {
  const tenant = "t".repeat(
    launchAgentBaseCharsMax - "p".length - "shame".length - "..".length,
  );
  const longest = registerPoolFileName(
    { tenant, project: "p", pool: "shame" },
    launchAgentBaseCharsMax,
  );
  assert.equal(longest, `${tenant}.p.shame.json`);
  assert.equal(
    `chuggy-darwin.${longest.slice(0, -".json".length)}.plist`.length,
    255,
  );
  assert.match(
    registerPoolFileName(
      { tenant: `${tenant}t`, project: "p", pool: "shame" },
      launchAgentBaseCharsMax,
    ),
    /^pool-[0-9a-f]{20}\.json$/u,
  );
});

test("an agent is labelled for every personal runner's file register names, by name or by digest", () => {
  const owner = "28:https://auth.chuggy.example/0f3c9a52-member";
  const labels = ["vteng", "t".repeat(launchAgentBaseCharsMax)].map((tenant) =>
    launchAgentLabel(
      `/p/${registerPoolFileName({ kind: "Personal", tenant, owner }, launchAgentBaseCharsMax)}`,
    ),
  );
  assert.equal(
    labels[0],
    "chuggy-darwin.vteng.28_3ahttps_3a_2f_2fauth_2echuggy_2eexample_2f0f3c9a52-member",
  );
  assert.match(labels[1], /^chuggy-darwin\.personal-[0-9a-f]{20}$/u);
});

test("an agent is labelled for its pool file, and a name a label is not given here is refused", () => {
  assert.equal(
    launchAgentLabel(
      "/Users/shame/.config/chuggy/pools/vteng.chuggy.shame.json",
    ),
    "chuggy-darwin.vteng.chuggy.shame",
  );
  for (const base of ["_c3_a9t", "-x", ".hidden"])
    assert.equal(launchAgentLabel(`/p/${base}.json`), `chuggy-darwin.${base}`);
  for (const file of ["/p/a b.json", "/p/a&b.json", "/p/é.json"])
    assert.throws(
      () => launchAgentLabel(file),
      /is not named as an agent can be/u,
    );
  assert.throws(
    () =>
      launchAgentLabel(`/p/${"a".repeat(launchAgentBaseCharsMax + 1)}.json`),
    /longer than a Mac takes/u,
  );
});

test("an agent restarts its runner after any exit but 0, and its pool file and PATH read back through the escaping", () => {
  const poolFile = "/Users/a&b/<pools>/p.json";
  const path = "/usr/bin:/Users/a&b/<bin>:/opt/homebrew/bin";
  const plist = launchAgentPlist({
    label: "chuggy-darwin.p",
    node: "/opt/homebrew/bin/node",
    cli: "/opt/chuggy-darwin/cli.mjs",
    poolFile,
    path,
    log: "/Users/a/Library/Logs/chuggy-darwin/chuggy-darwin.p.log",
    background: false,
  });
  assert.match(
    plist,
    /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/u,
  );
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/u);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/u);
  assert.match(plist, /<key>Umask<\/key>\s*<integer>63<\/integer>/u);
  assert.ok(
    plist.includes("<string>/Users/a&amp;b/&lt;pools&gt;/p.json</string>"),
  );
  assert.equal(launchAgentPoolFile(plist), poolFile);
  assert.equal(launchAgentPoolFile("<plist/>"), undefined);
  assert.equal(launchAgentPath(plist), path);
  assert.equal(launchAgentPath("<plist/>"), undefined);
});

test("an argument the operator is told is quoted for a shell only where it must be", () => {
  assert.equal(shellQuoted("/Users/a/x.plist"), "/Users/a/x.plist");
  assert.equal(shellQuoted("/Users/a b/x.plist"), "'/Users/a b/x.plist'");
  assert.equal(shellQuoted("it's"), "'it'\\''s'");
});

/**
 * Catches a run started by hand, or by another pool's agent, told launchd
 * will restart it, or the pool's own agent told to be started by hand.
 */
test("a run is its pool's agent only where launchd named it by the label of that pool file's agent", () => {
  const poolFile = "/Users/you/.config/chuggy/pools/vteng.chuggy.shame.json";
  for (const [environment, running] of /** @type {const} */ ([
    [{ XPC_SERVICE_NAME: "chuggy-darwin.vteng.chuggy.shame" }, true],
    [{ XPC_SERVICE_NAME: "chuggy-darwin.vteng.chuggy.other" }, false],
    [{ XPC_SERVICE_NAME: "0" }, false],
    [{}, false],
  ]))
    assert.equal(launchAgentRunning(environment, poolFile), running);
  assert.equal(
    launchAgentRunning(
      { XPC_SERVICE_NAME: "chuggy-darwin.a b" },
      "/Users/you/a b.json",
    ),
    false,
  );
});

/** A background session's agent as `install-agent` writes one, but the session type. */
const agentWritten = {
  label: "chuggy-darwin.p",
  node: "/opt/homebrew/bin/node",
  cli: "/opt/chuggy-darwin/cli.mjs",
  poolFile: "/Users/a/.config/chuggy/pools/p.json",
  path: "/usr/bin:/opt/homebrew/bin",
  log: "/Users/a/Library/Logs/chuggy-darwin/chuggy-darwin.p.log",
};

test("only a background session's agent is limited to that session, reads back as one, and is loaded and restarted in launchd's user domain", () => {
  for (const [background, domain] of /** @type {const} */ ([
    [true, "user/501"],
    [false, "gui/501"],
  ])) {
    const plist = launchAgentPlist({ ...agentWritten, background });
    assert.equal(launchAgentBackground(plist), background);
    assert.equal(
      /LimitLoadToSessionType/u.test(plist),
      background,
      String(background),
    );
    const agent = { uid: 501, label: agentWritten.label, background };
    assert.deepEqual(
      launchAgentCommands({ ...agent, plist: "/Users/a/p.plist" }),
      [
        `launchctl bootout ${domain}/chuggy-darwin.p 2>/dev/null`,
        `launchctl bootstrap ${domain} /Users/a/p.plist`,
      ],
    );
    assert.equal(
      launchAgentRestart(agent),
      `launchctl kickstart -k ${domain}/chuggy-darwin.p`,
    );
  }
});

/**
 * Catches a desktop session found by asking about another domain, or found
 * where launchctl failed or is absent.
 */
test("the user has a desktop session only where launchctl finds their gui domain", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-darwin-launchctl-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const launchctl = join(directory, "launchctl");
  await writeFile(launchctl, '#!/bin/sh\n[ "$1 $2" = "print gui/501" ]\n');
  await chmod(launchctl, 0o755);
  assert.equal(await launchAgentDesktop(501, launchctl), true);
  assert.equal(await launchAgentDesktop(502, launchctl), false);
  assert.equal(await launchAgentDesktop(501, join(directory, "absent")), false);
});
