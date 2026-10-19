# chuggy-darwin

Runs a chuggy worker pool's jobs on a Mac, Apple silicon or Intel. It registers the machine as a pool and runs the pool, from a terminal or under a launchd agent that keeps it running. Jobs run as Linux containers through docker in Colima's VM, from the worker core chuggy-linux runs, and, for a pool registered with `--host`, on the Mac itself.

It needs Node 24 or later, the docker CLI and Colima: `brew install node docker colima`, then `colima start`.

## Install

```sh
npm i -g https://github.com/kasofsk/chuggy-darwin/releases/download/v0.4.0/chuggy-darwin-0.4.0.tgz
```

One tarball serves Apple silicon and Intel. It carries its dependencies, so the install fetches nothing else. `just pack` builds it from a checkout, where `./cli.mjs` stands for `chuggy-darwin`.

## Register

Mint a registration token for the pool in chuggy, then:

```sh
chuggy-darwin register --api <chuggy's origin> --token=<token>
```

Give the token with `=`: a token can begin with `-`, which `--token <token>` would read as an option.

Colima must be running: this asks docker which architecture its VM runs before it spends the token, then declares that platform, `Platform:Linux:Arm64` for an arm64 VM, as Colima's default is on Apple silicon, or `Platform:Linux:Amd64` for an x86_64 one, and writes the pool file chuggy answers with to `~/.config/chuggy/pools/`, named for its tenant, project and pool: `vteng.chuggy.shame.json`. `--api` must be https unless it is this machine's loopback. The secret goes only into the file, mode 600.

A project's task can require capabilities rather than pin an image, such as `Agent:Claude` or `Tool:Xcode`, and is offered only to a pool declaring every one. Declare each this machine meets with `--capability <token>`, as often as needed; a token is letters, digits, `_`, `:` and `-`, and the platform is never one, since `register` finds it. `--host` declares the Mac's own platform too, `Platform:MacOS:Arm64` or `Platform:MacOS:Amd64`, and has the pool file say so, so that work naming it runs on the Mac: see [Work that pins no image](#work-that-pins-no-image). The registration token must permit each, or chuggy refuses it and the token stays unspent.

The pool takes the hostname's first label unless `--pool <name>` names it; a name is lowercase letters, digits and hyphens. Registering a pool again, from here or any machine, replaces its registration, and chuggy denies the earlier one.

### A personal runner

A member's personal runner runs only that member's work, in the projects they allowlist for it in chuggy. A tenant administrator grants the member the right to register one; the member mints a personal registration token for the tenant through chuggy's API, `POST /api/v1/tenants/:tenant/personal-runner-registration-tokens`, then:

```sh
chuggy-darwin register --api <chuggy's origin> --token=<token> --personal
```

It takes no `--pool`, and the file is named for the tenant and the member: `vteng.28_3ahttps_3a_2f_2fauth_2echuggy_2eexample_2f0f3c9a52-member.json`. A member has one personal runner in a tenant, so registering again, from here or any machine, replaces it as registering a pool again does. Every other command takes its file as it takes a pool's.

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

`claudeTokenFile` is where `claude setup-token`'s output was saved, a Claude subscription's token; `claudeCredential` names a credential of any kind instead, and a file names one or the other. `concurrencyMax` (1), `sessionsMax` (2), `environment`, `network` (`chuggy-jobs`) and `images` (none) are optional. On a pool registered with `--host`, `environment` may not name `HOME` or `TMPDIR`, which each host job has of its own.

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

```sh
chuggy-darwin run --pool ~/.config/chuggy/pools/<file>  # until the plane denies the pool
chuggy-darwin once --pool <file>  # one pass
chuggy-darwin status --pool <file>
chuggy-darwin stop <assignment> --pool <file>
chuggy-darwin doctor --pool <file>  # everything a run needs, changing nothing
```

`CHUGGY_DARWIN_POOL` names the pool file where `--pool` does not. `run` exits 0 when the plane denies the pool, since only a new registration brings it back; `once` exits 1 on a denial as on any pass that did not reconcile. `doctor` also fails where docker's VM no longer runs the platform the pool registered, as after `colima start --arch` with another architecture, and warns where no agent serves the pool. While the pool holds work, a run keeps the Mac from idle sleep with `caffeinate -i`, since a sleeping Mac pauses the VM and the work's leases lapse; a closed lid on battery still sleeps. Each pool's control socket, pull credentials and env files live in `~/Library/Caches/chuggy-darwin/`, and ended jobs' logs in `~/Library/Logs/chuggy-darwin/`.

A private image is pulled with your own docker login for its registry: run `docker login ghcr.io` once on the Mac, as you. An agent runs with the PATH of the shell `install-agent` was run from and no other variable, so a `DOCKER_CONFIG` set only in a shell does not reach it, and a credential helper your docker configuration names, such as `osxkeychain`, must be on that PATH. The registry the pool was registered for is the exception: a pull from it presents the pool's own token.

## Work that pins no image

A task that pins no image names capabilities instead, and this runner meets them with what you give it. A job naming the VM's platform runs in the first image `images` lists declaring every capability it names, its platform aside, and is otherwise refused:

```json
"images": [{ "image": "ghcr.io/you/swift:6", "capabilities": ["Agent:Claude", "Tool:Swift"] }]
```

On a pool registered with `--host`, a job naming the Mac's platform runs on the Mac itself: as you, in a directory of its own under `~/Library/Application Support/chuggy-darwin/jobs/`, with its own `HOME` and temporary directory, the run's environment and `environment`, and `git` and its agent's command, such as `claude`, found on the run's `PATH`, which for an agent is the shell's `install-agent` was run from. `doctor` names the `claude` such a job runs, and its version. It is sized against the Mac, not the VM. Nothing isolates it. It can read and change whatever you can, the other jobs here among it, and reach whatever the Mac reaches; register with `--host` only a Mac whose every project you trust that far. A session, and a job that pins an image, still runs in a container. A host job is killed, with every process it started, at the sooner of `timeoutSecsMax` and its deadline, or when the runner is stopped; its log is saved beside a container's, and its directory is removed when it ends. A runner killed outright, by `SIGKILL` or the kernel, leaves its host jobs running until they end.

## Agent

```sh
chuggy-darwin install-agent --pool <file>
```

This writes `~/Library/LaunchAgents/chuggy-darwin.<pool file less .json>.plist`, which runs `run` for that pool file under the `node` and with the PATH of this shell, since launchd's own PATH finds no Homebrew docker; it takes the link on PATH, such as `/opt/homebrew/bin/node`, which an upgrade keeps. It takes no other variable, so a `DOCKER_HOST` or `DOCKER_CONTEXT` set in the shell does not reach the agent, which uses docker's current context. It prints how to load it. launchd starts the agent when the user logs in to the Mac's desktop, and again after any exit but 0, after a pause, so an agent started before Colima tries again; a pool the plane denied stays down. It runs only while the user is logged in. Its output goes to `~/Library/Logs/chuggy-darwin/chuggy-darwin.<pool file less .json>.log`. `brew services start colima` starts Colima at login too.

Registering a pool its agent serves again replaces the registration the agent holds, so `register` prints the `launchctl kickstart` that restarts it.

## Tools for your coding agent

```sh
claude mcp add chuggy -- chuggy-darwin mcp --site <origin> --workspace <workspace> --project <project>
```

`mcp` serves a coding agent on this Mac the `chuggy` tools a session pod has, for one project: it reads, drafts and releases tickets under your own sign-in, and decides nothing. It takes no pool file. The first call with no sign-in answers with the site's sign-in address for the agent to hand you; the sign-in returns to a page `mcp` holds on `127.0.0.1`, so it is opened in a browser on this Mac. Once you sign in, calls go through, and the token is renewed ahead of its expiry. The renewal token is kept in `~/.config/chuggy/sign-ins`, in a file only you can read, one per site, shared by every chat on the Mac.
