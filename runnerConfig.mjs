/**
 * The runner's own file, and whether it can hand a job its Claude credential's
 * file. The file is refused unless only its owner can read or write it, and is
 * read strictly, so a misspelt key is an error rather than a default. The
 * pool's credentials are the worker core's to read.
 *
 * THE FILE NAMES ONE CLAUDE CREDENTIAL, by `claudeCredential` of any kind the
 * core takes or by `claudeTokenFile`, a subscription's.
 *
 * Docker is the one engine, reached in the Linux VM Colima runs. Its default
 * shares only the user's home with the VM, so a mount from anywhere else finds
 * nothing, and shows a job every file it does share as root's and readable to
 * any uid, so the credential file's owner is the runner's to check and no
 * job's.
 */

import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

import { z } from "zod";

import {
  claudeCredentialDescribed,
  claudeCredentialFile,
  claudeCredentialSchema,
  claudeCredentialSetting,
} from "@chuggy/worker-core/claudeCredential.mjs";
import { ownerImagesSchema } from "@chuggy/worker-core/containerBackend.mjs";
import { reservedJobVariables } from "@chuggy/worker-core/job.mjs";

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
  .refine((file) => !/[,\r\n]/u.test(file), {
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
    concurrencyMax: positiveSchema.default(1),
    /** The sessions held beside the jobs, none where it is 0. */
    sessionsMax: z.number().int().nonnegative().safe().default(2),
    /** Where `claude setup-token`'s output was saved, a subscription's credential. */
    claudeTokenFile: credentialFileSchema.optional(),
    /** The credential Claude Code runs on, of any kind, in place of `claudeTokenFile`. */
    claudeCredential: credentialSchema.optional(),
    timeoutSecsMax: positiveSchema,
    outputBytesMax: positiveSchema,
    environment: environmentSchema.default({}),
    network: networkSchema.default("chuggy-jobs"),
    /**
     * The images a job that pins none runs in, each with the capabilities its
     * owner declares it meets: the first meeting every one the job names.
     */
    images: ownerImagesSchema.default([]),
  })
  // Beside whatever else the file gets wrong, as a missing key always was.
  .superRefine(configCredentialNamed, {
    when: ({ value }) => typeof value === "object" && value !== null,
  })
  .superRefine(configCredentialChecked);

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

/**
 * What each workload is handed of a checked file's Claude credential: the
 * file, and the setting that names its kind, which every run names so that
 * the core withholds what would choose another.
 *
 * @param {RunnerConfig} config
 * @returns {{tokenFile: string, claudeCredential: ClaudeCredentialSetting}}
 */
export function runnerClaudeHanded(config) {
  const credential = runnerClaudeCredential(config);
  return {
    tokenFile: claudeCredentialFile(credential),
    claudeCredential: claudeCredentialSetting(credential),
  };
}

/**
 * How many jobs and sessions each pool's service holds at once, in the file's
 * own terms.
 *
 * @param {RunnerConfig} config
 */
export function runnerConfigLimits(config) {
  return `concurrencyMax ${String(config.concurrencyMax)}, sessionsMax ${String(config.sessionsMax)}`;
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
 * Why this runner cannot hand its jobs its Claude credential's file, or
 * nothing. The path a job's mount names must sit under the home the VM shares,
 * and so must the file it leads to, since the VM follows a link in its own
 * filesystem. The file must be the runner's own and no one else's on this Mac.
 * Only its metadata is read: the credential reaches the job by mount and never
 * this process.
 *
 * @param {ClaudeCredentialSetting} setting the kind the file is, which names it
 * @param {string} file
 * @param {{uid: number, home: string}} runner this process's uid, which must own the file, and the home the VM shares
 * @returns {Promise<string | undefined>}
 */
export async function claudeCredentialFileRefusal(setting, file, runner) {
  const { label, remedy } = claudeCredentialDescribed(setting);
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
