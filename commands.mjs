/**
 * The `chuggy-darwin` commands. Each answers an exit status: 0 done, 1 failed,
 * 2 asked wrongly. `run` ends without failing only when the plane denies the
 * pool, which is done, since nothing but a new registration brings the pool
 * back. `once` fails on any pass that did not reconcile, a denial among them.
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
  poolRunnerLoop,
  poolRunnerPassLine,
  poolRunnerPlane,
  poolRunnerTokens,
} from "@chuggy/worker-core/poolRunner.mjs";
import {
  registerAskedChecked,
  registerPoolDirectory,
  registerPoolFileWritten,
  registerRedeemed,
  registerRequest,
} from "@chuggy/worker-core/register.mjs";

import { claudeVersionAsked, doctorFindings, findingLine } from "./doctor.mjs";
import { mcpServed } from "./mcp.mjs";
import {
  launchAgentBaseCharsMax,
  launchAgentCommands,
  launchAgentFileName,
  launchAgentLabel,
  launchAgentPlist,
  launchAgentPoolFile,
  launchAgentRestart,
  shellQuoted,
} from "./launchAgent.mjs";
import {
  dockerMachine,
  hostPlatform,
  jobNetwork,
  runnerDirectories,
  runnerLeftoversRemoved,
  runnerEngine,
  runnerParts,
  runnerSetup,
  scratchRemovedOnSignal,
} from "./runner.mjs";
import { runnerConfigLimits } from "./runnerConfig.mjs";
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
 * @property {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient["tokens"]} [tokens] a run's token source, when not the pool's issuer
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

  register                redeem a registration token for a pool file, the
                          pool named for this machine unless --pool names it,
                          or with --personal a member's personal token for
                          their personal runner's file; it declares the VM's
                          platform, with --host this Mac's too, and each
                          --capability, which the token must permit
  run                     run the pool until the plane denies it
  once                    one pass, then wait for what it placed to start
  status                  this pool's limits and containers, and what the
                          service is placing
  stop <assignment>       stop one assignment's container
  doctor                  check everything a run needs
  install-agent           write the launchd agent that runs \`run\`
  mcp                     serve chuggy's tools for one project to a coding
                          agent on stdio, under your own sign-in

The pool file is --pool, or ${poolFileVariable}.`;

/** @param {CliCall} call */
async function started(call) {
  const setup = await runnerSetup(call.poolFile, call.host.home);
  const runner = await runnerParts(setup, {
    uid: call.host.uid,
    home: call.host.home,
    log: call.host.out,
    engine: call.host.engine,
    tokens: call.host.tokens,
    fetch: call.host.fetch,
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
  await runnerDirectories(setup.paths, runner.runtime);
  const server = await controlServer(runner.socket, runner.backend);
  try {
    await runnerLeftoversRemoved(runner.runtime);
    scratchRemovedOnSignal(runner.runtime);
    if ((await jobNetwork(runner.engine, setup.config.network)) === "Created")
      call.host.out(`made the job network ${setup.config.network}`);
    await poolRunnerLoop(runner.client, {
      sleep: (ms) => delay(ms),
      log: call.host.out,
    });
    return 0;
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
  const { setup, runner } = await started(call);
  const containers = await runner.backend.containers();
  const answered =
    /** @type {{inFlight: import("@chuggy/worker-core/containerBackend.mjs").InFlightPlacement[]} | undefined} */ (
      await controlAsked(runner.socket, { op: "status" })
    );
  call.host.out(
    answered === undefined ? "service: not running" : "service: running",
  );
  call.host.out(`limits: ${runnerConfigLimits(setup.config)}`);
  for (const placement of answered?.inFlight ?? [])
    call.host.out(
      `${placement.name}  ${placement.kind.toLowerCase()}  ${placement.phase.toLowerCase()}  ${placement.image}  ${placement.assignment}`,
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
  const { runner } = await started(call);
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

/** @param {CliCall} call */
async function doctor(call) {
  const findings = await doctorFindings({
    poolFile: call.poolFile,
    paths: runnerPaths(call.host.home),
    uid: call.host.uid,
    home: call.host.home,
    path: call.host.environment.PATH,
    claudeVersion: claudeVersionAsked,
    parts: {
      engine: () => call.host.engine ?? runnerEngine(),
      tokens: (credentials) =>
        call.host.tokens ?? poolRunnerTokens(credentials),
      plane: poolRunnerPlane,
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
    }),
  );
  call.host.out(`wrote ${plist}; start it, and Colima at login, with:`);
  for (const command of [
    ...launchAgentCommands({ uid: call.host.uid, label, plist }),
    "brew services start colima",
  ])
    call.host.out(`  ${command}`);
  return 0;
}

/**
 * Redeems a registration token and writes the pool file it answers. It takes
 * no pool file: its `--pool` is the name the pool takes, and `--personal`
 * redeems a member's personal token, which names no pool. The platform it
 * declares is docker's VM's, which can differ from the Mac's, so docker is
 * asked once the ask is found sound, and must answer before the token is spent.
 * `--host` declares the Mac's own platform beside it.
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
  const requested = registerRequest(asked, {
    hostname: host.hostname,
    arch,
    ...(hosted === true ? { hosted: [/** @type {string} */ (platform)] } : {}),
  });
  if ("refused" in requested) {
    host.err(requested.refused);
    return 2;
  }
  const { pools } = runnerPaths(host.home);
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
      `${verb} ${file}; chuggy denies ${poolIdentityPersonal(pool) ? "this personal runner's" : "the pool's"} earlier registration, so its agent stops until it is restarted:`,
    );
    host.out(`  ${launchAgentRestart({ uid: host.uid, label })}`);
    return 0;
  }
  host.out(`${verb} ${file}; next:`);
  host.out(`  chuggy-darwin doctor --pool ${shellQuoted(file)}`);
  host.out(`  chuggy-darwin install-agent --pool ${shellQuoted(file)}`);
  return 0;
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
      options: {
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
      },
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
