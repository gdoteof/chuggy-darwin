# chuggy-darwin — working notes

A Mac's worker pool for chuggy, being built after chuggy-linux: a CLI that registers the machine as a pool and runs the pool loop, under a launchd agent, from the worker core (`@chuggy/worker-core`, kasofsk/chuggy-common) over its container backend, through docker on a Linux VM, and its host backend for a pool registered with `--host`. `README.md` is the operator's page.

## Where the knowledge is

- **Each gate's own header.** Every script in `.chug/tasks/` opens by stating the rule it enforces, and its sibling `*.test.sh` proves the rule bites. The rule and its enforcement are the same file.
- **chuggy's review brief**, [`review-change.md`](https://github.com/kasofsk/chuggy/blob/main/.chug/tasks/review-change.md). Its house rules and standing commitments bind here, for the rules no script can decide.
- **The loop and the wire are not this tree's.** The pool loop, its token source, its plane client, the credentials reader, registration, the control socket and the container backend with its engine are the worker core's, consumed by commit as chuggy-linux consumes them; the contract is chuggy's, locked to a GitHub release asset by URL and integrity. A change here that needs either to be different is a change there first, then a pin or lock bump here. What is a Mac's alone, its paths, its service manager and whether a job can be handed the Claude credential's file through its VM, is this tree's.

## Layout

Every module sits at the root. `cli.mjs` is the entry and holds nothing but the call; `commands.mjs` is the commands, `doctor.mjs` what `doctor` checks, `power.mjs` the idle-sleep assertion while work is held, `runner.mjs` a run composed from the files and docker, `runnerConfig.mjs` the runner's file and the credential-file rule, `runnerPaths.mjs` where the runner and `mcp` read and write, `launchAgent.mjs` a pool's launchd agent, and `mcp.mjs` the MCP SDK handed to the core's local tool server. Suites are `*.test.mjs` and their shared doubles `*.fixture.mjs`. `package.json`'s `files` is the shipped set, which `shipped.test.mjs` holds to every module but those, and `bundleDependencies` carries the core, the contract, zod and the MCP SDK inside the tarball, so an install needs neither git nor the contract's release.

## Checks

```sh
just check          # every gate and the gates' own suites
just pack           # the installable tarball
```

A fresh clone needs two things once, and neither can set itself:

```sh
npm ci              # the pinned core, the locked contract release and the toolchain the gates run
just hooks          # git config core.hooksPath .githooks
```

A gate exits 0 clean, 1 on a finding, **2 when it could not run** — and 2 is not a pass. `check-source` runs the suites only when `check-contract` finds the locked release installed; an `npm link` to a local chuggy is a could-not-run, never a green run. The hook runs the gates without the shell suites; `--no-verify` bypasses every gate at once. No suite needs a container engine, the network or the rig.

## Conventions that bite if you miss them

- **Nothing reviews its own work.** A change is reviewed by a fresh reviewer, a session that did not author it, under chuggy's review brief.
- **Docs are concise, correct, consistent and extremely minimal, and a comment is a doc.**
- **A doc that says a path, gate, command or constant exists is making a factual claim, and that claim is checked or it is marked.** A markdown line naming something this tree does not have carries a marker: `<!-- intent -->` designed but not built, `<!-- runtime -->` correctly absent from git, `<!-- absent -->` named because it does not exist. `check-paths` still resolves and prints a marked line. A path of chuggy's or the core's is named as theirs; `check-paths` cannot see another repository's paths, so the reviewer holds that.
- **No comment states a quantity a reader has to trust.** A figure is one the code or a suite derives, never one copied into prose.
- **A rule needs a failure it can prevent here.** Before adding one, name the thing that goes wrong in this tree without it.
- **Don't run destructive commands** without asking first.
