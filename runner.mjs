/**
 * The runner composed: the pool's credentials and the runner's file read, and
 * the container backend beside the worker core's pool runner, which passes
 * until the plane denies the pool. Every command but register is composed
 * here; register asks it only what docker's VM is.
 *
 * The machine a job is sized against, and whose platform a pool declares, is
 * the docker VM, not the Mac: Colima's VM has the CPUs, memory and
 * architecture it was started with, and docker says which. A pool registered
 * with `--host` declares the Mac's platform too, and its pool file says so, and
 * a job that pins no image and names it runs on the Mac itself, sized against
 * the Mac. Each poll advertises what the runner finds of the VM and its file
 * when the run starts, and names this copy, so that the plane can name the
 * release chuggy pins, which a run installs and ends to be restarted on.
 *
 * EVERY BACKEND IS TOLD THE KIND OF CLAUDE CREDENTIAL, a subscription's where
 * the runner's file names `claudeTokenFile`. The core withholds what would
 * choose another credential only from a workload told one, so a run that told
 * none would let a variable its jobs inherit outrank the token.
 */

import { Buffer } from "node:buffer";
import { readdirSync, rmSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import { containerBackend } from "@chuggy/worker-core/containerBackend.mjs";
import { controlSocketPath } from "@chuggy/worker-core/control.mjs";
import {
  hostBackend,
  hostPlatformsDeclared,
  hostRoutedBackend,
} from "@chuggy/worker-core/hostBackend.mjs";
import { containerEngine } from "@chuggy/worker-core/engine.mjs";
import {
  dockerContextArgv,
  networkCreateArgv,
  networkInspectArgv,
} from "@chuggy/worker-core/engineArgv.mjs";
import {
  engineFailure,
  engineFailureLine,
} from "@chuggy/worker-core/engineErrors.mjs";
import { poolCredentials } from "@chuggy/worker-core/poolCredentials.mjs";
import { poolIdentityDigest } from "@chuggy/worker-core/poolIdentity.mjs";
import {
  poolRunnerClient,
  poolRunnerLoop,
  poolRunnerTokens,
} from "@chuggy/worker-core/poolRunner.mjs";
import { registerAdvertised } from "@chuggy/worker-core/register.mjs";
import { runnerUpdater } from "@chuggy/worker-core/runnerUpdate.mjs";
import { runtimeScratch } from "@chuggy/worker-core/runtimeScratch.mjs";

import { colimaCli, colimaProfile, colimaRosetta } from "./colimaVm.mjs";
import { diskFloorBytes, vmDiskFree } from "./diskFree.mjs";
import { updatedExitStatus } from "./launchAgent.mjs";
import { memoryFreeBytes, memoryReservedBytes } from "./memoryFree.mjs";
import { powerAssertion, poweredBackend } from "./power.mjs";
import {
  credentialFileRefusal,
  runnerConfig,
  runnerCredentialDescribed,
  runnerCredentialsHanded,
  runnerPoolLimits,
} from "./runnerConfig.mjs";
import { runnerPaths } from "./runnerPaths.mjs";

/**
 * @typedef {import("@chuggy/worker-core/poolCredentials.mjs").PoolCredentials} PoolCredentials
 * @typedef {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient} WorkerPoolClient
 * @typedef {import("@chuggy/worker-core/containerBackend.mjs").ContainerBackend} ContainerBackend
 * @typedef {import("@chuggy/worker-core/engine.mjs").Engine} Engine
 * @typedef {import("@chuggy/worker-core/poolIdentity.mjs").PoolIdentity} PoolIdentity
 * @typedef {import("./runnerConfig.mjs").RunnerConfig} RunnerConfig
 * @typedef {import("./runnerPaths.mjs").RunnerPaths} RunnerPaths
 * @typedef {import("@chuggy/worker-core/runnerUpdate.mjs").RunnerIdentity} RunnerIdentity
 * @typedef {import("@chuggy/worker-core/runnerUpdate.mjs").RunnerUpdatePorts} RunnerUpdatePorts
 * @typedef {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolUpdates} WorkerPoolUpdates
 *
 * @typedef {object} RunnerCopy the copy of this runner that is running
 * @property {string} package its package's name, as its `package.json` names it
 * @property {string} version as its `package.json` names it
 * @property {string} cli its entry, as an absolute path, at the root of the directory it is installed in
 *
 * @typedef {object} RunnerSetup
 * @property {string} poolFile
 * @property {PoolCredentials} credentials
 * @property {RunnerConfig} config
 * @property {RunnerPaths} paths
 *
 * @typedef {object} Runner
 * @property {string} runtime the pool's runtime directory
 * @property {string} socket where the pool's service listens
 * @property {Engine} engine
 * @property {import("./colimaVm.mjs").ColimaCli} colima what reaches docker's VM, which its free disk is measured in
 * @property {ContainerBackend} backend
 * @property {WorkerPoolClient} client whose backend keeps the Mac awake while the pool holds work
 */

/** Where this package's releases are downloaded from, and the one place a release chuggy names is taken from. */
export const runnerReleasePrefix =
  "https://github.com/kasofsk/chuggy-darwin/releases/download/";

/** The wait before a pull the registry refused is made again under a fresh token. */
const pullRetryMs = 5_000;

/** The cap on an engine call with no deadline of its own, which guards a hung engine. */
const engineCallTimeoutMs = 300_000;

/** The longest path a unix socket is bound at on macOS, less its terminating NUL. */
export const socketPathBytesMax = 103;

/**
 * @param {string} poolFile
 * @param {string} home
 * @returns {Promise<RunnerSetup>}
 */
export async function runnerSetup(poolFile, home) {
  const paths = runnerPaths(home);
  return {
    poolFile,
    credentials: await poolCredentials(poolFile),
    config: await runnerConfig(paths.config),
    paths,
  };
}

/**
 * A pool's own runtime directory under the runner's, so no two pools share a
 * control socket or scratch.
 *
 * @param {RunnerPaths} paths
 * @param {PoolIdentity} identity
 */
export function poolRuntimeDirectory(paths, identity) {
  return join(paths.runtime, "pools", poolIdentityDigest(identity));
}

/**
 * The pool's control socket, refused where its path is too long for macOS to
 * bind, which only a long home directory makes it.
 *
 * @param {string} runtime the pool's runtime directory
 */
export function poolSocket(runtime) {
  const socket = controlSocketPath(runtime);
  if (Buffer.byteLength(socket) > socketPathBytesMax)
    throw new Error(
      `the control socket ${socket} is longer than the ${String(socketPathBytesMax)} bytes macOS binds a socket at`,
    );
  return socket;
}

/**
 * The lock a service takes to start a job into docker's memory: one for every
 * pool's agent of this user, since every one runs in the one VM.
 *
 * @param {RunnerPaths} paths
 */
export function runnerMemoryLock(paths) {
  return join(paths.runtime, "memory", "docker.lock");
}

/**
 * The lock a service takes to ask a plane that claims by room for jobs, so
 * no two are given the same room: one for every pool's agent of this user,
 * beside the memory lock.
 *
 * @param {RunnerPaths} paths
 */
export function runnerClaimLock(paths) {
  return join(paths.runtime, "memory", "docker.claim");
}

/**
 * The lock a service takes to install a release of the runner: one for every
 * pool's agent of this user, which all run the one install.
 *
 * @param {RunnerPaths} paths
 */
export function runnerUpdateLock(paths) {
  return join(paths.runtime, "update.lock");
}

/**
 * What a run is told of its runner's update of itself: on unless the
 * runner's file turns it off, and taken from this package's own release
 * downloads into the directory this copy is installed in.
 *
 * @param {Pick<RunnerSetup, "config" | "paths">} setup
 * @param {RunnerCopy} copy
 * @param {Partial<RunnerUpdatePorts>} [ports] where a suite stands in for the network, npm or the machine
 * @returns {WorkerPoolUpdates}
 */
export function runnerUpdates(setup, copy, ports) {
  return {
    on: setup.config.autoUpdate,
    updater: runnerUpdater(
      {
        runner: { package: copy.package, version: copy.version },
        releasePrefix: runnerReleasePrefix,
        installed: dirname(copy.cli),
        lockPath: runnerUpdateLock(setup.paths),
      },
      ports,
    ),
  };
}

/**
 * The pool loop until the plane denies the pool, which is done, or until the
 * runner has installed a release of itself, which its agent restarts it on
 * and a run started by hand is started again on.
 *
 * @param {WorkerPoolClient} client
 * @param {{sleep: (ms: number) => Promise<void>, log: (line: string) => void, updates: WorkerPoolUpdates, underAgent: boolean}} seams `underAgent` where launchd started the run as the pool's agent
 * @returns {Promise<number>} the exit status
 */
export async function runnerLoop(client, seams) {
  const { underAgent, ...loop } = seams;
  const pass = await poolRunnerLoop(client, loop);
  if (pass.passed === "Denied") return 0;
  const release = `${seams.updates.updater.runner.package} ${pass.version}`;
  seams.log(
    underAgent
      ? `ending, for launchd to restart this run on ${release}`
      : `ending: start this run again to run ${release}`,
  );
  return updatedExitStatus;
}

export function runnerEngine() {
  return containerEngine("docker", engineCallTimeoutMs);
}

/** What docker says of the machine it runs containers on. */
const dockerMachineArgv = [
  "info",
  "--format",
  '{"cpus":{{json .NCPU}},"memoryBytes":{{json .MemTotal}},"architecture":{{json .Architecture}},"name":{{json .Name}}}',
];

const dockerMachineSchema = z.object({
  cpus: z.number().int().positive().safe(),
  memoryBytes: z.number().int().positive().safe(),
  architecture: z.string(),
  name: z.string(),
});

/**
 * The architectures docker reports that registration takes, as `process.arch`
 * names them; any other is passed on as docker names it, for registration to
 * refuse.
 */
const dockerArchitectures = /** @type {Record<string, string>} */ ({
  aarch64: "arm64",
  x86_64: "x64",
});

/**
 * The platform capability a pool on a VM of each architecture declares, as
 * registration declares it, which the suite holds this to.
 */
const vmPlatforms = /** @type {Record<string, string>} */ ({
  arm64: "Platform:Linux:Arm64",
  x64: "Platform:Linux:Amd64",
});

/**
 * The platform a VM of this architecture runs, or nothing for one no pool
 * runs.
 *
 * @param {string} arch as `process.arch` names one
 */
export function vmPlatform(arch) {
  return Object.hasOwn(vmPlatforms, arch) ? vmPlatforms[arch] : undefined;
}

/** The platform each Mac `process.arch` names is, as `--host` declares it. */
const hostPlatforms = /** @type {Record<string, string>} */ ({
  arm64: "Platform:MacOS:Arm64",
  x64: "Platform:MacOS:Amd64",
});

/** The platform an arm64 VM runs amd64 programs as, through Rosetta. */
export const rosettaPlatform = vmPlatforms.x64;

/**
 * The platforms docker's VM runs, its own architecture's first, and on an
 * arm64 VM Amd64's beside it where Colima runs amd64 programs there through
 * Rosetta, with what was found of Rosetta on an arm64 VM. QEMU, which runs
 * them where Rosetta does not, is too slow to take amd64 work through. A VM
 * no pool runs on is refused.
 *
 * @param {{arch: string, name: string}} machine docker's VM, as `dockerMachine` finds it
 * @param {import("./colimaVm.mjs").ColimaCli} colima
 * @returns {Promise<{platforms: string[], rosetta?: {rosetta: boolean} | {unknown: string}}>}
 */
export async function vmPlatformsFound(machine, colima) {
  const platform = vmPlatform(machine.arch);
  if (platform === undefined)
    throw new Error(`docker's VM is ${machine.arch}, which no pool runs`);
  if (machine.arch !== "arm64") return { platforms: [platform] };
  const profile = colimaProfile(machine.name);
  const rosetta =
    profile === undefined
      ? {
          unknown: `docker names its machine ${machine.name}, which is no Colima VM`,
        }
      : await colimaRosetta(colima, profile);
  return {
    platforms:
      "rosetta" in rosetta && rosetta.rosetta
        ? [platform, rosettaPlatform]
        : [platform],
    rosetta,
  };
}

/**
 * The platform a Mac of this architecture is, or nothing for one no pool runs
 * work on the host of.
 *
 * @param {string} arch as `process.arch` names one
 */
export function hostPlatform(arch) {
  return Object.hasOwn(hostPlatforms, arch) ? hostPlatforms[arch] : undefined;
}

/**
 * The capabilities each poll of a pool's run advertises, found when it
 * starts: the platforms docker's VM runs, the Mac's beside them where the
 * pool was registered with `--host`, the agents the runner's file can run,
 * and what the file's `capabilities` declares or, where it is absent, the
 * rest of what the pool was registered with. A set past the contract's bound
 * is refused.
 *
 * @param {Pick<RunnerSetup, "credentials" | "config" | "paths">} setup
 * @param {readonly string[]} vm the platforms docker's VM runs, as `vmPlatformsFound` finds them
 * @returns {string[]}
 */
export function runnerCapabilities(setup, vm) {
  const { credentials, config, paths } = setup;
  const advertised = registerAdvertised({
    platforms: [...vm, ...hostPlatformsDeclared(credentials, "MacOS")],
    files: runnerCredentialsHanded(config),
    images: config.images,
    host: credentials.host === true,
    declared: config.capabilities,
    recorded: credentials.capabilities,
  });
  if ("refused" in advertised)
    throw new Error(
      `runner configuration ${paths.config}: capabilities: ${advertised.refused}`,
    );
  return advertised.capabilities;
}

/**
 * The machine docker runs containers on: its size, as a job is sized against
 * it, its architecture, as `process.arch` names one, and its name.
 *
 * @param {Engine} engine
 * @returns {Promise<{size: {cpuMillis: number, memoryMib: number}, arch: string, name: string}>}
 */
export async function dockerMachine(engine) {
  const info = await engine.exec(dockerMachineArgv);
  if (info.code !== 0)
    throw new Error(`docker could not be asked: ${engineFailureLine(info)}`);
  let parsed;
  try {
    parsed = dockerMachineSchema.parse(JSON.parse(info.stdout));
  } catch {
    throw new Error(
      `docker answered ${JSON.stringify(info.stdout.trim())}, not its CPUs, memory and architecture`,
    );
  }
  return {
    size: {
      cpuMillis: parsed.cpus * 1000,
      memoryMib: Math.floor(parsed.memoryBytes / (1024 * 1024)),
    },
    arch: Object.hasOwn(dockerArchitectures, parsed.architecture)
      ? dockerArchitectures[parsed.architecture]
      : parsed.architecture,
    name: parsed.name,
  };
}

/**
 * The endpoint a pull of the pool's registry is told, which that pull, made
 * under a configuration directory of its own, would otherwise lose. Only a
 * unix socket is taken, since a remote context's certificates would not reach
 * it.
 *
 * @param {Engine} engine
 * @returns {Promise<string>}
 */
export async function dockerEndpoint(engine) {
  const context = await engine.exec(dockerContextArgv());
  if (context.code !== 0)
    throw new Error(
      `docker's context could not be read: ${engineFailureLine(context)}`,
    );
  const endpoint = context.stdout.trim();
  if (!endpoint.startsWith("unix://"))
    throw new Error(
      `docker's context names "${endpoint}", and only a docker reached by a unix socket, as Colima's is, is supported`,
    );
  return endpoint;
}

/**
 * @param {RunnerSetup} setup
 * @param {{uid: number, home: string, log: (line: string) => void, runner?: RunnerIdentity, engine?: Engine, colima?: import("./colimaVm.mjs").ColimaCli, tokens?: WorkerPoolClient["tokens"], fetch?: typeof globalThis.fetch, power?: import("./power.mjs").PowerAssertion, spawn?: typeof import("node:child_process").spawn, polls?: boolean}} host this process's uid and home, where its log lines go, the copy each poll names, the engine, the CLI reaching its VM and the token source when not docker, colima and the pool's issuer, the fetch a job's or a session's plane is reached by when not the global one, the power assertion when not caffeinate, what starts a job on the Mac itself when not Node's own `spawn`, and `polls: false` for a command that never polls, which then finds nothing to advertise
 * @returns {Promise<Runner>}
 */
export async function runnerParts(setup, host) {
  const { credentials, config, paths } = setup;
  const runtime = poolRuntimeDirectory(paths, credentials);
  const socket = poolSocket(runtime);
  const engine = host.engine ?? runnerEngine();
  const colima = host.colima ?? colimaCli();
  const dockerHost = await dockerEndpoint(engine);
  const machine = await dockerMachine(engine);
  const capabilities =
    host.polls === false
      ? undefined
      : runnerCapabilities(
          setup,
          (await vmPlatformsFound(machine, colima)).platforms,
        );
  const tokens = host.tokens ?? poolRunnerTokens(credentials);
  const handed = runnerCredentialsHanded(config);
  const tokenFileRefusal = credentialFileRefused(handed, host);
  const container = containerBackend(
    {
      engine: "docker",
      pool: credentials,
      ...handed,
      registryHost: credentials.registryHost,
      dockerHost,
      timeoutSecsMax: config.timeoutSecsMax,
      outputBytesMax: config.outputBytesMax,
      environment: config.environment,
      network: config.network,
      runtimeDir: runtime,
      logDir: paths.logs,
      machine: machine.size,
      pullRetryMs,
      images: config.images,
      imageRecord: join(paths.images, "docker.json"),
      imageUnusedSecsMax: config.imageUnusedSecsMax,
      memoryFreeBytesMin: memoryFreeBytes(config),
      memoryReservedBytes: memoryReservedBytes(config),
      memoryLock: runnerMemoryLock(paths),
      memoryClaimLock: runnerClaimLock(paths),
      diskFreeBytesMin: diskFloorBytes(config),
    },
    {
      engine,
      tokens,
      nowMs: Date.now,
      sleep: (ms, signal) => delay(ms, undefined, { signal }),
      log: host.log,
      tokenFileRefusal,
      diskFree: () => vmDiskFree(engine, colima),
    },
  );
  const backend = runnerHostRouted(setup, container, handed, {
    log: host.log,
    tokenFileRefusal,
    ...(host.spawn === undefined ? {} : { spawn: host.spawn }),
  });
  const power = host.power ?? powerAssertion({ log: host.log });
  const client = poolRunnerClient(
    credentials,
    poweredBackend(backend, power),
    runnerPoolLimits(config, setup.poolFile),
    { tokens, fetch: host.fetch, runner: host.runner, capabilities },
  );
  return { runtime, socket, engine, colima, backend, client };
}

/**
 * Why a job cannot be handed the credential file of the agent it requires, as
 * both backends ask it.
 *
 * @param {ReturnType<typeof runnerCredentialsHanded>} handed
 * @param {{uid: number, home: string}} runner this process's uid and the home the VM shares
 * @returns {(file: string, agent: string) => Promise<string | undefined>}
 */
function credentialFileRefused(handed, runner) {
  return (file, agent) =>
    credentialFileRefusal(
      runnerCredentialDescribed(handed.claudeCredential, agent),
      file,
      { uid: runner.uid, home: runner.home },
    );
}

/**
 * The container backend, with the Mac beside it where the pool was registered
 * with `--host`, taking each job that pins no image and names the Mac's
 * platform.
 *
 * @param {RunnerSetup} setup
 * @param {ContainerBackend} container
 * @param {ReturnType<typeof runnerCredentialsHanded>} handed
 * @param {import("@chuggy/worker-core/hostBackend.mjs").HostBackendSeams} seams
 * @returns {ContainerBackend}
 */
function runnerHostRouted(setup, container, handed, seams) {
  const { credentials, config, paths } = setup;
  const platforms = hostPlatformsDeclared(credentials, "MacOS");
  if (platforms.length === 0) return container;
  return hostRoutedBackend(
    container,
    hostBackend(
      {
        platforms,
        directory: join(paths.jobs, poolIdentityDigest(credentials)),
        logDir: paths.logs,
        ...handed,
        timeoutSecsMax: config.timeoutSecsMax,
        outputBytesMax: config.outputBytesMax,
        environment: config.environment,
        machine: {
          cpuMillis: availableParallelism() * 1000,
          memoryMib: Math.floor(totalmem() / (1024 * 1024)),
        },
      },
      seams,
    ),
    platforms,
  );
}

/**
 * The job network, made when it is missing. Every pool's run on the machine
 * shares it, so a creation that failed is one another run may have beaten.
 *
 * @param {Engine} engine
 * @param {string} network
 * @returns {Promise<"Present" | "Created">}
 */
export async function jobNetwork(engine, network) {
  const inspected = await engine.exec(networkInspectArgv(network));
  if (inspected.code === 0) return "Present";
  if (engineFailure(inspected) !== "NotFound")
    throw new Error(
      `network ${network} could not be inspected: ${engineFailureLine(inspected)}`,
    );
  const created = await engine.exec(networkCreateArgv(network));
  if (created.code === 0) return "Created";
  if ((await engine.exec(networkInspectArgv(network))).code === 0)
    return "Present";
  throw new Error(
    `network ${network} could not be created: ${engineFailureLine(created)}`,
  );
}

/**
 * The directories a pool's run writes under, made owner-only.
 *
 * @param {RunnerPaths} paths
 * @param {string} runtime the pool's runtime directory
 */
export async function runnerDirectories(paths, runtime) {
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await mkdir(paths.logs, { recursive: true, mode: 0o700 });
}

/**
 * Removes every pull credential and env file in a pool's runtime directory,
 * which only a run that no other run of the pool is beside may do: each is
 * one a killed run did not get to remove.
 *
 * @param {string} runtime the pool's runtime directory
 */
export async function runnerLeftoversRemoved(runtime) {
  for (const entry of await readdir(runtime))
    if (/^(?:pull|job)-/u.test(entry))
      await rm(join(runtime, entry), { recursive: true, force: true });
}

/**
 * Removes the pull credentials and env files this process made, and no other
 * process's.
 *
 * @param {string} runtime
 * @param {number} pid
 */
export function ownScratchRemoved(runtime, pid = process.pid) {
  const own = [runtimeScratch("pull", pid), runtimeScratch("job", pid)];
  for (const entry of readdirSync(runtime))
    if (own.some((prefix) => entry.startsWith(prefix)))
      rmSync(join(runtime, entry), { recursive: true, force: true });
}

/**
 * Has a SIGTERM or SIGINT remove this process's own scratch, then end the
 * process by that signal as it would have ended anyway. Its containers are
 * left for the next run to pick up.
 *
 * @param {string} runtime
 */
export function scratchRemovedOnSignal(runtime) {
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      try {
        ownScratchRemoved(runtime);
      } finally {
        process.kill(process.pid, signal);
      }
    });
}
