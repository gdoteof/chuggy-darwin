/**
 * The launchd agent a pool's service runs under, one per pool file, so several
 * pools serve from one Mac. It is named for the pool file, as
 * `chuggy-darwin.<base>` in `chuggy-darwin.<base>.plist`, and restarts the
 * runner after any exit but 0: a run exits 0 only when the plane denied the
 * pool, and no restart of it would be answered differently. A run that
 * installed a release of itself exits `updatedExitStatus`, and is restarted
 * on that release.
 *
 * An agent loads into the user's desktop session, launchd's `gui` domain for
 * them, which exists only while they are logged in at the Mac's screen. On a
 * Mac reached only over ssh there is none, and an agent written for the
 * user's background session, which their `user` domain loads, runs instead.
 */

import { execFile } from "node:child_process";
import { basename } from "node:path";

/**
 * The exit status of a run that installed a release of itself, to be started
 * again on it: sysexits' `EX_TEMPFAIL`.
 */
export const updatedExitStatus = 75;

/** What every agent's label of this runner begins with. */
const launchAgentPrefix = "chuggy-darwin.";

/** What a property list's file name ends with. */
const launchAgentSuffix = ".plist";

/** The longest file name APFS takes, in bytes, which these names spend one per character. */
const fileNameBytesMax = 255;

/** The longest pool file name, less `.json`, whose agent's property list can be named for it. */
export const launchAgentBaseCharsMax =
  fileNameBytesMax - launchAgentPrefix.length - launchAgentSuffix.length;

/** The cap on asking launchd whether the user has a desktop session, which guards a hung launchctl. */
const launchctlCallMsMax = 30_000;

/** The seconds launchd waits before starting a runner again, so one that cannot reach docker does not spin. */
const restartIntervalSecs = 10;

/** The umask a run writes under, so what it makes is its owner's alone. */
const ownerOnlyUmask = 0o077;

/**
 * The label of the agent serving a pool file, named for the file less its
 * `.json`, refused where the name holds a character a label is not given here
 * or is too long to name the agent's file. Every name register writes is
 * taken: it writes only letters, digits, hyphens, underscores and dots.
 *
 * @param {string} poolFile
 */
export function launchAgentLabel(poolFile) {
  const base = basename(poolFile, ".json");
  if (!/^[A-Za-z0-9._-]+$/u.test(base))
    throw new RangeError(
      `${poolFile} is not named as an agent can be: letters, digits, dots, underscores and hyphens; rename the pool file`,
    );
  if (base.length > launchAgentBaseCharsMax)
    throw new RangeError(
      `${poolFile} makes an agent's file name longer than a Mac takes; give the pool file a shorter name`,
    );
  return `${launchAgentPrefix}${base}`;
}

/** @param {string} label */
export function launchAgentFileName(label) {
  return `${label}${launchAgentSuffix}`;
}

/**
 * Whether launchd started this process as the agent serving `poolFile`: it
 * names each job it starts by its label in `XPC_SERVICE_NAME`.
 *
 * @param {Readonly<Record<string, string | undefined>>} environment
 * @param {string} poolFile
 */
export function launchAgentRunning(environment, poolFile) {
  try {
    return environment.XPC_SERVICE_NAME === launchAgentLabel(poolFile);
  } catch {
    return false;
  }
}

/** @param {string} text */
function xmlEscaped(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** @param {string} text */
function xmlUnescaped(text) {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** @param {string} text */
const plistString = (text) => `<string>${xmlEscaped(text)}</string>`;

/**
 * @param {{label: string, node: string, cli: string, poolFile: string, path: string, log: string, background: boolean}} agent absolute paths but the label, the PATH the runner finds docker on, and whether it is the background session's
 */
export function launchAgentPlist(agent) {
  const argv = [agent.node, agent.cli, "run", "--pool", agent.poolFile];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  ${plistString(agent.label)}`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...argv.map((argument) => `    ${plistString(argument)}`),
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>PATH</key>",
    `    ${plistString(agent.path)}`,
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    ...(agent.background
      ? [
          "  <key>LimitLoadToSessionType</key>",
          `  ${plistString("Background")}`,
        ]
      : []),
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>ThrottleInterval</key>",
    `  <integer>${String(restartIntervalSecs)}</integer>`,
    "  <key>Umask</key>",
    `  <integer>${String(ownerOnlyUmask)}</integer>`,
    "  <key>StandardOutPath</key>",
    `  ${plistString(agent.log)}`,
    "  <key>StandardErrorPath</key>",
    `  ${plistString(agent.log)}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/**
 * The pool file an agent this runner wrote serves, read back from its
 * arguments, or nothing for a property list it did not write.
 *
 * @param {string} plist the property list's text
 * @returns {string | undefined}
 */
export function launchAgentPoolFile(plist) {
  const array =
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(
      plist,
    )?.[1];
  if (array === undefined) return undefined;
  const argv = [...array.matchAll(/<string>([^<]*)<\/string>/gu)].map(
    ([, text]) => xmlUnescaped(text),
  );
  const pool = argv.indexOf("--pool");
  return pool < 0 ? undefined : argv[pool + 1];
}

/**
 * The PATH an agent this runner wrote runs the runner with, read back from its
 * environment, or nothing for a property list it did not write.
 *
 * @param {string} plist the property list's text
 * @returns {string | undefined}
 */
export function launchAgentPath(plist) {
  const path =
    /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>PATH<\/key>\s*<string>([^<]*)<\/string>/u.exec(
      plist,
    )?.[1];
  return path === undefined ? undefined : xmlUnescaped(path);
}

/**
 * One argument of a command the operator is told to run, quoted for a POSIX
 * shell unless it holds only characters no shell reads specially.
 *
 * @param {string} argument
 */
export function shellQuoted(argument) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(argument)
    ? argument
    : `'${argument.replaceAll("'", "'\\''")}'`;
}

/**
 * Whether an agent's property list this runner wrote is the background
 * session's.
 *
 * @param {string} plist the property list's text
 */
export function launchAgentBackground(plist) {
  return /<key>LimitLoadToSessionType<\/key>\s*<string>Background<\/string>/u.test(
    plist,
  );
}

/**
 * Whether the user has a desktop session for an agent to load into: whether
 * launchd has a `gui` domain for them.
 *
 * @param {number} uid
 * @param {string} [launchctl] the launchctl asked, where not the one on PATH
 * @returns {Promise<boolean>}
 */
export function launchAgentDesktop(uid, launchctl = "launchctl") {
  return new Promise((resolve) => {
    execFile(
      launchctl,
      ["print", `gui/${String(uid)}`],
      { timeout: launchctlCallMsMax },
      (error) => resolve(error === null),
    );
  });
}

/**
 * The launchd domain an agent loads into, the user's desktop session's or
 * their background session's.
 *
 * @param {{uid: number, background: boolean}} agent
 */
function launchAgentDomain(agent) {
  return `${agent.background ? "user" : "gui"}/${String(agent.uid)}`;
}

/**
 * What the operator runs once an agent's file is written: the agent unloaded
 * where it was loaded, and loaded afresh, which reads the file anew.
 *
 * @param {{uid: number, label: string, plist: string, background: boolean}} agent
 */
export function launchAgentCommands(agent) {
  const domain = launchAgentDomain(agent);
  return [
    `launchctl bootout ${domain}/${agent.label} 2>/dev/null`,
    `launchctl bootstrap ${domain} ${shellQuoted(agent.plist)}`,
  ];
}

/**
 * What the operator runs to restart a loaded agent, as after registering its
 * pool again.
 *
 * @param {{uid: number, label: string, background: boolean}} agent
 */
export function launchAgentRestart(agent) {
  return `launchctl kickstart -k ${launchAgentDomain(agent)}/${agent.label}`;
}
