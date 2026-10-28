#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { fileURLToPath, URL } from "node:url";

import { cliMain } from "./commands.mjs";

const manifest = JSON.parse(
  readFileSync(new URL("package.json", import.meta.url), "utf8"),
);

process.exit(
  await cliMain(process.argv.slice(2), {
    environment: process.env,
    home: homedir(),
    uid: process.getuid?.() ?? -1,
    hostname: hostname(),
    arch: process.arch,
    fetch: globalThis.fetch,
    packageName: manifest.name,
    version: manifest.version,
    node: process.execPath,
    nodeVersion: process.versions.node,
    cli: fileURLToPath(import.meta.url),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  }),
);
