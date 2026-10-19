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
 * the Mac.
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
import { join } from "node:path";
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
  poolRunnerTokens,
} from "@chuggy/worker-core/poolRunner.mjs";
import { runtimeScratch } from "@chuggy/worker-core/runtimeScratch.mjs";

import { powerAssertion, poweredBackend } from "./power.mjs";
import {
  claudeCredentialFileRefusal,
  runnerClaudeHanded,
  runnerConfig,
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
 *
 * @typedef {object} RunnerSetup
 * @property {PoolCredentials} credentials
 * @property {RunnerConfig} config
 * @property {RunnerPaths} paths
 *
 * @typedef {object} Runner
 * @property {string} runtime the pool's runtime directory
 * @property {string} socket where the pool's service listens
 * @property {Engine} engine
 * @property {ContainerBackend} backend
 * @property {WorkerPoolClient} client whose backend keeps the Mac awake while the pool holds work
 */

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

export function runnerEngine() {
  return containerEngine("docker", engineCallTimeoutMs);
}

/** What docker says of the machine it runs containers on. */
const dockerMachineArgv = [
  "info",
  "--format",
  '{"cpus":{{json .NCPU}},"memoryBytes":{{json .MemTotal}},"architecture":{{json .Architecture}}}',
];

const dockerMachineSchema = z.object({
  cpus: z.number().int().positive().safe(),
  memoryBytes: z.number().int().positive().safe(),
  architecture: z.string(),
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
 * The machine docker runs containers on: its size, as a job is sized against
 * it, and its architecture, as `process.arch` names one.
 *
 * @param {Engine} engine
 * @returns {Promise<{size: {cpuMillis: number, memoryMib: number}, arch: string}>}
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
 * @param {{uid: number, home: string, log: (line: string) => void, engine?: Engine, tokens?: WorkerPoolClient["tokens"], fetch?: typeof globalThis.fetch, power?: import("./power.mjs").PowerAssertion, spawn?: typeof import("node:child_process").spawn}} host this process's uid and home, where its log lines go, the engine and token source when not docker and the pool's issuer, the fetch a job's or a session's plane is reached by when not the global one, the power assertion when not caffeinate, and what starts a job on the Mac itself when not Node's own `spawn`
 * @returns {Promise<Runner>}
 */
export async function runnerParts(setup, host) {
  const { credentials, config, paths } = setup;
  const runtime = poolRuntimeDirectory(paths, credentials);
  const socket = poolSocket(runtime);
  const engine = host.engine ?? runnerEngine();
  const dockerHost = await dockerEndpoint(engine);
  const { size } = await dockerMachine(engine);
  const tokens = host.tokens ?? poolRunnerTokens(credentials);
  const claude = runnerClaudeHanded(config);
  const tokenFileRefusal = (/** @type {string} */ file) =>
    claudeCredentialFileRefusal(claude.claudeCredential, file, {
      uid: host.uid,
      home: host.home,
    });
  const container = containerBackend(
    {
      engine: "docker",
      pool: credentials,
      ...claude,
      registryHost: credentials.registryHost,
      dockerHost,
      timeoutSecsMax: config.timeoutSecsMax,
      outputBytesMax: config.outputBytesMax,
      environment: config.environment,
      network: config.network,
      runtimeDir: runtime,
      logDir: paths.logs,
      machine: size,
      pullRetryMs,
      images: config.images,
    },
    {
      engine,
      tokens,
      nowMs: Date.now,
      sleep: (ms, signal) => delay(ms, undefined, { signal }),
      log: host.log,
      tokenFileRefusal,
    },
  );
  const backend = runnerHostRouted(setup, container, claude, {
    log: host.log,
    tokenFileRefusal,
    ...(host.spawn === undefined ? {} : { spawn: host.spawn }),
  });
  const power = host.power ?? powerAssertion({ log: host.log });
  const client = poolRunnerClient(
    credentials,
    poweredBackend(backend, power),
    { concurrencyMax: config.concurrencyMax, sessionsMax: config.sessionsMax },
    { tokens, fetch: host.fetch },
  );
  return { runtime, socket, engine, backend, client };
}

/**
 * The container backend, with the Mac beside it where the pool was registered
 * with `--host`, taking each job that pins no image and names the Mac's
 * platform.
 *
 * @param {RunnerSetup} setup
 * @param {ContainerBackend} container
 * @param {ReturnType<typeof runnerClaudeHanded>} claude
 * @param {import("@chuggy/worker-core/hostBackend.mjs").HostBackendSeams} seams
 * @returns {ContainerBackend}
 */
function runnerHostRouted(setup, container, claude, seams) {
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
        ...claude,
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
