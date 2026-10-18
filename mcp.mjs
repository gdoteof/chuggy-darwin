/**
 * `chuggy-darwin mcp`: the `chuggy` tools served on stdio to a coding agent on
 * this Mac, for one project, under its owner's own sign-in. Stdout is the
 * protocol's, so nothing here writes to it. The MCP SDK is this package's to
 * bundle; the server is the worker core's.
 */

import { readFile } from "node:fs/promises";
import { URL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { localToolServed } from "@chuggy/worker-core/localTools.mjs";
import * as z from "zod";

async function mcpVersion() {
  const manifest = JSON.parse(
    await readFile(new URL("./package.json", import.meta.url), "utf8"),
  );
  return String(manifest.version);
}

/**
 * Serves until the agent closes stdio.
 *
 * @param {{fetch: typeof globalThis.fetch}} host
 * @param {string} signIns
 * @param {{site: string, workspace: string, project: string}} asked
 */
export async function mcpServed(host, signIns, asked) {
  await localToolServed(
    { ...asked, version: await mcpVersion(), signIns, fetch: host.fetch },
    { McpServer, StdioServerTransport, z },
  );
  return 0;
}
