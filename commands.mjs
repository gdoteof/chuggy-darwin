/**
 * The `chuggy-darwin` commands. Each answers an exit status: 0 done, 1 failed,
 * 2 asked wrongly. `run` ends without failing only when the plane denies the
 * pool, which is done, since nothing but a new registration brings the pool
 * back, and ends `updatedExitStatus` when it installed a release of itself to
 * run again on. `once` fails on any pass that did not reconcile, a denial
 * among them.
 */

import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

import { controlAsked, controlServer } from "@chuggy/worker-core/control.mjs";
import { localToolAskRefusal } from "@chuggy/worker-core/localTools.mjs";
import { poolCredentials } from "@chuggy/worker-core/poolCredentials.mjs";
import { poolIdentityPersonal } from "@chuggy/worker-core/poolIdentity.mjs";
import { workerPoolClientPass } from "@chuggy/worker-core/poolLoop.mjs";
import {
  poolRunnerPassLine,
  poolRunnerPlane,
  poolRunnerTokens,
} from "@chuggy/worker-core/poolRunner.mjs";
import {
  registerAgents,
  registerAskedChecked,
  registerPoolDirectory,
  registerPoolFileWritten,
  registerRedeemed,
  registerRequest,
} from "@chuggy/worker-core/register.mjs";

import { colimaCli } from "./colimaVm.mjs";
import { diskFloorSaid } from "./diskFree.mjs";
import { agentVersionAsked, doctorFindings, findingLine } from "./doctor.mjs";
import { memoryBudgetSaid } from "./memoryFree.mjs";
import { mcpServed } from "./mcp.mjs";
import {
  launchAgentBackground,
  launchAgentBaseCharsMax,
  launchAgentCommands,
  launchAgentDesktop,
  launchAgentFileName,
  launchAgentLabel,
  launchAgentPlist,
  launchAgentPoolFile,
  launchAgentRestart,
  launchAgentRunning,
  shellQuoted,
} from "./launchAgent.mjs";
import {
  dockerMachine,
  hostPlatform,
  jobNetwork,
  runnerDirectories,
  runnerLeftoversRemoved,
  runnerEngine,
  runnerLoop,
  runnerParts,
  runnerSetup,
  runnerUpdates,
  scratchRemovedOnSignal,
} from "./runner.mjs";
import {
  runnerConfig,
  runnerConfigLimits,
  runnerCredentialsHanded,
} from "./runnerConfig.mjs";
import { runnerPaths } from "./runnerPaths.mjs";

/**
 * @typedef {object} CliHost
 * @property {Readonly<Record<string, string | undefined>>} environment
 * @property {string} home
 * @property {number} uid
 * @property {string} hostname
 * @property {string} arch this Mac's own, as `process.arch` names it
 * @property {typeof globalThis.fetch} fetch
 * @property {import("@chuggy/worker-core/engine.mjs").Engine} [engine] the engine a run uses and registration asks, when not docker
 * @property {import("./colimaVm.mjs").ColimaCli} [colima] what reaches docker's VM, when not colima
 * @property {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient["tokens"]} [tokens] a run's token source, when not the pool's issuer
 * @property {Partial<import("@chuggy/worker-core/runnerUpdate.mjs").RunnerUpdatePorts>} [updatePorts] what an update reaches, where not the network, npm and this machine
 * @property {(uid: number) => Promise<boolean>} [desktop] whether the user has a desktop session, where not as launchd says
 * @property {string} packageName this copy's package, as its `package.json` names it
 * @property {string} version this copy's, as its `package.json` names it
 * @property {string} node this process's Node
 * @property {string} nodeVersion that Node's, as `process.versions.node` says it
 * @property {string} cli this CLI's entry, as an absolute path
 * @property {(line: string) => void} out
 * @property {(line: string) => void} err
 *
 * @typedef {{host: CliHost, poolFile: string, positionals: string[]}} CliCall
 */

/** The variable naming the pool file when `--pool` does not. */
export const poolFileVariable = "CHUGGY_DARWIN_POOL";

const usage = `usage: chuggy-darwin <command> [--pool <file>]
       chuggy-darwin register --api <origin> --token=<token> [--pool <name> | --personal]
                              [--host] [--capability <token>]...
       chuggy-darwin mcp --site <origin> --workspace <workspace> --project <project>
       chuggy-darwin --version

  register                redeem a registration token for a pool file, the
                          pool named for this machine unless --pool names it,
                          or with --personal a member's personal token for
                          their personal runner's file; it declares the VM's
                          platform, with --host this Mac's too, the agents
                          runner.json can run, and each --capability, which
                          the token must permit
  run                     run the pool until the plane denies it, or until
                          it installs the release chuggy names
  once                    one pass, then wait for what it placed to start
  status                  this pool's limits and containers, and what the
                          service is placing
  stop <assignment>       stop one assignment's container
  doctor                  check everything a run needs
  install-agent           write the launchd agent that runs \`run\`
  mcp                     serve chuggy's tools for one project to a coding
                          agent on stdio, under your own sign-in

The pool file is --pool, or ${poolFileVariable}.`;

/**
 * The copy of this runner that is speaking.
 *
 * @param {CliHost} host
 * @returns {import("./runner.mjs").RunnerCopy}
 */
function runnerCopy(host) {
  return { package: host.packageName, version: host.version, cli: host.cli };
}

/**
 * @param {CliCall} call
 * @param {{polls: boolean}} [command] `polls: false` for a command that never polls
 */
async function started(call, command = { polls: true }) {
  const setup = await runnerSetup(call.poolFile, call.host.home);
  const runner = await runnerParts(setup, {
    uid: call.host.uid,
    home: call.host.home,
    log: call.host.out,
    runner: { package: call.host.packageName, version: call.host.version },
    engine: call.host.engine,
    colima: call.host.colima,
    tokens: call.host.tokens,
    fetch: call.host.fetch,
    polls: command.polls,
  });
  return { setup, runner };
}

/**
 * The service. It claims the pool's control socket before removing what a
 * killed run left, so a second service of the pool is refused before it can
 * remove the first's scratch.
 *
 * @param {CliCall} call
 */
async function run(call) {
  const { setup, runner } = await started(call);
  const updates = runnerUpdates(
    setup,
    runnerCopy(call.host),
    call.host.updatePorts,
  );
  await runnerDirectories(setup.paths, runner.runtime);
  const server = await controlServer(runner.socket, runner.backend);
  try {
    await runnerLeftoversRemoved(runner.runtime);
    scratchRemovedOnSignal(runner.runtime);
    if ((await jobNetwork(runner.engine, setup.config.network)) === "Created")
      call.host.out(`made the job network ${setup.config.network}`);
    return await runnerLoop(runner.client, {
      sleep: (ms) => delay(ms),
      log: call.host.out,
      updates,
      underAgent: launchAgentRunning(call.host.environment, call.poolFile),
    });
  } finally {
    server.close();
  }
}

/** @param {CliCall} call */
async function once(call) {
  const { setup, runner } = await started(call);
  if ((await controlAsked(runner.socket, { op: "status" })) !== undefined) {
    call.host.err(
      "a chuggy-darwin service is running this pool; stop it before a pass of your own",
    );
    return 1;
  }
  await runnerDirectories(setup.paths, runner.runtime);
  await runnerLeftoversRemoved(runner.runtime);
  scratchRemovedOnSignal(runner.runtime);
  await jobNetwork(runner.engine, setup.config.network);
  const pass = await workerPoolClientPass(runner.client);
  await runner.backend.settled();
  if (pass.passed === "Reconciled") {
    call.host.out(poolRunnerPassLine(pass));
    return 0;
  }
  call.host.err(`${pass.passed}: ${pass.evidence}`);
  return 1;
}

/** @param {CliCall} call */
async function status(call) {
  const { setup, runner } = await started(call, { polls: false });
  const containers = await runner.backend.containers();
  const answered =
    /** @type {{inFlight: import("@chuggy/worker-core/containerBackend.mjs").InFlightPlacement[]} | undefined} */ (
      await controlAsked(runner.socket, { op: "status" })
    );
  call.host.out(
    answered === undefined ? "service: not running" : "service: running",
  );
  call.host.out(`limits: ${runnerConfigLimits(setup.config, setup.poolFile)}`);
  const disk = await diskFloorSaid(setup.config, runner.engine, runner.colima);
  call.host.out(`disk floor: ${disk.detail}`);
  call.host.out(
    `memory: ${await memoryBudgetSaid(setup.config, runner.engine)}`,
  );
  for (const placement of answered?.inFlight ?? [])
    call.host.out(
      `${placement.name}  ${placement.kind.toLowerCase()}  ${placement.phase.toLowerCase()}  ${placement.image}  ${placement.assignment}${placement.waiting === undefined ? "" : `  waiting: ${placement.waiting}`}`,
    );
  for (const container of containers)
    call.host.out(
      `${container.name}  ${container.kind.toLowerCase()}  ${container.status}  deadline ${container.deadlineEpochSecs === undefined ? "none" : new Date(container.deadlineEpochSecs * 1000).toISOString()}  ${container.assignment ?? "no assignment"}`,
    );
  return 0;
}

/** @param {CliCall} call */
async function stop(call) {
  const [assignment] = call.positionals;
  if (assignment === undefined || call.positionals.length !== 1) {
    call.host.err(usage);
    return 2;
  }
  const { runner } = await started(call, { polls: false });
  const answered =
    /** @type {{stopped?: string, evidence?: string, refused?: string}} */ (
      (await controlAsked(runner.socket, { op: "stop", assignment })) ??
        (await runner.backend.stop(assignment))
    );
  if (answered.stopped === "Stopped") {
    call.host.out(`stopped ${assignment}`);
    return 0;
  }
  call.host.err(answered.evidence ?? answered.refused ?? "not stopped");
  return 1;
}

/**
 * Which copy is speaking, under which Node, and then each check.
 *
 * @param {CliCall} call
 */
async function doctor(call) {
  const { host } = call;
  const paths = runnerPaths(host.home);
  host.out(
    `chuggy-darwin ${host.version} at ${host.cli}, under Node ${host.nodeVersion} at ${host.node}`,
  );
  const findings = await doctorFindings({
    poolFile: call.poolFile,
    paths,
    uid: host.uid,
    home: host.home,
    path: host.environment.PATH,
    agentVersion: agentVersionAsked,
    parts: {
      engine: () => host.engine ?? runnerEngine(),
      colima: () => host.colima ?? colimaCli(),
      tokens: (credentials) => host.tokens ?? poolRunnerTokens(credentials),
      plane: (credentials) =>
        poolRunnerPlane(credentials, {
          package: host.packageName,
          version: host.version,
        }),
      updates: (config) =>
        runnerUpdates({ config, paths }, runnerCopy(host), host.updatePorts),
    },
  });
  for (const finding of findings)
    (finding.passed && finding.warning !== true
      ? call.host.out
      : call.host.err)(findingLine(finding));
  return findings.every((finding) => finding.passed) ? 0 : 1;
}

/**
 * A property list's text, or nothing where there is no such file.
 *
 * @param {string} file
 */
async function plistText(file) {
  try {
    return await readFile(file, "utf8");
  } catch (failure) {
    if (/** @type {NodeJS.ErrnoException} */ (failure).code === "ENOENT")
      return undefined;
    throw failure;
  }
}

/**
 * The first executable of this name on a PATH, or nothing.
 *
 * @param {string} path
 * @param {string} name
 */
async function onPath(path, name) {
  for (const directory of path.split(delimiter).filter((entry) => entry !== ""))
    try {
      await access(join(directory, name), constants.X_OK);
      return join(directory, name);
    } catch {
      // not in this directory
    }
  return undefined;
}

/**
 * Writes the pool file's own agent, refusing one of its name that serves
 * another file. The agent is given this shell's PATH, since launchd's own
 * holds no Homebrew docker, each entry made absolute since launchd runs an
 * agent from `/`, and runs the node that PATH finds, a link an
 * upgrade keeps, rather than the versioned binary running this.
 *
 * @param {CliCall} call
 */
async function installAgent(call) {
  await poolCredentials(call.poolFile);
  const paths = runnerPaths(call.host.home);
  const path = (call.host.environment.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry !== "")
    .map((entry) => resolve(entry))
    .join(delimiter);
  if ((await onPath(path, "docker")) === undefined)
    throw new Error(
      "docker is not on this shell's PATH, which the agent is given; install the docker CLI (brew install docker) and run this again",
    );
  const node = await onPath(path, "node");
  if (node === undefined)
    throw new Error(
      "node is not on this shell's PATH, which the agent is given; run this from the shell the runner was installed from",
    );
  const label = launchAgentLabel(call.poolFile);
  const plist = join(paths.agents, launchAgentFileName(label));
  const existing = await plistText(plist);
  const served =
    existing === undefined ? undefined : launchAgentPoolFile(existing);
  if (existing !== undefined && served !== call.poolFile)
    throw new Error(
      `${plist} serves ${served ?? "no pool file this runner named"}, not ${call.poolFile}; remove that agent if it is stale, or rename the pool file`,
    );
  const background = !(await (call.host.desktop ?? launchAgentDesktop)(
    call.host.uid,
  ));
  await mkdir(paths.agents, { recursive: true });
  await mkdir(paths.logs, { recursive: true, mode: 0o700 });
  await writeFile(
    plist,
    launchAgentPlist({
      label,
      node,
      cli: call.host.cli,
      poolFile: call.poolFile,
      path,
      log: join(paths.logs, `${label}.log`),
      background,
    }),
  );
  const commands = launchAgentCommands({
    uid: call.host.uid,
    label,
    plist,
    background,
  });
  call.host.out(
    background
      ? `wrote ${plist} for your background session, since you are not logged in at this Mac's screen; start it with:`
      : `wrote ${plist}; start it, and Colima at login, with:`,
  );
  for (const command of background
    ? commands
    : [...commands, "brew services start colima"])
    call.host.out(`  ${command}`);
  return 0;
}

/**
 * Redeems a registration token and writes the pool file it answers. It takes
 * no pool file: its `--pool` is the name the pool takes, and `--personal`
 * redeems a member's personal token, which names no pool. The platform it
 * declares is docker's VM's, which can differ from the Mac's, so docker is
 * asked once the ask is found sound, and must answer before the token is spent.
 * `--host` declares the Mac's own platform beside it. It declares the agents
 * the runner's file can run, and none, saying so, where it cannot be read.
 *
 * @param {CliHost} host
 * @param {Omit<import("@chuggy/worker-core/register.mjs").RegisterAsked, "capabilities"> & {host?: boolean | undefined, capability?: string[] | undefined}} asked each `--capability` once per token
 */
async function register(host, { capability, host: hosted, ...named }) {
  const asked = { ...named, capabilities: capability, host: hosted };
  const ask = registerAskedChecked(asked, host.hostname);
  if ("refused" in ask) {
    host.err(ask.refused);
    return 2;
  }
  const platform = hostPlatform(host.arch);
  if (hosted === true && platform === undefined) {
    host.err(
      `this Mac is ${host.arch}, and no pool runs work on the host of one`,
    );
    return 2;
  }
  const { arch } = await dockerMachine(host.engine ?? runnerEngine());
  const { pools, config } = runnerPaths(host.home);
  const agents = await registerAgentsRead(config, hosted === true);
  const requested = registerRequest(asked, {
    hostname: host.hostname,
    arch,
    ...(hosted === true ? { hosted: [/** @type {string} */ (platform)] } : {}),
    agents: "agents" in agents ? agents.agents : [],
  });
  if ("refused" in requested) {
    host.err(requested.refused);
    return 2;
  }
  if ("none" in agents) host.err(agents.none);
  await registerPoolDirectory(pools);
  const pool = await registerRedeemed(requested.request, host.fetch);
  const { file, replaced } = await registerPoolFileWritten(
    pools,
    pool,
    launchAgentBaseCharsMax,
  ).catch((/** @type {unknown} */ failure) => {
    throw new Error(
      `the pool file could not be written, and the token is spent, so mint another: ${failure instanceof Error ? failure.message : String(failure)}`,
      { cause: failure },
    );
  });
  await poolCredentials(file);
  const verb = replaced ? "replaced" : "wrote";
  const label = launchAgentLabel(file);
  const agent = await plistText(
    join(runnerPaths(host.home).agents, launchAgentFileName(label)),
  ).catch(() => undefined);
  if (agent !== undefined && launchAgentPoolFile(agent) === file) {
    host.out(
      poolIdentityPersonal(pool)
        ? `${verb} ${file}; its agent runs the registration it read when it started until it is restarted:`
        : `${verb} ${file}; chuggy denies the pool's earlier registration, so its agent stops until it is restarted:`,
    );
    host.out(
      `  ${launchAgentRestart({ uid: host.uid, label, background: launchAgentBackground(agent) })}`,
    );
    return 0;
  }
  host.out(`${verb} ${file}; next:`);
  host.out(`  chuggy-darwin doctor --pool ${shellQuoted(file)}`);
  host.out(`  chuggy-darwin install-agent --pool ${shellQuoted(file)}`);
  return 0;
}

/**
 * The agents the runner's file can run, as a registration declares them, or
 * why it declares none where the file cannot be read, which a registration
 * goes on without.
 *
 * @param {string} file the runner's file
 * @param {boolean} hostJobs whether the pool runs jobs on the Mac itself
 * @returns {Promise<{agents: string[]} | {none: string}>}
 */
async function registerAgentsRead(file, hostJobs) {
  let config;
  try {
    config = await runnerConfig(file);
  } catch (failure) {
    return {
      none: `runner.json declared no agents, since it could not be read: ${failure instanceof Error ? failure.message : String(failure)}`,
    };
  }
  return {
    agents: registerAgents(
      runnerCredentialsHanded(config),
      config.images,
      hostJobs,
    ),
  };
}

/** The options only `mcp` takes. */
const mcpOptions = ["site", "workspace", "project"];

/**
 * Serves the tools for one project. It takes no pool file, and every other
 * command's options are asked wrongly here.
 *
 * @param {CliHost} host
 * @param {Record<string, unknown>} values
 * @param {readonly string[]} positionals
 */
async function mcp(host, values, positionals) {
  const { site, workspace, project, ...others } = values;
  const asked =
    /** @type {{site?: string, workspace?: string, project?: string}} */ ({
      site,
      workspace,
      project,
    });
  if (positionals.length > 0 || Object.keys(others).length > 0) {
    host.err(usage);
    return 2;
  }
  const refused = localToolAskRefusal(asked);
  if (refused !== undefined) {
    host.err(`${refused}\n${usage}`);
    return 2;
  }
  try {
    return await mcpServed(
      host,
      runnerPaths(host.home).signIns,
      /** @type {{site: string, workspace: string, project: string}} */ (asked),
    );
  } catch (failure) {
    host.err(failure instanceof Error ? failure.message : String(failure));
    return 1;
  }
}

const commands = {
  run,
  once,
  status,
  stop,
  doctor,
  "install-agent": installAgent,
};

/** Every option a command is parsed with. */
const cliOptions = /** @type {const} */ ({
  pool: { type: "string" },
  api: { type: "string" },
  token: { type: "string" },
  personal: { type: "boolean" },
  host: { type: "boolean" },
  capability: { type: "string", multiple: true },
  site: { type: "string" },
  workspace: { type: "string" },
  project: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
});

/**
 * @param {readonly string[]} argv the arguments after the entry
 * @param {CliHost} host
 * @returns {Promise<number>} the exit status
 */
export async function cliMain(argv, host) {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: cliOptions,
      allowPositionals: true,
    });
  } catch (failure) {
    host.err(`${/** @type {Error} */ (failure).message}\n${usage}`);
    return 2;
  }
  const { values } = parsed;
  const [name, ...positionals] = parsed.positionals;
  if (values.help === true || name === "help") {
    host.out(usage);
    return 0;
  }
  if (values.version === true) {
    host.out(`chuggy-darwin ${host.version}`);
    return 0;
  }
  if (name === "mcp") return await mcp(host, values, positionals);
  const registering = name === "register";
  const command = Object.hasOwn(commands, name ?? "")
    ? commands[/** @type {keyof typeof commands} */ (name)]
    : undefined;
  if (
    (!registering &&
      (command === undefined ||
        values.api !== undefined ||
        values.token !== undefined ||
        values.personal !== undefined ||
        values.host !== undefined ||
        values.capability !== undefined)) ||
    mcpOptions.some((option) => values[option] !== undefined) ||
    (name !== "stop" && positionals.length > 0)
  ) {
    host.err(usage);
    return 2;
  }
  const poolFile = values.pool ?? host.environment[poolFileVariable];
  if (!registering && (poolFile === undefined || poolFile === "")) {
    host.err(
      `no pool file: name one with --pool or ${poolFileVariable}\n${usage}`,
    );
    return 2;
  }
  try {
    if (registering) return await register(host, values);
    return await /** @type {(call: CliCall) => Promise<number>} */ (command)({
      host,
      poolFile: resolve(/** @type {string} */ (poolFile)),
      positionals,
    });
  } catch (failure) {
    host.err(failure instanceof Error ? failure.message : String(failure));
    return 1;
  }
}
