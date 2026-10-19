import assert from "node:assert/strict";
import test from "node:test";

import { registerPoolFileName } from "@chuggy/worker-core/register.mjs";

import {
  launchAgentBaseCharsMax,
  launchAgentLabel,
  launchAgentPath,
  launchAgentPlist,
  launchAgentPoolFile,
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
