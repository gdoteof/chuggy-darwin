import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { colimaCli, colimaProfile, colimaVmArgv } from "./colimaVm.mjs";

test("docker's VM is Colima's default profile's by the name colima, another profile's by colima-<profile>, and no Colima VM by any other", () => {
  for (const [machine, profile] of [
    ["colima", "default"],
    ["colima-work", "work"],
    ["colima-x86.64_b", "x86.64_b"],
    ["docker-desktop", undefined],
    ["orbstack", undefined],
    ["colima-", undefined],
    ["colima-a b", undefined],
    ["colima-a;rm", undefined],
    ["lima-colima", undefined],
  ])
    assert.equal(colimaProfile(machine), profile, machine);
});

test("a command reaches the profile's VM through colima ssh, the colima on PATH, with no shell on the Mac between", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chuggy-darwin-colima-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const colima = join(directory, "colima");
  await writeFile(colima, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  await chmod(colima, 0o755);
  const answer = await colimaCli().exec(
    colimaVmArgv("work", ["df", "-P", "-k", "/var/lib/docker; true"]),
    { environment: { PATH: directory } },
  );
  assert.deepEqual(answer, {
    code: 0,
    stdout: [
      "ssh",
      "--profile",
      "work",
      "--",
      "df",
      "-P",
      "-k",
      "/var/lib/docker; true",
    ]
      .map((argument) => `${argument}\n`)
      .join(""),
    stderr: "",
  });
});
