/**
 * What `doctor` checks, in the order a run depends on them, each answered as
 * passed or not with what was found. It changes nothing: a missing network is
 * reported for a run to make, and its one poll names nothing held, wants
 * nothing and advertises nothing, which the plane answers without granting or
 * releasing a lease or changing what the pool advertised.
 *
 * Beside what a run needs, it says what a run advertises, whose platform is
 * whichever docker's VM runs when the run starts, and whether an agent serves
 * the pool.
 */

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

import {
  claudeCredentialDescribed,
  claudeCredentialFile,
  claudeCredentialRefusal,
  claudeCredentialSetting,
} from "@chuggy/worker-core/claudeCredential.mjs";
import {
  listArgv,
  networkInspectArgv,
} from "@chuggy/worker-core/engineArgv.mjs";
import {
  engineFailure,
  engineFailureLine,
} from "@chuggy/worker-core/engineErrors.mjs";
import {
  hostEnvironmentRefusal,
  hostTimeoutSecsMax,
} from "@chuggy/worker-core/hostBackend.mjs";
import { poolCredentials } from "@chuggy/worker-core/poolCredentials.mjs";
import {
  poolIdentityPersonal,
  poolLabelValue,
} from "@chuggy/worker-core/poolIdentity.mjs";

import { diskFloorSaid } from "./diskFree.mjs";
import {
  launchAgentFileName,
  launchAgentLabel,
  launchAgentPath,
  launchAgentPoolFile,
} from "./launchAgent.mjs";
import {
  dockerEndpoint,
  dockerMachine,
  poolRuntimeDirectory,
  poolSocket,
  runnerCapabilities,
} from "./runner.mjs";
import {
  claudeCredentialFileRefusal,
  runnerClaudeCredential,
  runnerConfig,
  runnerConfigLimits,
  runnerPoolName,
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
 * @property {() => import("./colimaVm.mjs").ColimaCli} colima
 * @property {(credentials: PoolCredentials) => WorkerPoolClient["tokens"]} tokens
 * @property {(credentials: PoolCredentials) => WorkerPoolClient["plane"]} plane
 *
 * @typedef {object} DoctorInput
 * @property {string} poolFile
 * @property {RunnerPaths} paths
 * @property {number} uid this process's
 * @property {string} home the home docker's VM shares
 * @property {string | undefined} path this process's PATH
 * @property {(file: string) => Promise<string | undefined>} claudeVersion what a `claude` says its version is
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
 * What a pool registered with `--host` runs on the Mac, or a throw naming what
 * in the runner's file no host job can run under.
 *
 * @param {RunnerConfig} config
 */
function hostJobsChecked(config) {
  const refusal = hostEnvironmentRefusal(config.environment);
  if (refusal !== undefined) throw new Error(refusal);
  if (config.timeoutSecsMax > hostTimeoutSecsMax)
    throw new Error(
      `timeoutSecsMax is at most ${String(hostTimeoutSecsMax)} for a job on the Mac itself`,
    );
  return "a job that pins no image and names the Mac's platform runs on the Mac itself, unisolated";
}

/** The cap on asking a `claude` its version, which guards a hung one and not a slow one. */
const claudeVersionTimeoutMs = 30_000;

/**
 * What a `claude` says its version is, the first line it prints, or nothing
 * where it prints none. It is run with `execFile`, never a shell.
 *
 * @param {string} file
 * @returns {Promise<string | undefined>}
 */
export function claudeVersionAsked(file) {
  return new Promise((resolve) => {
    execFile(
      file,
      ["--version"],
      { timeout: claudeVersionTimeoutMs, encoding: "utf8" },
      (error, stdout) => {
        const line = stdout.split("\n")[0].trim();
        resolve(error === null && line !== "" ? line : undefined);
      },
    );
  });
}

/**
 * The PATH a job on the Mac itself is started with, and whose it is: the
 * runner's file's, or the one the agent serving the pool file runs the runner
 * with, or where none serves it this process's own, as a run from this shell
 * would have.
 *
 * @param {DoctorInput} input
 * @param {RunnerConfig} config
 * @returns {Promise<[string, string]>}
 */
async function hostJobPath(input, config) {
  if (config.environment.PATH !== undefined)
    return [config.environment.PATH, "the PATH the runner's file sets"];
  const agent = await agentPlist(input).catch(() => undefined);
  const served =
    agent?.text !== undefined &&
    launchAgentPoolFile(agent.text) === input.poolFile
      ? launchAgentPath(agent.text)
      : undefined;
  if (served !== undefined)
    return [served, "the PATH the launchd agent runs the runner with"];
  return [input.path ?? "", "doctor's own PATH"];
}

/**
 * The `claude` a job on the Mac itself runs, as the PATH it is started with
 * finds it, or why there is none: a warning, which passes, since a job that
 * runs no Claude Code needs none.
 *
 * @param {DoctorInput} input
 * @param {RunnerConfig} config
 * @returns {Promise<{found: string} | {missing: string}>}
 */
async function hostClaudeFound(input, config) {
  const [path, whose] = await hostJobPath(input, config);
  for (const directory of path.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const file = join(directory, "claude");
    try {
      await access(file, constants.X_OK);
      if (!(await stat(file)).isFile()) continue;
    } catch {
      continue;
    }
    const version = await input.claudeVersion(file);
    return {
      found: `a job on the Mac itself runs ${file}, ${version ?? "which says no version"}, found on ${whose}`,
    };
  }
  return {
    missing: `no claude is on ${whose}, ${path === "" ? "which is empty" : path}, so a job on the Mac itself runs no Claude Code`,
  };
}

/**
 * The Claude credential the runner's file names, its file held to the rule a
 * run holds it to and then read, as only doctor reads it, and held to what a
 * file of its kind says. It names the kind and its settings and never what
 * the file holds, and on a pool registered with `--host` the `claude` a job
 * on the Mac itself runs.
 *
 * @param {DoctorInput} input
 * @param {RunnerConfig} config
 * @param {boolean} host whether a job may run on the Mac itself
 * @returns {Promise<DoctorFinding>}
 */
async function claudeCredentialFinding(input, config, host) {
  const check = "Claude credential";
  const credential = runnerClaudeCredential(config);
  const file = claudeCredentialFile(credential);
  const setting = claudeCredentialSetting(credential);
  const { label } = claudeCredentialDescribed(setting);
  let refusal = await claudeCredentialFileRefusal(setting, file, {
    uid: input.uid,
    home: input.home,
  });
  if (refusal === undefined)
    try {
      const text = (await readFile(file, "utf8")).trim();
      refusal = claudeCredentialRefusal(setting, text, file);
    } catch {
      refusal = `the ${label} ${file} cannot be read`;
    }
  if (refusal !== undefined) return { check, passed: false, detail: refusal };
  const named = [
    setting.kind,
    ...Object.entries(setting).flatMap(([key, value]) =>
      key === "kind" ? [] : [`${key} ${String(value)}`],
    ),
  ].join(", ");
  const detail = `${named}, from the ${label} ${file}, this runner's own`;
  if (!host) return { check, passed: true, detail };
  const claude = await hostClaudeFound(input, config);
  return "found" in claude
    ? { check, passed: true, detail: `${detail}; ${claude.found}` }
    : {
        check,
        passed: true,
        warning: true,
        detail: `${detail}; ${claude.missing}`,
      };
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
  await checked(findings, "capabilities", async () => {
    const advertised = runnerCapabilities(
      { credentials, config, paths: input.paths },
      machine.arch,
    );
    const found = [
      "docker's VM's platform",
      ...(credentials.host === true ? ["the Mac's"] : []),
      `the agents ${input.paths.config} can run`,
    ].join(", ");
    const rest =
      config.capabilities === undefined
        ? "the rest of what the pool was registered with"
        : "its capabilities";
    return [
      true,
      `a run advertises ${advertised.join(", ")} on each poll: ${found}, and ${rest}`,
    ];
  });
  await checked(findings, "job network", async () => {
    const inspected = await engine.exec(networkInspectArgv(config.network));
    if (inspected.code === 0) return [true, `${config.network} is present`];
    if (engineFailure(inspected) === "NotFound")
      return [true, `${config.network} is missing, and a run makes it`];
    throw new Error(engineFailureLine(inspected));
  });
  const disk = await diskFloorSaid(config, engine, input.parts.colima());
  findings.push(
    disk.warning
      ? {
          check: "disk floor",
          passed: true,
          warning: true,
          detail: disk.detail,
        }
      : { check: "disk floor", passed: true, detail: disk.detail },
  );
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
 * Where the agent named for the pool file is, and its text where there is a
 * file there, refused where the pool file's name makes no agent's.
 *
 * @param {DoctorInput} input
 * @returns {Promise<{plist: string, text: string | undefined}>}
 */
async function agentPlist(input) {
  const plist = join(
    input.paths.agents,
    launchAgentFileName(launchAgentLabel(input.poolFile)),
  );
  return { plist, text: await readFile(plist, "utf8").catch(() => undefined) };
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
  let text;
  try {
    ({ plist, text } = await agentPlist(input));
  } catch (failure) {
    return {
      check,
      passed: false,
      detail: failure instanceof Error ? failure.message : String(failure),
    };
  }
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

/**
 * The runner's file, read, and the limits it sets this pool's service, warned
 * of where an entry in `pools` names no pool file in the pools directory, so
 * that it limits no service.
 *
 * @param {DoctorInput} input
 * @param {DoctorFinding[]} findings
 */
async function runnerConfigChecked(input, findings) {
  const check = "runner configuration";
  let config;
  try {
    config = await runnerConfig(input.paths.config);
  } catch (failure) {
    findings.push({
      check,
      passed: false,
      detail: failure instanceof Error ? failure.message : String(failure),
    });
    return undefined;
  }
  const files = new Set(
    (await readdir(input.paths.pools).catch(() => [])).map((file) =>
      runnerPoolName(file),
    ),
  );
  files.add(runnerPoolName(input.poolFile));
  const unmatched = Object.keys(config.pools).filter(
    (name) => !files.has(name),
  );
  const detail = [
    `${input.paths.config}: ${runnerConfigLimits(config, input.poolFile)}`,
    ...unmatched.map(
      (name) =>
        `pools.${name} names no pool file in ${input.paths.pools}, so it limits no service`,
    ),
  ].join("; ");
  findings.push(
    unmatched.length === 0
      ? { check, passed: true, detail }
      : { check, passed: true, warning: true, detail },
  );
  return config;
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
  const config = await runnerConfigChecked(input, findings);
  if (credentials !== undefined)
    await checked(findings, "control socket", async () => [
      true,
      poolSocket(poolRuntimeDirectory(input.paths, credentials)),
    ]);
  if (config !== undefined)
    findings.push(
      await claudeCredentialFinding(input, config, credentials?.host === true),
    );
  if (credentials?.host === true && config !== undefined)
    await checked(findings, "host jobs", async () => [
      true,
      hostJobsChecked(config),
    ]);
  findings.push(await agentFinding(input));
  if (credentials === undefined) return findings;
  if (config !== undefined)
    await engineChecks(input, credentials, config, findings);
  await planeChecks(input, credentials, findings);
  return findings;
}
