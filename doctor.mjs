/**
 * What `doctor` checks, in the order a run depends on them, each answered as
 * passed or not with what was found. It changes nothing: a missing network is
 * reported for a run to make, and its one poll names nothing held, wants
 * nothing and advertises nothing, which the plane answers without granting or
 * releasing a lease or changing what the pool advertised.
 *
 * Beside what a run needs, it says what a run advertises, whose platforms are
 * whichever docker's VM runs when the run starts, warning where an Apple
 * silicon Mac's VM runs no amd64 through Rosetta, and whether an agent serves
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
import { jobAgentCapability } from "@chuggy/worker-core/job.mjs";
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
  rosettaPlatform,
  runnerCapabilities,
  runnerReleasePrefix,
  vmPlatformsFound,
} from "./runner.mjs";
import {
  codexCredentialDescribed,
  credentialFileRefusal,
  runnerClaudeCredential,
  runnerCodexAgent,
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
 * @property {(config: RunnerConfig) => import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolUpdates} updates the update a run would make of its runner
 *
 * @typedef {object} DoctorInput
 * @property {string} poolFile
 * @property {RunnerPaths} paths
 * @property {number} uid this process's
 * @property {string} home the home docker's VM shares
 * @property {string | undefined} path this process's PATH
 * @property {(file: string) => Promise<string | undefined>} agentVersion what an agent's command, `claude` or `codex`, says its version is
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

/** The cap on asking an agent's command its version, which guards a hung one and not a slow one. */
const agentVersionTimeoutMs = 30_000;

/**
 * What an agent's command says its version is, the first line it prints, or
 * nothing where it prints none. It is run with `execFile`, never a shell.
 *
 * @param {string} file
 * @returns {Promise<string | undefined>}
 */
export function agentVersionAsked(file) {
  return new Promise((resolve) => {
    execFile(
      file,
      ["--version"],
      { timeout: agentVersionTimeoutMs, encoding: "utf8" },
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
 * The agent's command a job on the Mac itself runs, as the PATH it is started
 * with finds it, or why there is none: a warning, which passes, since a job
 * that runs another agent needs none.
 *
 * @param {DoctorInput} input
 * @param {RunnerConfig} config
 * @param {string} command `claude` or `codex`
 * @param {string} runtime what the command is, as a person names it
 * @returns {Promise<{found: string} | {missing: string}>}
 */
async function hostAgentFound(input, config, command, runtime) {
  const [path, whose] = await hostJobPath(input, config);
  for (const directory of path.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const file = join(directory, command);
    try {
      await access(file, constants.X_OK);
      if (!(await stat(file)).isFile()) continue;
    } catch {
      continue;
    }
    const version = await input.agentVersion(file);
    return {
      found: `a job on the Mac itself runs ${file}, ${version ?? "which says no version"}, found on ${whose}`,
    };
  }
  return {
    missing: `no ${command} is on ${whose}, ${path === "" ? "which is empty" : path}, so a job on the Mac itself runs no ${runtime}`,
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
  let refusal = await credentialFileRefusal(
    claudeCredentialDescribed(setting),
    file,
    { uid: input.uid, home: input.home },
  );
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
  return hostAgentFinding(
    check,
    detail,
    await hostAgentFound(input, config, "claude", "Claude Code"),
  );
}

/**
 * A credential's finding, which passed, with the agent's command a job on
 * the Mac itself runs, warned of where there is none.
 *
 * @param {string} check
 * @param {string} detail
 * @param {{found: string} | {missing: string}} command
 * @returns {DoctorFinding}
 */
function hostAgentFinding(check, detail, command) {
  return "found" in command
    ? { check, passed: true, detail: `${detail}; ${command.found}` }
    : {
        check,
        passed: true,
        warning: true,
        detail: `${detail}; ${command.missing}`,
      };
}

/** The capability a pool advertises to be handed jobs requiring Codex. */
const codexCapability = jobAgentCapability(runnerCodexAgent);

/**
 * The Codex credential the runner's file names, its file held to a run's
 * rule and read as a JSON object, and whether a pool here advertises
 * `Agent:Codex`, which is what brings a job its file; on a pool registered
 * with `--host`, the `codex` a job on the Mac itself runs. Where the file
 * names none, a warning only where this pool advertises Codex, and otherwise
 * nothing.
 *
 * @param {DoctorInput} input
 * @param {RunnerConfig} config
 * @param {PoolCredentials | undefined} credentials this pool's
 * @returns {Promise<DoctorFinding | undefined>}
 */
async function codexCredentialFinding(input, config, credentials) {
  const check = "Codex credential";
  const advertised =
    credentials === undefined
      ? []
      : advertisedAgents(input, config, credentials);
  if (config.codexCredential === undefined)
    return advertised.includes(codexCapability)
      ? {
          check,
          passed: true,
          warning: true,
          detail: `this pool advertises ${codexCapability} and ${input.paths.config} names no codexCredential, so its Codex jobs are handed the Claude credential's file; add codexCredential to hand them a Codex auth.json`,
        }
      : undefined;
  const file = config.codexCredential.authFile;
  const refusal =
    (await credentialFileRefusal(codexCredentialDescribed, file, {
      uid: input.uid,
      home: input.home,
    })) ?? (await codexAuthRefusal(file));
  if (refusal !== undefined) return { check, passed: false, detail: refusal };
  const detail = `the ${codexCredentialDescribed.label} ${file}, this runner's own`;
  if (!(await codexAdvertised(input, config, advertised)))
    return {
      check,
      passed: true,
      warning: true,
      detail: `${detail}; no pool here advertises ${codexCapability}, since no images entry declares it and no pool here was registered with --host, so no job requiring ${codexCapability} reaches this runner`,
    };
  if (credentials?.host !== true) return { check, passed: true, detail };
  return hostAgentFinding(
    check,
    detail,
    await hostAgentFound(input, config, "codex", "Codex"),
  );
}

/**
 * Why the Codex credential's file is no `auth.json` a job's core reads, or
 * nothing: it must be a JSON object. Neither what it holds nor the parser's
 * message is named, since either may quote the credential.
 *
 * @param {string} file
 * @returns {Promise<string | undefined>}
 */
async function codexAuthRefusal(file) {
  const { label, remedy } = codexCredentialDescribed;
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return `the ${label} ${file} cannot be read`;
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    document = undefined;
  }
  return typeof document === "object" &&
    document !== null &&
    !Array.isArray(document)
    ? undefined
    : `the ${label} ${file} is not a JSON object; ${remedy}`;
}

/**
 * What a pool's run advertises but the platforms docker's VM runs, which
 * every pool here shares; nothing where its run would be refused.
 *
 * @param {DoctorInput} input
 * @param {RunnerConfig} config
 * @param {PoolCredentials} credentials
 */
function advertisedAgents(input, config, credentials) {
  try {
    return runnerCapabilities({ credentials, config, paths: input.paths }, []);
  } catch {
    return [];
  }
}

/**
 * Whether this pool's run or that of another pool file in the pools
 * directory advertises `Agent:Codex`; a file that cannot be read, or whose
 * run would be refused, advertises nothing.
 *
 * @param {DoctorInput} input
 * @param {RunnerConfig} config
 * @param {readonly string[]} advertised what this pool's run advertises
 */
async function codexAdvertised(input, config, advertised) {
  if (advertised.includes(codexCapability)) return true;
  for (const name of await readdir(input.paths.pools).catch(() => [])) {
    const credentials = await poolCredentials(
      join(input.paths.pools, name),
    ).catch(() => undefined);
    if (
      credentials !== undefined &&
      advertisedAgents(input, config, credentials).includes(codexCapability)
    )
      return true;
  }
  return false;
}

/**
 * What this pool's run advertises on each poll, as a run finds it when it
 * starts, and where what is neither a platform nor an agent comes from:
 * warned of where an arm64 VM takes no amd64 work, since most work asks for
 * it, and failed where a run would be refused.
 *
 * @param {DoctorInput} input
 * @param {PoolCredentials} credentials
 * @param {RunnerConfig} config
 * @param {{arch: string, name: string}} machine docker's VM
 * @returns {Promise<DoctorFinding>}
 */
async function capabilitiesFinding(input, credentials, config, machine) {
  const check = "capabilities";
  let vm;
  let advertised;
  try {
    vm = await vmPlatformsFound(machine, input.parts.colima());
    advertised = runnerCapabilities(
      { credentials, config, paths: input.paths },
      vm.platforms,
    );
  } catch (failure) {
    return {
      check,
      passed: false,
      detail: failure instanceof Error ? failure.message : String(failure),
    };
  }
  const found = [
    vm.platforms.length === 1
      ? "docker's VM's platform"
      : "docker's VM's platforms",
    ...(credentials.host === true ? ["the Mac's"] : []),
    `the agents ${input.paths.config} can run`,
  ].join(", ");
  const rest =
    config.capabilities === undefined
      ? "the rest of what the pool was registered with"
      : "its capabilities";
  const detail = `a run advertises ${advertised.join(", ")} on each poll: ${found}, and ${rest}`;
  const amd64 = amd64Unrun(vm.rosetta);
  return amd64 === undefined
    ? { check, passed: true, detail }
    : { check, passed: true, warning: true, detail: `${detail}; ${amd64}` };
}

/**
 * Why an arm64 VM takes no amd64 work, and what would have it take some, or
 * nothing where it takes it or is no arm64 VM.
 *
 * @param {{rosetta: boolean} | {unknown: string} | undefined} rosetta what was found of Rosetta in an arm64 VM
 */
function amd64Unrun(rosetta) {
  if (rosetta === undefined || ("rosetta" in rosetta && rosetta.rosetta))
    return undefined;
  const unrun = `so no job asking for ${rosettaPlatform} reaches this runner`;
  if ("unknown" in rosetta)
    return `whether docker's VM runs amd64 through Rosetta could not be found, ${unrun}: ${rosetta.unknown}`;
  return `docker's VM runs no amd64 through Rosetta, ${unrun}; install Rosetta with \`softwareupdate --install-rosetta --agree-to-license\`, then stop Colima and start it with \`colima start --vz-rosetta\``;
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
  findings.push(await capabilitiesFinding(input, credentials, config, machine));
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

/**
 * A release one patch above this copy, from its own release downloads, as
 * chuggy would name the next: the core's refusal of it is only of what keeps
 * this install from taking a release.
 *
 * @param {import("@chuggy/worker-core/runnerUpdate.mjs").RunnerIdentity} runner
 */
function nextRelease(runner) {
  const [major, minor, patch] = runner.version.split(".").map(Number);
  const version = `${String(major)}.${String(minor)}.${String(patch + 1)}`;
  return {
    package: runner.package,
    version,
    url: `${runnerReleasePrefix}v${version}/${runner.package}-${version}.tgz`,
    integrity: `sha512-${"A".repeat(86)}==`,
  };
}

/**
 * Whether the runner updates itself and, where it does, whether this install
 * can take a release: one that npm did not install globally, or that this
 * user cannot write, cannot, and is warned of.
 *
 * @param {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolUpdates} updates
 * @returns {Promise<DoctorFinding>}
 */
async function updatesFinding(updates) {
  const check = "updates";
  if (!updates.on)
    return {
      check,
      passed: true,
      detail: "off: the runner's file sets autoUpdate to false",
    };
  const refusal = await updates.updater.refusal(
    nextRelease(updates.updater.runner),
  );
  if (refusal === undefined)
    return {
      check,
      passed: true,
      detail: "on: a run installs the release chuggy names",
    };
  return {
    check,
    passed: true,
    warning: true,
    detail: `on, but this install cannot take a release: ${refusal}; install it with npm under a prefix you own, such as Homebrew's`,
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
  const config = await runnerConfigChecked(input, findings);
  if (credentials !== undefined)
    await checked(findings, "control socket", async () => [
      true,
      poolSocket(poolRuntimeDirectory(input.paths, credentials)),
    ]);
  if (config !== undefined) {
    findings.push(
      await claudeCredentialFinding(input, config, credentials?.host === true),
    );
    const codex = await codexCredentialFinding(input, config, credentials);
    if (codex !== undefined) findings.push(codex);
  }
  if (credentials?.host === true && config !== undefined)
    await checked(findings, "host jobs", async () => [
      true,
      hostJobsChecked(config),
    ]);
  findings.push(await agentFinding(input));
  if (config !== undefined)
    findings.push(await updatesFinding(input.parts.updates(config)));
  if (credentials === undefined) return findings;
  if (config !== undefined)
    await engineChecks(input, credentials, config, findings);
  await planeChecks(input, credentials, findings);
  return findings;
}
