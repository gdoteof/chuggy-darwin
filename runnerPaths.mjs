/**
 * Where the runner reads and writes on a Mac. A pool file is where chuggy-linux
 * keeps one, so one registration serves either runner of a machine.
 */

import { join } from "node:path";

/**
 * @typedef {object} RunnerPaths
 * @property {string} config the runner's own file
 * @property {string} agents where launchd reads the user's agents
 * @property {string} pools the directory register writes pool files to
 * @property {string} signIns where `mcp` keeps each site's sign-in
 * @property {string} logs where an ended job's logs are saved
 * @property {string} jobs where a job run on the Mac itself has its directory
 * @property {string} images where the record of docker's images is kept
 * @property {string} runtime where each pool's pull credentials, env files and control socket live
 */

/**
 * @param {string} home
 * @returns {RunnerPaths}
 */
export function runnerPaths(home) {
  const library = join(home, "Library");
  return {
    config: join(
      library,
      "Application Support",
      "chuggy-darwin",
      "runner.json",
    ),
    agents: join(library, "LaunchAgents"),
    pools: join(home, ".config", "chuggy", "pools"),
    signIns: join(home, ".config", "chuggy", "sign-ins"),
    logs: join(library, "Logs", "chuggy-darwin"),
    jobs: join(library, "Application Support", "chuggy-darwin", "jobs"),
    images: join(library, "Application Support", "chuggy-darwin", "images"),
    runtime: join(library, "Caches", "chuggy-darwin"),
  };
}
