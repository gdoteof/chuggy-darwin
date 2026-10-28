# chuggy-darwin

Runs a chuggy worker pool's jobs on a Mac, Apple silicon or Intel. It registers the machine as a pool and runs the pool, from a terminal or under a launchd agent that keeps it running. Jobs run as Linux containers through docker in Colima's VM, from the worker core chuggy-linux runs, and, for a pool registered with `--host`, on the Mac itself.

It needs Node 24 or later, the docker CLI and Colima: `brew install node docker colima`, then `colima start`. On Apple silicon, install Rosetta too, `softwareupdate --install-rosetta --agree-to-license`, and start Colima with `colima start --vz-rosetta`: most work asks for amd64, which an arm64 VM takes only where it runs amd64 through Rosetta, since QEMU, which it runs amd64 through otherwise, is many times slower.

## Install

```sh
npm i -g https://github.com/kasofsk/chuggy-darwin/releases/download/v0.4.0/chuggy-darwin-0.4.0.tgz
```

One tarball serves Apple silicon and Intel. It carries its dependencies, so the install fetches nothing else. `just pack` builds it from a checkout, where `./cli.mjs` stands for `chuggy-darwin`. `chuggy-darwin --version` names the copy installed, and a run keeps it on the release chuggy names: see [Updates](#updates).

## Register

Mint a registration token for the pool in chuggy, then:

```sh
chuggy-darwin register --api <chuggy's origin> --token=<token>
```

Give the token with `=`: a token can begin with `-`, which `--token <token>` would read as an option.

Colima must be running: this asks docker which architecture its VM runs before it spends the token, then declares that platform, `Platform:Linux:Arm64` for an arm64 VM, as Colima's default is on Apple silicon, or `Platform:Linux:Amd64` for an x86_64 one, and writes the pool file chuggy answers with to `~/.config/chuggy/pools/`, named for its tenant, project and pool: `vteng.chuggy.shame.json`. `--api` must be https unless it is this machine's loopback. The secret goes only into the file, mode 600.

A project's task can require capabilities rather than pin an image, such as `Agent:Claude` or `Tool:Xcode`, and is offered only to a pool advertising every one. `register` declares the agents runner.json can run, so write [runner.json](#run) first: `Agent:Claude` for its Claude credential and `Agent:Codex` for its `codexCredential`, each where an `images` entry declares it or the pool is registered with `--host`; where it cannot read runner.json, it says so and declares none. Declare anything else this machine meets with `--capability <token>`, as often as needed; a token is letters, digits, `_`, `:` and `-`, and the platform is never one, since `register` finds it. `--host` declares the Mac's own platform too, `Platform:MacOS:Arm64` or `Platform:MacOS:Amd64`, and has the pool file say so, so that work naming it runs on the Mac: see [Work that pins no image](#work-that-pins-no-image). The registration token must permit each, or chuggy refuses it and the token stays unspent.

The pool's agent advertises on every poll what it finds when it starts, in place of what the pool was registered with: docker's VM's platform, and on an arm64 VM `Platform:Linux:Amd64` beside it where Colima runs amd64 there through Rosetta, the Mac's under `--host`, the agents runner.json can run, found as `register` finds them, and runner.json's `capabilities` or, where it is absent, the rest of what the pool was registered with, less any agent it has no image or host to run. So an edit to runner.json, or Colima started again with another architecture, takes effect when the agent restarts; register again only for a new Mac or pool.

The pool takes the hostname's first label unless `--pool <name>` names it; a name is lowercase letters, digits and hyphens. Registering a pool again, from here or any machine, replaces its registration, and chuggy denies the earlier one.

### A personal runner

A member's personal runner runs only that member's work, in the projects they allowlist for it in chuggy. A tenant administrator grants the member the right to register one; the member mints a personal registration token for the tenant through chuggy's API, `POST /api/v1/tenants/:tenant/personal-runner-registration-tokens`, then:

```sh
chuggy-darwin register --api <chuggy's origin> --token=<token> --personal
```

It takes no `--pool`, and the file is named for the tenant and the member: `vteng.28_3ahttps_3a_2f_2fauth_2echuggy_2eexample_2f0f3c9a52-member.json`. A member may register a personal runner on each of their machines, and every one serves the same projects. Registering again here writes this machine's file over; the registration it held before stays in chuggy, offline once nothing runs it, until its member removes it in chuggy's console. Every other command takes its file as it takes a pool's.

## Run

Colima must be running (`colima start`, whose VM is vz with virtiofs mounts by default; other mount types are untested), with docker's context its unix socket. A job is sized against Colima's VM rather than the Mac, so start Colima with the CPUs and memory the pool's work asks for.

The runner reads `~/Library/Application Support/chuggy-darwin/runner.json`, mode 600:

```json
{
  "claudeTokenFile": "/Users/you/.config/chuggy/claude-token",
  "timeoutSecsMax": 3600,
  "outputBytesMax": 1048576
}
```

`claudeTokenFile` is where `claude setup-token`'s output was saved, a Claude subscription's token; `claudeCredential` names a credential of any kind instead, and a file names one or the other. `codexCredential` (none), `concurrencyMax` (1), `sessionsMax` (2), `environment`, `network` (`chuggy-jobs`), `images` (none), `capabilities` (none, never a platform, each once), `pools` (none), `imageUnusedSecsMax` (a week, 604800), `diskFreeGibMin` (20), `memoryFreeGibMin` (0), `memoryReservedGib` (0) and `autoUpdate` (`true`) are optional. On a pool registered with `--host`, `environment` may not name `HOME` or `TMPDIR`, which each host job has of its own.

Each pool's agent runs `concurrencyMax` jobs and `sessionsMax` sessions at once. Set `sessionsMax` to 0 to run no sessions, or `concurrencyMax` to 0 to run sessions alone, as a runner kept for a project's lead does; a file setting both to 0 is refused, since that runner would take no work. A job no runner has room for waits until one has. `pools` sets one pool's agent apart from the rest, keyed by its pool file's name without `.json`; each limit it names replaces the file's for that agent alone. A personal runner that takes jobs beside a project's pool kept for its lead:

```json
"concurrencyMax": 2,
"pools": { "vteng.chuggy.lead": { "concurrencyMax": 0, "sessionsMax": 1 } }
```

An agent reads this file when it starts, so restart it after an edit; `status` and `doctor` print the limits the file now gives the pool they are given, and `doctor` warns of an entry naming no file in `~/.config/chuggy/pools`.

**The disk floor** is `diskFreeGibMin`, held each pass against the space free where docker stores what it holds, which is Colima's VM's disk and not the Mac's: the least of the filesystems under docker's root directory, and under `/var/lib/containerd` where docker stores images through containerd, measured in the VM with `colima ssh`, so `colima` must be on the agent's PATH. Under it, the agent removes the images it may, as the hourly removal below does but keeping only the newest of chuggy's runtime and session images and removing a job's image whatever `imageUnusedSecsMax` says, and takes no job until the disk is over it. Under half of it, it also kills one job a pass, never a session, which chuggy shows as Disk low, waiting for you to free space in the VM and resume it. A VM Colima does not run, such as Docker Desktop's, cannot be measured, and no floor is held. `doctor` and `status` say what is free against the floor; 0 keeps none.

**The memory budget** is the memory of Colima's VM, as docker's `info` says, less `memoryFreeGibMin`, which is kept for what the VM and docker use outside every container. Every running container in the VM counts against it, whichever agent started it: a job or session a runner ran at its memory cap, and anything else at what `docker stats` says it uses. A job is held from when its agent takes it, before its image is pulled, and starts once the room left takes its cap and every job held before it has started; one whose deadline comes too near to start fails as a job lost on its runner, which chuggy resumes up to its retry limit. `memoryReservedGib` is kept from jobs for what always runs beside them, such as a database: a job asking more than the rest, the ceiling, is refused. Each poll tells chuggy the room and the ceiling, so a chuggy that reads them offers only jobs that fit, and the agents on this Mac take those one at a time. Sessions are counted but never held, and may ask the whole budget. Jobs on the Mac itself are not counted. `status` says the room, the budget, the ceiling, the sessions' caps and whether the agent takes jobs, and why a held job waits.

```json
"claudeCredential": { "kind": "Subscription", "tokenFile": "/Users/you/.config/chuggy/claude-token" }
"claudeCredential": { "kind": "ApiKey", "apiKeyFile": "/Users/you/.config/chuggy/anthropic-api-key" }
"claudeCredential": { "kind": "Bedrock", "region": "us-west-2", "apiKeyFile": "/Users/you/.config/chuggy/bedrock-api-key" }
"claudeCredential": { "kind": "Bedrock", "region": "us-west-2", "credentialsFile": "/Users/you/.config/chuggy/aws-credentials", "profile": "chuggy" }
"claudeCredential": { "kind": "Vertex", "region": "us-east5", "project": "your-project", "credentialsFile": "/Users/you/.config/chuggy/vertex-key.json" }
"claudeCredential": { "kind": "Foundry", "resource": "your-resource", "apiKeyFile": "/Users/you/.config/chuggy/foundry-api-key" }
```

- **Subscription**: `claude setup-token`'s output, alone. Jobs share your Claude plan's limits.
- **ApiKey**: a key from the Claude Console, alone. It must be scoped to a workspace: the API refuses an unscoped key unless the request names a workspace in an `anthropic-workspace-id` header, and a job's Claude Code is never handed `ANTHROPIC_CUSTOM_HEADERS`, the variable that could add one.
- **Bedrock**: the AWS region, and a Bedrock API key alone, or an AWS credentials file whose `profile`, `default` where none is named, holds an access key's `aws_access_key_id` and `aws_secret_access_key`. SSO, role and `credential_process` profiles are not read.
- **Vertex**: the region, the Google Cloud project, and the JSON key Google Cloud made for a service account.
- **Foundry**: the Foundry resource and one of its keys, alone. Name its deployments in `environment`, as `ANTHROPIC_DEFAULT_SONNET_MODEL` and its like.

The credential is one file: mode 600, yours, and under your home, the only directory Colima shares with its VM by default, as named and through any link. Every job and session is told the kind, and handed the file, mounted read-only into a container or read where it is by a job on the Mac itself. A run never reads it. `doctor` alone does, printing only its kind and settings, and every secret in it is scrubbed from what a job or session reports. Claude Code is told its credential is the runner's, so a checkout's own settings choose no other provider and send the credential nowhere else. It is handed only the credential `claudeCredential` or `claudeTokenFile` names: a variable in `environment` that would choose another or where it is sent, such as `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` or, beside Bedrock, `AWS_PROFILE`, reaches the commands a job runs for the project, its checks among them, but never Claude Code or a command it runs. Every kind but Subscription is billed by its provider.

The Codex credential is `codexCredential`, the `auth.json` `codex login` writes, whether you log in with ChatGPT or an API key, held to the same rules as the Claude one's file:

```json
"codexCredential": { "authFile": "/Users/you/.codex/auth.json" }
```

A job whose task requires `Agent:Codex` is handed this file in place of the Claude credential's, as that one is handed; every other job and every session is handed the Claude one. On a runner that names no `codexCredential`, a job requiring `Agent:Codex` is handed the Claude one; a job requiring two agents is refused. A job copies `auth.json` into a Codex home of its own that is thrown away, so keep the file here fresh yourself. `doctor` checks it where runner.json names it or the pool advertises `Agent:Codex`, printing none of it, and warns where no pool here advertises `Agent:Codex` for it.

```sh
chuggy-darwin run --pool ~/.config/chuggy/pools/<file>  # until the plane denies the pool
chuggy-darwin once --pool <file>  # one pass
chuggy-darwin status --pool <file>
chuggy-darwin stop <assignment> --pool <file>
chuggy-darwin doctor --pool <file>  # everything a run needs, changing nothing
```

`CHUGGY_DARWIN_POOL` names the pool file where `--pool` does not. `run` exits 0 when the plane denies the pool, since only a new registration brings it back, and 75 once it has installed a release of itself; `once` exits 1 on a denial as on any pass that did not reconcile. `doctor` first names the copy speaking and the Node it runs under. It also says what a run advertises, warning where an arm64 VM runs no amd64 through Rosetta, and warns where no agent serves the pool. While the pool holds work, a run keeps the Mac from idle sleep with `caffeinate -i`, since a sleeping Mac pauses the VM and the work's leases lapse; a closed lid on battery still sleeps. Each pool's control socket, pull credentials and env files live in `~/Library/Caches/chuggy-darwin/`, and ended jobs' logs in `~/Library/Logs/chuggy-darwin/`.

Hourly, a run removes images in Colima's VM that no runner here needs: of each repository chuggy's runtime or sessions came from, every untagged image but the two most recently used, and a job's image this runner pulled once it has gone unused for `imageUnusedSecsMax`, which 0 turns off until the disk is under its floor. No removal is forced, so an image a container uses stays, and neither is one with a tag but the one a job pulled it by; to keep an image, tag it. Every runner on this Mac keeps one record of what it used, in `~/Library/Application Support/chuggy-darwin/images/docker.json`.

A private image is pulled with your own docker login for its registry: run `docker login ghcr.io` once on the Mac, as you. An agent runs with the PATH of the shell `install-agent` was run from and no other variable, so a `DOCKER_CONFIG` set only in a shell does not reach it, and a credential helper your docker configuration names, such as `osxkeychain`, must be on that PATH. The registry the pool was registered for is the exception: a pull from it presents the pool's own token.

## Work that pins no image

A task that pins no image names capabilities instead, and this runner meets them with what you give it. A job naming the VM's platform runs in the first image `images` lists declaring every capability it names, its platform aside, and is otherwise refused:

```json
"images": [{ "image": "ghcr.io/you/swift:6", "capabilities": ["Agent:Claude", "Tool:Swift"] }]
```

On a pool registered with `--host`, a job naming the Mac's platform runs on the Mac itself: as you, in a directory of its own under `~/Library/Application Support/chuggy-darwin/jobs/`, with its own `HOME` and temporary directory, the run's environment and `environment`, and `git` and its agent's command, such as `claude`, found on the run's `PATH`, which for an agent is the shell's `install-agent` was run from. `doctor` names the `claude` such a job runs, and the `codex` where runner.json names a Codex credential, with their versions. It is sized against the Mac, not the VM. Nothing isolates it. It can read and change whatever you can, the other jobs here among it, and reach whatever the Mac reaches; register with `--host` only a Mac whose every project you trust that far. A session, and a job that pins an image, still runs in a container. A host job is killed, with every process it started, at the sooner of `timeoutSecsMax` and its deadline, or when the runner is stopped; its log is saved beside a container's, and its directory is removed when it ends. A runner killed outright, by `SIGKILL` or the kernel, leaves its host jobs running until they end.

## Agent

```sh
chuggy-darwin install-agent --pool <file>
```

This writes `~/Library/LaunchAgents/chuggy-darwin.<pool file less .json>.plist`, which runs `run` for that pool file under the `node` and with the PATH of this shell, since launchd's own PATH finds no Homebrew docker; it takes the link on PATH, such as `/opt/homebrew/bin/node`, which an upgrade keeps. It takes no other variable, so a `DOCKER_HOST` or `DOCKER_CONTEXT` set in the shell does not reach the agent, which uses docker's current context. It prints how to load it. launchd starts the agent when the user logs in to the Mac's desktop, and again after any exit but 0, after a pause, so an agent started before Colima tries again; a pool the plane denied stays down. It runs only while the user is logged in. Its output goes to `~/Library/Logs/chuggy-darwin/chuggy-darwin.<pool file less .json>.log`. `brew services start colima` starts Colima at login too.

Where nobody is logged in at the Mac's screen, as on a Mac reached only over ssh, launchd has no desktop session to load an agent into. `install-agent` then writes the agent for the user's background session instead, and prints how to load it into launchd's `user` domain, where it runs on after the ssh session ends. After the Mac restarts, start Colima and run those commands again.

An agent runs the registration it read when it started, so registering again a pool or personal runner its agent serves prints the `launchctl kickstart` that restarts it on the new one.

## Updates

A run keeps itself on the release chuggy names for it. Once chuggy names a newer one, the run downloads and checks it, installs it over itself and exits 75, and launchd starts the agent again on the new copy; a run started by hand says to start it again. A container runs on through the restart. A job on the Mac itself, from a pool registered with `--host`, would end with the run, so it holds the update back: where the pool holds one, the run checks the release first, then takes no new work until that job ends.

Before installing a release, it checks that the release is this package, newer than the copy running, downloaded from chuggy-darwin's own GitHub releases, byte for byte the one chuggy named, and that it runs under the run's Node and names its own version. Only then does npm install it where this copy is installed. A release that fails a check, or an install that fails, leaves the running copy serving, and the log says why and when it tries again.

It cannot update a copy npm did not install globally, or one under a prefix this user cannot write. `doctor` says whether updates are on, and warns where this install cannot take one. To turn them off, set `"autoUpdate": false` in runner.json and restart the agent; the log then says only that a release is out.

## Tools for your coding agent

```sh
claude mcp add chuggy -- chuggy-darwin mcp --site <origin> --workspace <workspace> --project <project>
```

`mcp` serves a coding agent on this Mac the `chuggy` tools a session pod has, for one project: it reads, drafts and releases tickets under your own sign-in, and decides nothing. It takes no pool file. The first call with no sign-in answers with the site's sign-in address for the agent to hand you; the sign-in returns to a page `mcp` holds on `127.0.0.1`, so it is opened in a browser on this Mac. Once you sign in, calls go through, and the token is renewed ahead of its expiry. The renewal token is kept in `~/.config/chuggy/sign-ins`, in a file only you can read, one per site, shared by every chat on the Mac.
