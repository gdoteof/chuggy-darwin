/**
 * The runner's own file, and whether it can hand a job a credential's file.
 * The file is refused unless only its owner can read or write it, and is read
 * strictly, so a misspelt key is an error rather than a default; a pool's
 * name in `pools` is not a key of the file's own, and `doctor` checks it
 * against the pool files instead. The pool's credentials are the worker core's
 * to read.
 *
 * THE FILE NAMES ONE CLAUDE CREDENTIAL, by `claudeCredential` of any kind the
 * core takes or by `claudeTokenFile`, a subscription's, and may name another
 * agent's beside it, which a job requiring that agent is handed in its place:
 * Codex's by `codexCredential`.
 *
 * Docker is the one engine, reached in the Linux VM Colima runs. Its default
 * shares only the user's home with the VM, so a mount from anywhere else finds
 * nothing, and shows a job every file it does share as root's and readable to
 * any uid, so the credential file's owner is the runner's to check and no
 * job's.
 */

import { open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative } from "node:path";

import { z } from "zod";

import {
  claudeCredentialDescribed,
  claudeCredentialFile,
  claudeCredentialSchema,
  claudeCredentialSetting,
} from "@chuggy/worker-core/claudeCredential.mjs";
import { ownerImagesSchema } from "@chuggy/worker-core/containerBackend.mjs";
import { bindMountNameable } from "@chuggy/worker-core/engineArgv.mjs";
import { imageUnusedSecsMaxDefault } from "@chuggy/worker-core/imageCleanup.mjs";
import { reservedJobVariables } from "@chuggy/worker-core/job.mjs";
import { registerDeclaredSchema } from "@chuggy/worker-core/register.mjs";

/**
 * @typedef {z.infer<typeof runnerConfigSchema>} RunnerConfig
 * @typedef {import("@chuggy/worker-core/claudeCredential.mjs").ClaudeCredential} ClaudeCredential
 * @typedef {import("@chuggy/worker-core/claudeCredential.mjs").ClaudeCredentialSetting} ClaudeCredentialSetting
 */

/** The permission bits a group or anyone else would read or write by. */
const sharedModeBits = 0o077;

/** Far above what a runner's file holds, so a file past it is not one. */
const runnerConfigBytesMax = 64 * 1024;

const positiveSchema = z.number().int().positive().safe();

const nonnegativeSchema = z.number().int().nonnegative().safe();

/** The most GiB a key may keep free, so its bytes are still a safe integer. */
const freeGibMax = Math.floor(Number.MAX_SAFE_INTEGER / 2 ** 30);

/** A pool's service's own limits, each in place of the file's for that service alone. */
const poolLimitsSchema = z.strictObject({
  concurrencyMax: nonnegativeSchema.optional(),
  sessionsMax: nonnegativeSchema.optional(),
});

/** A name docker gives a network, less the host's own. */
const networkSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u)
  .refine((network) => network !== "host", {
    error: "may not be the host's network",
  });

const environmentSchema = z
  .record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
    z.string().regex(/^[^\r\n]*$/u, { error: "may not break a line" }),
  )
  .superRefine((environment, context) => {
    for (const name of reservedJobVariables)
      if (Object.hasOwn(environment, name))
        context.addIssue({
          code: "custom",
          path: [name],
          message: "is the runner's to set",
        });
  });

/** A credential's file, which each job is handed by a bind mount. */
const credentialFileSchema = z
  .string()
  .refine((file) => isAbsolute(file), { error: "must be an absolute path" })
  .refine((file) => bindMountNameable(file), {
    error: "cannot be named in a bind mount",
  });

/** The keys a credential of any kind names its file under. */
const credentialFileKeys = /** @type {const} */ ([
  "tokenFile",
  "apiKeyFile",
  "credentialsFile",
]);

/** The core's credential, its file held to what a bind mount names. */
const credentialSchema = claudeCredentialSchema.superRefine(
  (credential, context) => {
    for (const key of credentialFileKeys) {
      const file = /** @type {Record<string, unknown>} */ (credential)[key];
      if (file === undefined) continue;
      for (const issue of credentialFileSchema.safeParse(file).error?.issues ??
        [])
        context.addIssue({
          code: "custom",
          path: [key],
          message: issue.message,
        });
    }
  },
);

export const runnerConfigSchema = z
  .strictObject({
    /** The jobs held at once, none where it is 0, as on a runner kept for sessions. */
    concurrencyMax: nonnegativeSchema.default(1),
    /** The sessions held beside the jobs, none where it is 0. */
    sessionsMax: nonnegativeSchema.default(2),
    /** Where `claude setup-token`'s output was saved, a subscription's credential. */
    claudeTokenFile: credentialFileSchema.optional(),
    /** The credential Claude Code runs on, of any kind, in place of `claudeTokenFile`. */
    claudeCredential: credentialSchema.optional(),
    /** The `auth.json` `codex login` writes, which a job requiring `Agent:Codex` is handed. */
    codexCredential: z
      .strictObject({ authFile: credentialFileSchema })
      .optional(),
    timeoutSecsMax: positiveSchema,
    outputBytesMax: positiveSchema,
    environment: environmentSchema.default({}),
    network: networkSchema.default("chuggy-jobs"),
    /**
     * The images a job that pins none runs in, each with the capabilities its
     * owner declares it meets: the first meeting every one the job names.
     */
    images: ownerImagesSchema.default([]),
    /**
     * What this Mac meets beside its platforms and the agents the file can
     * run, which each pool's service advertises in place of what
     * `--capability` declared when its pool was registered.
     */
    capabilities: registerDeclaredSchema.optional(),
    /**
     * Limits of a pool's own, by its pool file's name without `.json`, as
     * `runnerPoolName` names it.
     */
    pools: z.record(z.string(), poolLimitsSchema).default({}),
    /**
     * How long a job's image this runner pulled may go unused before it is
     * removed, 0 keeping them until the disk is under `diskFreeGibMin`.
     */
    imageUnusedSecsMax: nonnegativeSchema.default(imageUnusedSecsMaxDefault),
    /**
     * The GiB docker's storage in Colima's VM keeps free: under it the agent
     * removes the images it may and takes no job, and under half of it stops
     * one. None is kept where it is 0.
     */
    diskFreeGibMin: nonnegativeSchema.max(freeGibMax).default(20),
    /**
     * The GiB of the VM's memory its containers leave free, a reserve for
     * what the VM and docker use outside every container. The rest is the
     * budget every running container and every held job is counted against:
     * a job is held from its claim until it has room, and is taken only where
     * it fits. None is kept unless the file sets it, so the whole of the VM's
     * memory is the budget.
     */
    memoryFreeGibMin: nonnegativeSchema.max(freeGibMax).default(0),
    /**
     * The GiB of the budget no job may ask for, kept for what always runs
     * beside the jobs. The rest is the ceiling: a job asking more is refused,
     * and a plane that claims by room offers none. A session may ask the
     * whole budget. None is reserved where it is 0.
     */
    memoryReservedGib: nonnegativeSchema.max(freeGibMax).default(0),
    /** Whether a run installs the release chuggy names, or only says it is out. */
    autoUpdate: z.boolean().default(true),
  })
  // Beside whatever else the file gets wrong, as a missing key always was.
  .superRefine(configCredentialNamed, {
    when: ({ value }) => typeof value === "object" && value !== null,
  })
  .superRefine(configCredentialChecked)
  .superRefine(configLimitsChecked);

/**
 * Holds the file to naming a Claude credential, telling one that names
 * neither key what one that named no token file always was.
 *
 * @param {Partial<RunnerConfig>} config
 * @param {z.core.$RefinementCtx} context
 */
function configCredentialNamed(config, context) {
  if (
    config.claudeTokenFile === undefined &&
    config.claudeCredential === undefined
  )
    context.addIssue({
      code: "invalid_type",
      expected: "string",
      input: undefined,
      path: ["claudeTokenFile"],
    });
}

/**
 * Holds the file to naming one Claude credential.
 *
 * @param {RunnerConfig} config
 * @param {z.core.$RefinementCtx} context
 */
function configCredentialChecked(config, context) {
  if (
    config.claudeTokenFile !== undefined &&
    config.claudeCredential !== undefined
  )
    context.addIssue({
      code: "custom",
      path: ["claudeCredential"],
      message:
        "names a Claude credential, and so does claudeTokenFile; keep one",
    });
}

/**
 * Holds the file to a runner that takes some work, and each pool's service
 * its `pools` entry limits to one that takes some.
 *
 * @param {RunnerConfig} config
 * @param {z.core.$RefinementCtx} context
 */
function configLimitsChecked(config, context) {
  if (config.concurrencyMax === 0 && config.sessionsMax === 0)
    context.addIssue({
      code: "custom",
      path: ["concurrencyMax"],
      message: "is 0 and so is sessionsMax, so this runner would take no work",
    });
  for (const [name, own] of Object.entries(config.pools)) {
    const limits = runnerPoolLimitsOver(config, own);
    if (limits.concurrencyMax === 0 && limits.sessionsMax === 0)
      context.addIssue({
        code: "custom",
        path: ["pools", name],
        message:
          "leaves this pool's service concurrencyMax 0 and sessionsMax 0, so it would take no work",
      });
  }
}

/**
 * The Claude credential a checked file names: its `claudeCredential`, or a
 * subscription's token where it names `claudeTokenFile`.
 *
 * @param {RunnerConfig} config
 * @returns {ClaudeCredential}
 */
export function runnerClaudeCredential(config) {
  if (config.claudeCredential !== undefined) return config.claudeCredential;
  if (config.claudeTokenFile === undefined)
    throw new Error("the runner's file names no Claude credential");
  return { kind: "Subscription", tokenFile: config.claudeTokenFile };
}

/** The agent `codexCredential` is the credential of, as an `Agent:` capability names it. */
export const runnerCodexAgent = "Codex";

/** How a refusal names the Codex credential's file, and what its owner does to make one. */
export const codexCredentialDescribed = {
  label: "Codex auth file",
  remedy: "run codex login, which writes it to ~/.codex/auth.json",
};

/**
 * What the backends are handed of a checked file's credentials: the Claude
 * credential's file and the setting that names its kind, which every run
 * names so that the core withholds what would choose another, and the file of
 * each other agent it names a credential for, by that agent's name.
 *
 * @param {RunnerConfig} config
 * @returns {{tokenFile: string, claudeCredential: ClaudeCredentialSetting, agentCredentialFiles: Record<string, string>}}
 */
export function runnerCredentialsHanded(config) {
  const credential = runnerClaudeCredential(config);
  return {
    tokenFile: claudeCredentialFile(credential),
    claudeCredential: claudeCredentialSetting(credential),
    agentCredentialFiles:
      config.codexCredential === undefined
        ? {}
        : { [runnerCodexAgent]: config.codexCredential.authFile },
  };
}

/**
 * How a refusal names the credential file of an agent, and what its owner
 * does to make one: Claude's by the kind its setting names.
 *
 * @param {ClaudeCredentialSetting} claudeCredential
 * @param {string} agent
 * @returns {{label: string, remedy: string}}
 */
export function runnerCredentialDescribed(claudeCredential, agent) {
  return agent === runnerCodexAgent
    ? codexCredentialDescribed
    : claudeCredentialDescribed(claudeCredential);
}

/**
 * The name a pool's own limits are found by in `pools`: its file's, without
 * `.json`, as `register` writes it and its agent is labelled for it.
 *
 * @param {string} poolFile
 */
export function runnerPoolName(poolFile) {
  return basename(poolFile, ".json");
}

/**
 * The limits a pool's service holds: those its entry in `pools` names, and
 * the file's for the rest.
 *
 * @param {RunnerConfig} config
 * @param {string} poolFile
 */
export function runnerPoolLimits(config, poolFile) {
  return runnerPoolLimitsOver(config, runnerPoolOwn(config, poolFile));
}

/**
 * @param {RunnerConfig} config
 * @param {RunnerConfig["pools"][string] | undefined} own
 */
function runnerPoolLimitsOver(config, own) {
  return {
    concurrencyMax: own?.concurrencyMax ?? config.concurrencyMax,
    sessionsMax: own?.sessionsMax ?? config.sessionsMax,
  };
}

/**
 * A pool's entry in `pools`, or nothing.
 *
 * @param {RunnerConfig} config
 * @param {string} poolFile
 */
function runnerPoolOwn(config, poolFile) {
  const name = runnerPoolName(poolFile);
  return Object.hasOwn(config.pools, name) ? config.pools[name] : undefined;
}

/**
 * How many jobs and sessions a pool's service holds at once, in the file's
 * own terms, and whether its entry in `pools` sets them.
 *
 * @param {RunnerConfig} config
 * @param {string} poolFile
 */
export function runnerConfigLimits(config, poolFile) {
  const { concurrencyMax, sessionsMax } = runnerPoolLimits(config, poolFile);
  const own =
    runnerPoolOwn(config, poolFile) === undefined
      ? ""
      : `, as pools.${runnerPoolName(poolFile)} sets them`;
  return `concurrencyMax ${String(concurrencyMax)}, sessionsMax ${String(sessionsMax)}${own}`;
}

/**
 * The runner's file, checked and read through one handle so the file checked
 * is the file read.
 *
 * @param {string} file
 * @returns {Promise<RunnerConfig>}
 */
export async function runnerConfig(file) {
  const handle = await open(file, "r");
  let text;
  try {
    const stats = await handle.stat();
    if (!stats.isFile())
      throw new Error(`runner configuration ${file} is not a file`);
    if ((stats.mode & sharedModeBits) !== 0)
      throw new Error(
        `runner configuration ${file} is mode ${(stats.mode & 0o777).toString(8)}; only its owner may read or write it (chmod 600)`,
      );
    if (stats.size > runnerConfigBytesMax)
      throw new Error(`runner configuration ${file} is larger than one`);
    text = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error(`runner configuration ${file} is not JSON`);
  }
  const parsed = runnerConfigSchema.safeParse(document);
  if (!parsed.success)
    throw new Error(
      `runner configuration ${file}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`,
    );
  return parsed.data;
}

/**
 * Whether `path` is `directory` or lies beneath it, by name alone.
 *
 * @param {string} directory
 * @param {string} path
 */
function beneath(directory, path) {
  const under = relative(directory, path);
  return under !== ".." && !under.startsWith("../");
}

/**
 * Why this runner cannot hand its jobs a credential's file, or nothing. The
 * path a job's mount names must sit under the home the VM shares, and so must
 * the file it leads to, since the VM follows a link in its own
 * filesystem. The file must be the runner's own and no one else's on this Mac.
 * Only its metadata is read: the credential reaches the job by mount and never
 * this process.
 *
 * @param {{label: string, remedy: string}} described how the file is named, as `runnerCredentialDescribed` names it
 * @param {string} file
 * @param {{uid: number, home: string}} runner this process's uid, which must own the file, and the home the VM shares
 * @returns {Promise<string | undefined>}
 */
export async function credentialFileRefusal(described, file, runner) {
  const { label, remedy } = described;
  let real;
  let realHome;
  let stats;
  try {
    real = await realpath(file);
    realHome = await realpath(runner.home);
    stats = await stat(real);
  } catch {
    return `the ${label} ${file} cannot be found; ${remedy}`;
  }
  if (!beneath(runner.home, file) || !beneath(realHome, real))
    return `the ${label} ${file} is not under ${runner.home}, or leads outside it, and ${runner.home} is the only directory Colima shares with its VM by default, so a job would find nothing at its mount`;
  if (!stats.isFile()) return `the ${label} ${file} is not a file`;
  if ((stats.mode & sharedModeBits) !== 0)
    return `the ${label} ${file} is mode ${(stats.mode & 0o777).toString(8)}; only its owner may read or write it (chmod 600)`;
  if (stats.size === 0) return `the ${label} ${file} is empty; ${remedy}`;
  if (stats.uid !== runner.uid)
    return `the ${label} ${file} is owned by uid ${String(stats.uid)}, not by this runner's uid ${String(runner.uid)}`;
  return undefined;
}
