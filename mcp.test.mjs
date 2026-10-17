/**
 * `mcp` end to end: the CLI started as a coding agent starts it, spoken to by
 * the SDK's own client over stdio, against a site and an issuer on this
 * machine's loopback.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, URL, URLSearchParams } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { localToolSignInFile } from "@chuggy/worker-core/localTools.mjs";

import { cliMain } from "./commands.mjs";
import { runnerPaths } from "./runnerPaths.mjs";

const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const ticketPath = "/api/v1/tenants/vteng/projects/chuggy/tickets/7";

function bodyOf(request) {
  return new Promise((resolve) => {
    let text = "";
    request.on("data", (chunk) => {
      text += chunk;
    });
    request.on("end", () => resolve(text));
  });
}

/** A site whose issuer is itself, issuing `access-N` and `renewal-N` for the Nth grant. */
async function siteOf(t) {
  const grants = [];
  const server = createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${String(server.address().port)}`;
    const json = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const path = new URL(request.url, origin).pathname;
    if (path === "/config.json")
      return json(200, {
        issuer: `${origin}/issuer`,
        audience: `${origin}/api`,
      });
    if (path === "/issuer/.well-known/openid-configuration")
      return json(200, {
        issuer: `${origin}/issuer`,
        authorization_endpoint: `${origin}/issuer/auth`,
        token_endpoint: `${origin}/issuer/token`,
      });
    if (path === "/issuer/token") {
      grants.push(
        Object.fromEntries(new URLSearchParams(await bodyOf(request))),
      );
      const n = String(grants.length);
      return json(200, {
        access_token: `access-${n}`,
        refresh_token: `renewal-${n}`,
        expires_in: 3_600,
      });
    }
    if (path === ticketPath)
      return request.headers.authorization?.startsWith("Bearer access-")
        ? json(200, { ticket: 7, phase: "Draft" })
        : json(401, { error: "Unauthenticated" });
    return json(404, {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { site: `http://127.0.0.1:${String(server.address().port)}`, grants };
}

/** A client that fails its test on any line on stdout that is not the protocol's. */
async function clientOf(t, home, site) {
  const client = new Client({ name: "suite", version: "1" });
  const strays = [];
  client.onerror = (failure) => strays.push(failure);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        cli,
        "mcp",
        "--site",
        site,
        "--workspace",
        "vteng",
        "--project",
        "chuggy",
      ],
      env: { HOME: home, PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    }),
  );
  t.after(async () => {
    await client.close();
    assert.deepEqual(strays, []);
  });
  return client;
}

async function homeOf(t) {
  const home = await mkdtemp(join(tmpdir(), "chuggy-darwin-mcp-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

function textOf(answer) {
  return answer.content.map(({ text }) => text).join("");
}

test("an agent is given the project tools and reads a ticket under a renewed sign-in", async (t) => {
  const { site, grants } = await siteOf(t);
  const home = await homeOf(t);
  const file = localToolSignInFile(runnerPaths(home).signIns, site);
  await mkdir(runnerPaths(home).signIns, { recursive: true });
  await writeFile(file, "renewal-0\n", { mode: 0o600 });

  const client = await clientOf(t, home, site);
  const names = (await client.listTools()).tools.map(({ name }) => name);
  assert.ok(names.includes("create_draft"));
  assert.ok(names.includes("release_draft"));
  assert.ok(!names.includes("dispatch"));

  const answer = await client.callTool({
    name: "read_ticket",
    arguments: { ticket: 7 },
  });
  assert.equal(answer.isError, undefined, textOf(answer));
  assert.match(textOf(answer), /^HTTP 200\n/);
  assert.equal(grants[0].refresh_token, "renewal-0");
  assert.equal((await readFile(file, "utf8")).trim(), "renewal-1");
});

test("with no sign-in, a call answers a page whose answer signs the next call in", async (t) => {
  const { site } = await siteOf(t);
  const home = await homeOf(t);
  const client = await clientOf(t, home, site);

  const refused = await client.callTool({
    name: "read_ticket",
    arguments: { ticket: 7 },
  });
  assert.equal(refused.isError, true);
  const link = /open (\S+) and sign in/u.exec(textOf(refused))?.[1];
  assert.ok(link !== undefined, textOf(refused));
  const query = new URL(link).searchParams;
  const answered = await globalThis.fetch(
    `${query.get("redirect_uri")}?code=the-code&state=${query.get("state")}`,
  );
  assert.equal(answered.status, 200);

  const read = await client.callTool({
    name: "read_ticket",
    arguments: { ticket: 7 },
  });
  assert.match(textOf(read), /^HTTP 200\n/);
});

/**
 * `mcp` asked of a child with no input, so an ask whose refusal regressed
 * ends rather than serving on this suite's own stdin.
 */
function mcpAsked(args) {
  const asked = spawnSync(process.execPath, [cli, "mcp", ...args], {
    input: "",
    timeout: 10_000,
    env: { HOME: "/nowhere", PATH: "" },
    encoding: "utf8",
  });
  return { status: asked.status, err: asked.stderr };
}

test("mcp is asked with a site a credential may be sent to, a workspace and a project, and nothing else", async () => {
  const named = ["--workspace", "vteng", "--project", "chuggy"];
  const site = ["--site", "https://chuggy.test"];
  const unsited = mcpAsked(named);
  assert.equal(unsited.status, 2);
  assert.match(unsited.err, /need a site/);
  const plain = mcpAsked(["--site", "http://chuggy.test", ...named]);
  assert.equal(plain.status, 2);
  assert.match(plain.err, /https/);
  assert.equal(mcpAsked([...site, ...named, "--pool", "x"]).status, 2);
  assert.equal(mcpAsked(["extra", ...site, ...named]).status, 2);
});

test("every other command refuses mcp's options", async () => {
  const host = {
    environment: {},
    home: "/nowhere",
    err: () => {},
    out: () => {},
  };
  const site = ["--site", "https://chuggy.test"];
  assert.equal(
    await cliMain(
      ["register", "--api", "https://chuggy.test", "--token=x", ...site],
      host,
    ),
    2,
  );
  assert.equal(await cliMain(["run", ...site, "--pool", "x"], host), 2);
});
