/**
 * A Mac's worth of files for a suite: a pool registration, the runner's file
 * and a Claude token file, each owner-only, under a home of their own. The
 * home is short, as a real one is, so a pool's control socket can be bound
 * under it.
 */

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { runnerPaths } from "./runnerPaths.mjs";

export const fixturePool = {
  tenant: "vteng",
  project: "chuggy",
  pool: "shame",
  capabilities: ["Platform:Linux:Arm64"],
  tokenUrl: "https://issuer.chuggy.example/oauth2/token",
  audience: "https://chuggy.example",
  planeUrl: "https://chuggy.example/pool",
  clientId: "pool-client",
  clientSecret: "pool-client-secret",
};

/**
 * @param {string} file
 * @param {string} text
 */
export async function ownerOnly(file, text) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text, { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}

/**
 * @param {import("node:test").TestContext} t
 * @param {{runner?: Record<string, unknown> | undefined, pool?: Record<string, unknown>}} documents
 */
export async function runnerFixture(t, documents = {}) {
  const home = await mkdtemp("/tmp/cdh-");
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = runnerPaths(home);
  const poolFile = await ownerOnly(
    join(paths.pools, "vteng.chuggy.shame.json"),
    JSON.stringify(documents.pool ?? fixturePool),
  );
  const tokenFile = await ownerOnly(
    join(home, ".claude-token"),
    "claude-token-fixture",
  );
  if (!("runner" in documents) || documents.runner !== undefined)
    await ownerOnly(
      paths.config,
      JSON.stringify({
        claudeTokenFile: tokenFile,
        timeoutSecsMax: 3600,
        outputBytesMax: 65536,
        ...documents.runner,
      }),
    );
  return { home, paths, poolFile, tokenFile };
}
