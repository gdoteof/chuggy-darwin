/**
 * The runner's own file, and whether it can hand a job the Claude token file.
 * The file is refused unless only its owner can read or write it, and is read
 * strictly, so a misspelt key is an error rather than a default. The pool's
 * credentials are the worker core's to read.
 *
 * Docker is the one engine, reached in the Linux VM Colima runs. Its default
 * shares only the user's home with the VM, so a mount from anywhere else finds
 * nothing, and shows a job every file it does share as root's and readable to
 * any uid, so the token file's owner is the runner's to check and no job's.
 */

import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

import { z } from "zod";

import { ownerImagesSchema } from "@chuggy/worker-core/containerBackend.mjs";
import { reservedJobVariables } from "@chuggy/worker-core/job.mjs";

/** @typedef {z.infer<typeof runnerConfigSchema>} RunnerConfig */

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

export const runnerConfigSchema = z.strictObject({
  concurrencyMax: positiveSchema.default(1),
  /** The sessions held beside the jobs, none where it is 0. */
  sessionsMax: z.number().int().nonnegative().safe().default(2),
  /** Where `claude setup-token`'s output was saved, named in a bind mount. */
  claudeTokenFile: z
    .string()
    .refine((file) => isAbsolute(file), { error: "must be an absolute path" })
    .refine((file) => !/[,\r\n]/u.test(file), {
      error: "cannot be named in a bind mount",
    }),
  timeoutSecsMax: positiveSchema,
  outputBytesMax: positiveSchema,
  environment: environmentSchema.default({}),
  network: networkSchema.default("chuggy-jobs"),
  /**
   * The images a job that pins none runs in, each with the capabilities its
   * owner declares it meets: the first meeting every one the job names.
   */
  images: ownerImagesSchema.default([]),
});

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
 * Why this runner cannot hand its jobs the Claude token file, or nothing. The
 * path a job's mount names must sit under the home the VM shares, and so must
 * the file it leads to, since the VM follows a link in its own filesystem. The
 * file must be the runner's own and no one else's on this Mac. Only its
 * metadata is read: the token reaches the job by mount and never this process.
 *
 * @param {string} file
 * @param {{uid: number, home: string}} runner this process's uid, which must own the file, and the home the VM shares
 * @returns {Promise<string | undefined>}
 */
export async function claudeTokenFileRefusal(file, runner) {
  let real;
  let realHome;
  let stats;
  try {
    real = await realpath(file);
    realHome = await realpath(runner.home);
    stats = await stat(real);
  } catch {
    return `the Claude token file ${file} cannot be found; save \`claude setup-token\`'s output there`;
  }
  if (!beneath(runner.home, file) || !beneath(realHome, real))
    return `the Claude token file ${file} is not under ${runner.home}, or leads outside it, and ${runner.home} is the only directory Colima shares with its VM by default, so a job would find nothing at its mount`;
  if (!stats.isFile()) return `the Claude token file ${file} is not a file`;
  if ((stats.mode & sharedModeBits) !== 0)
    return `the Claude token file ${file} is mode ${(stats.mode & 0o777).toString(8)}; only its owner may read or write it (chmod 600)`;
  if (stats.size === 0) return `the Claude token file ${file} is empty`;
  if (stats.uid !== runner.uid)
    return `the Claude token file ${file} is owned by uid ${String(stats.uid)}, not by this runner's uid ${String(runner.uid)}`;
  return undefined;
}
