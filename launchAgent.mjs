/**
 * The launchd agent a pool's service runs under, one per pool file, so several
 * pools serve from one Mac. It is named for the pool file, as
 * `chuggy-darwin.<base>` in `chuggy-darwin.<base>.plist`, and restarts the
 * runner after any exit but 0: a run exits 0 only when the plane denied the
 * pool, and no restart of it would be answered differently.
 */

import { basename } from "node:path";

/** What every agent's label of this runner begins with. */
const launchAgentPrefix = "chuggy-darwin.";

/** What a property list's file name ends with. */
const launchAgentSuffix = ".plist";

/** The longest file name APFS takes, in bytes, which these names spend one per character. */
const fileNameBytesMax = 255;

/** The longest pool file name, less `.json`, whose agent's property list can be named for it. */
export const launchAgentBaseCharsMax =
  fileNameBytesMax - launchAgentPrefix.length - launchAgentSuffix.length;

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
 * @param {{label: string, node: string, cli: string, poolFile: string, path: string, log: string}} agent absolute paths but the label, and the PATH the runner finds docker on
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
 * What the operator runs once an agent's file is written: the agent unloaded
 * where it was loaded, and loaded afresh, which reads the file anew.
 *
 * @param {{uid: number, label: string, plist: string}} agent
 */
export function launchAgentCommands(agent) {
  const domain = `gui/${String(agent.uid)}`;
  return [
    `launchctl bootout ${domain}/${agent.label} 2>/dev/null`,
    `launchctl bootstrap ${domain} ${shellQuoted(agent.plist)}`,
  ];
}

/**
 * What the operator runs to restart a loaded agent, as after registering its
 * pool again.
 *
 * @param {{uid: number, label: string}} agent
 */
export function launchAgentRestart(agent) {
  return `launchctl kickstart -k gui/${String(agent.uid)}/${agent.label}`;
}
