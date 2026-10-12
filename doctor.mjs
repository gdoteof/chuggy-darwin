/**
 * What `doctor` checks, in the order a run depends on them, each answered as
 * passed or not with what was found. It changes nothing: a missing network is
 * reported for a run to make, and its one poll names nothing held and wants
 * nothing, which the plane answers without granting or releasing a lease.
 *
 * Beside what a run needs, it checks what only a Mac gets wrong: that docker's
 * VM still runs the platform the pool registered, which a VM started again
 * with another architecture would not, and whether an agent serves the pool.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  listArgv,
  networkInspectArgv,
} from "@chuggy/worker-core/engineArgv.mjs";
import {
  engineFailure,
  engineFailureLine,
} from "@chuggy/worker-core/engineErrors.mjs";
import { poolCredentials } from "@chuggy/worker-core/poolCredentials.mjs";
import {
  poolIdentityPersonal,
  poolLabelValue,
} from "@chuggy/worker-core/poolIdentity.mjs";

import {
  launchAgentFileName,
  launchAgentLabel,
  launchAgentPoolFile,
} from "./launchAgent.mjs";
import {
  dockerEndpoint,
  dockerMachine,
  poolRuntimeDirectory,
  poolSocket,
  vmPlatform,
} from "./runner.mjs";
import {
  claudeTokenFileRefusal,
  runnerConfig,
  runnerConfigLimits,
} from "./runnerConfig.mjs";

/**
 * @typedef {import("@chuggy/worker-core/poolCredentials.mjs").PoolCredentials} PoolCredentials
 * @typedef {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient} WorkerPoolClient
 * @typedef {import("@chuggy/worker-core/engine.mjs").Engine} Engine
 * @typedef {import("./runnerConfig.mjs").RunnerConfig} RunnerConfig
 * @typedef {import("./runnerPaths.mjs").RunnerPaths} RunnerPaths
 *
 * @typedef {{check: string, passed: boolean, detail: string, warning?: true}} DoctorFinding a warning passes, and is printed as one
 *
 * @typedef {object} DoctorParts what a run would reach, built from what was read
 * @property {() => Engine} engine
 * @property {(credentials: PoolCredentials) => WorkerPoolClient["tokens"]} tokens
 * @property {(credentials: PoolCredentials) => WorkerPoolClient["plane"]} plane
 *
 * @typedef {object} DoctorInput
 * @property {string} poolFile
 * @property {RunnerPaths} paths
 * @property {number} uid this process's
 * @property {string} home the home docker's VM shares
 * @property {DoctorParts} parts
 */

/**
 * Runs one check: a probe answers what it found, or throws what is wrong.
 *
 * @template T
 * @param {DoctorFinding[]} findings
 * @param {string} check
 * @param {() => Promise<[T, string]>} probe
 * @returns {Promise<T | undefined>}
 */
async function checked(findings, check, probe) {
  try {
    const [value, detail] = await probe();
    findings.push({ check, passed: true, detail });
    return value;
  } catch (failure) {
    const detail = failure instanceof Error ? failure.message : String(failure);
    findings.push({ check, passed: false, detail });
    return undefined;
  }
}

/**
 * @param {DoctorInput} input
 * @param {PoolCredentials} credentials
 * @param {RunnerConfig} config
 * @param {DoctorFinding[]} findings
 */
async function engineChecks(input, credentials, config, findings) {
  const engine = input.parts.engine();
  const machine = await checked(findings, "docker", async () => {
    const endpoint = await dockerEndpoint(engine);
    const vm = await dockerMachine(engine);
    const listed = await engine.exec(listArgv(poolLabelValue(credentials)));
    if (listed.code !== 0) throw new Error(engineFailureLine(listed));
    const count = listed.stdout.split("\n").filter((id) => id.trim()).length;
    return [
      vm,
      `at ${endpoint}, its VM ${vm.arch} with ${String(vm.size.cpuMillis / 1000)} CPUs and ${String(vm.size.memoryMib)} MiB, listing ${String(count)} of this pool's containers`,
    ];
  });
  if (machine === undefined) return;
  await checked(findings, "platform", async () => {
    const platform = vmPlatform(machine.arch);
    if (platform === undefined)
      throw new Error(`docker's VM is ${machine.arch}, which no pool runs`);
    if (!credentials.capabilities.includes(platform))
      throw new Error(
        `docker's VM runs ${platform}, and the pool registered ${credentials.capabilities.join(", ")}; start Colima with the architecture it registered, or register the pool again`,
      );
    return [true, `docker's VM runs ${platform}, as the pool registered`];
  });
  await checked(findings, "job network", async () => {
    const inspected = await engine.exec(networkInspectArgv(config.network));
    if (inspected.code === 0) return [true, `${config.network} is present`];
    if (engineFailure(inspected) === "NotFound")
      return [true, `${config.network} is missing, and a run makes it`];
    throw new Error(engineFailureLine(inspected));
  });
}

/**
 * @param {DoctorInput} input
 * @param {PoolCredentials} credentials
 * @param {DoctorFinding[]} findings
 */
async function planeChecks(input, credentials, findings) {
  const token = await checked(findings, "pool token", async () => {
    const acquired = await input.parts.tokens(credentials).acquire();
    if (acquired.acquired !== "Token") throw new Error(acquired.evidence);
    return [acquired.token, `issued by ${credentials.tokenUrl}`];
  });
  if (token === undefined) return;
  await checked(findings, "plane", async () => {
    const polled = await input.parts.plane(credentials).poll(token, [], 0, 0);
    if (polled.polled === "Stale")
      throw new Error("the plane rejected a token the issuer had just issued");
    if (polled.polled !== "Reconciled") throw new Error(polled.evidence);
    return [true, `${credentials.planeUrl} answered a poll`];
  });
}

/**
 * Whether an agent serves the pool file, which a pool run from a terminal
 * need not have, so its absence is a warning.
 *
 * @param {DoctorInput} input
 * @returns {Promise<DoctorFinding>}
 */
async function agentFinding(input) {
  const check = "launchd agent";
  let plist;
  try {
    plist = join(
      input.paths.agents,
      launchAgentFileName(launchAgentLabel(input.poolFile)),
    );
  } catch (failure) {
    return {
      check,
      passed: false,
      detail: failure instanceof Error ? failure.message : String(failure),
    };
  }
  const text = await readFile(plist, "utf8").catch(() => undefined);
  if (text !== undefined && launchAgentPoolFile(text) === input.poolFile)
    return { check, passed: true, detail: `${plist} serves this pool file` };
  return {
    check,
    passed: true,
    warning: true,
    detail:
      text === undefined
        ? `none; install-agent writes ${plist}`
        : `${plist} serves another pool file`,
  };
}

/** @param {DoctorFinding} finding */
export function findingLine(finding) {
  const label =
    finding.warning === true ? "warn" : finding.passed ? "ok  " : "FAIL";
  return `${label}  ${finding.check}: ${finding.detail}`;
}

/**
 * @param {DoctorInput} input
 * @returns {Promise<DoctorFinding[]>}
 */
export async function doctorFindings(input) {
  /** @type {DoctorFinding[]} */
  const findings = [];
  const credentials = await checked(findings, "pool file", async () => {
    const read = await poolCredentials(input.poolFile);
    return [
      read,
      `${input.poolFile} names ${poolIdentityPersonal(read) ? "personal runner" : "pool"} ${poolLabelValue(read)}`,
    ];
  });
  const config = await checked(findings, "runner configuration", async () => {
    const read = await runnerConfig(input.paths.config);
    return [read, `${input.paths.config}: ${runnerConfigLimits(read)}`];
  });
  if (credentials !== undefined)
    await checked(findings, "control socket", async () => [
      true,
      poolSocket(poolRuntimeDirectory(input.paths, credentials)),
    ]);
  if (config !== undefined)
    await checked(findings, "Claude token file", async () => {
      const refusal = await claudeTokenFileRefusal(config.claudeTokenFile, {
        uid: input.uid,
        home: input.home,
      });
      if (refusal !== undefined) throw new Error(refusal);
      return [true, `${config.claudeTokenFile}, this runner's own`];
    });
  findings.push(await agentFinding(input));
  if (credentials === undefined) return findings;
  if (config !== undefined)
    await engineChecks(input, credentials, config, findings);
  await planeChecks(input, credentials, findings);
  return findings;
}
