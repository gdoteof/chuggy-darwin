/**
 * A container engine held in memory, answering the runner's argv with the
 * words docker 28 prints. A pull waits on whatever the suite hands it, so a
 * suite decides how long one takes and how it ends.
 */

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { constants } from "node:os";
import { dirname } from "node:path";

/**
 * @typedef {import("@chuggy/worker-core/engine.mjs").EngineAnswer} EngineAnswer
 *
 * @typedef {object} FakeContainer
 * @property {string} id
 * @property {string} name
 * @property {Record<string, string>} labels
 * @property {string} status
 * @property {string} image
 * @property {string[]} [env] each `NAME=value`, as an inspection lists them
 * @property {number} [exitCode]
 *
 * @typedef {object} FakeCall
 * @property {string[]} argv
 * @property {Record<string, string>} environment
 * @property {string} [envFile] the env file's text as `run` found it
 * @property {string} [authFile] the pull credential's text as `pull` found it
 * @property {string} [authDirectory] the directory it was found in
 *
 * @typedef {ReturnType<typeof fakeEngineState>} FakeEngineState
 */

const unreachable =
  "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";

/**
 * @param {string} stderr
 * @returns {EngineAnswer}
 */
const failed = (stderr, code = 1) => ({
  code,
  stdout: "",
  stderr: `${stderr}\n`,
});

/**
 * @param {string} stdout
 * @returns {EngineAnswer}
 */
const answered = (stdout = "") => ({ code: 0, stdout, stderr: "" });

/** The variable an image sets, which an inspection lists beside the env file's. */
const imagePath = "PATH=/usr/local/bin:/usr/bin:/bin";

/** What a container a kill ended exits with, as a shell reports a death by signal. */
const killedExitCode = 128 + constants.signals.SIGKILL;

/** @param {string} reference */
const missing = (reference) =>
  failed(`Error response from daemon: No such container: ${reference}`);

/**
 * @param {string[]} argv
 * @param {string} flag
 */
function flagValues(argv, flag) {
  return argv.flatMap((value, index) =>
    index > 0 && argv[index - 1] === flag ? [value] : [],
  );
}

/** @param {AbortSignal | undefined} signal */
function aborted(signal) {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      reject(error);
    });
  });
}

function fakeEngineState() {
  const state = {
    /** @type {Map<string, FakeContainer>} */
    containers: new Map(),
    images: new Set(),
    networks: new Set(),
    /** @type {FakeCall[]} */
    calls: [],
    unreachable: false,
    logsFail: false,
    /** Whether a kill runs past the engine's cap, which the engine answers as interrupted. */
    killInterrupted: false,
    /** Whether a run runs past the engine's cap after its container started, which the engine answers as interrupted. */
    runInterrupted: false,
    /** The VM docker runs containers in, as `info` reports it: Colima's default. */
    machine: { cpus: 2, memoryBytes: 2 * 1024 ** 3, architecture: "aarch64" },
    /**
     * The endpoint docker's current context names, or none when its context
     * cannot be read.
     *
     * @type {string | undefined}
     */
    contextHost: "unix:///Users/shame/.colima/default/docker.sock",
    nextId: 1,
    /**
     * How a pull ends; the default finds the image.
     *
     * @type {(image: string, call: FakeCall) => EngineAnswer | Promise<EngineAnswer>}
     */
    pull: (image) => {
      state.images.add(image);
      return answered();
    },
  };
  return state;
}

/**
 * @param {FakeEngineState} state
 * @param {string} reference a name or an id
 */
function found(state, reference) {
  return (
    state.containers.get(reference) ??
    [...state.containers.values()].find(
      (container) => container.id === reference,
    )
  );
}

/**
 * @param {FakeEngineState} state
 * @param {FakeCall} call
 */
function run(state, call) {
  const { argv } = call;
  const [name] = flagValues(argv, "--name");
  call.envFile = readFileSync(flagValues(argv, "--env-file")[0], "utf8");
  const existing = state.containers.get(name);
  if (existing !== undefined)
    return failed(
      `docker: Error response from daemon: Conflict. The container name "/${name}" is already in use by container "${existing.id}". You have to remove (or rename) that container to be able to reuse that name.`,
      125,
    );
  const labels = Object.fromEntries(
    flagValues(argv, "--label").map((label) => {
      const equals = label.indexOf("=");
      return [label.slice(0, equals), label.slice(equals + 1)];
    }),
  );
  const id = `c${String(state.nextId++).padStart(63, "0")}`;
  const image = argv.at(-1) ?? "";
  const env = [
    imagePath,
    ...call.envFile.split("\n").filter((line) => line.length > 0),
  ];
  state.containers.set(name, {
    id,
    name,
    labels,
    status: "running",
    image,
    env,
    exitCode: 0,
  });
  if (state.runInterrupted)
    return { code: -1, stdout: "", stderr: "", failed: "Interrupted" };
  return answered(`${id}\n`);
}

/**
 * @param {FakeEngineState} state
 * @param {string[]} references
 */
function inspected(state, references) {
  const matched = references.map((reference) => found(state, reference));
  const absent = references.filter((_, index) => matched[index] === undefined);
  const document = matched.flatMap((container) =>
    container === undefined
      ? []
      : [
          {
            Id: container.id,
            Name: `/${container.name}`,
            Config: { Labels: container.labels, Env: container.env ?? null },
            State: { Status: container.status, ExitCode: container.exitCode },
          },
        ],
  );
  const stdout = `${JSON.stringify(document)}\n`;
  return absent.length === 0
    ? answered(stdout)
    : { ...missing(absent[0]), stdout };
}

/**
 * @param {FakeEngineState} state
 * @param {FakeCall} call
 */
function pulled(state, call) {
  const auth =
    flagValues(call.argv, "--authfile")[0] ??
    (call.environment.DOCKER_CONFIG === undefined
      ? undefined
      : `${call.environment.DOCKER_CONFIG}/config.json`);
  if (auth !== undefined) {
    call.authFile = readFileSync(auth, "utf8");
    call.authDirectory = dirname(auth);
  }
  return state.pull(call.argv.at(-1) ?? "", call);
}

/**
 * @param {FakeEngineState} state
 * @param {string} reference
 * @param {(container: FakeContainer) => void} change
 */
function changed(state, reference, change) {
  const container = found(state, reference);
  if (container === undefined) return missing(reference);
  change(container);
  return answered(`${reference}\n`);
}

/**
 * @param {FakeEngineState} state
 * @param {string} reference
 * @returns {EngineAnswer}
 */
function killed(state, reference) {
  if (state.killInterrupted)
    return { code: -1, stdout: "", stderr: "", failed: "Interrupted" };
  const container = found(state, reference);
  if (container !== undefined && container.status !== "running")
    return failed(
      `Error response from daemon: cannot kill container: ${reference}: container ${container.id} is not running`,
    );
  return changed(state, reference, (running) => {
    running.status = "exited";
    running.exitCode = killedExitCode;
  });
}

/**
 * @param {FakeEngineState} state
 * @param {string} network
 * @param {string} verb
 */
function networked(state, network, verb) {
  if (verb === "create") {
    state.networks.add(network);
    return answered("n1\n");
  }
  return state.networks.has(network)
    ? answered("[]\n")
    : failed(`Error response from daemon: network ${network} not found`);
}

/**
 * @param {FakeEngineState} state
 * @param {FakeCall} call
 * @returns {EngineAnswer | Promise<EngineAnswer>}
 */
function answer(state, call) {
  const [verb, second] = call.argv;
  const last = call.argv.at(-1) ?? "";
  if (state.unreachable) return failed(unreachable);
  if (verb === "image")
    return state.images.has(last)
      ? answered("sha256:1\n")
      : failed(`Error response from daemon: No such image: ${last}`);
  if (verb === "pull") return pulled(state, call);
  if (verb === "info") return answered(`${JSON.stringify(state.machine)}\n`);
  if (verb === "context")
    return state.contextHost === undefined
      ? failed('context "default": context not found')
      : answered(`${state.contextHost}\n`);
  if (verb === "run") return run(state, call);
  if (verb === "ps") {
    const wanted = flagValues(call.argv, "--filter").map((filter) => {
      const [key, ...value] = filter.replace(/^label=/u, "").split("=");
      return [key, value.join("=")];
    });
    return answered(
      [...state.containers.values()]
        .filter((container) =>
          wanted.every(([key, value]) => container.labels[key] === value),
        )
        .map((container) => `${container.id}\n`)
        .join(""),
    );
  }
  if (verb === "container") return inspected(state, call.argv.slice(2));
  if (verb === "kill") return killed(state, last);
  if (verb === "rm")
    return changed(state, last, (container) => {
      state.containers.delete(container.name);
    });
  if (verb === "network") return networked(state, last, second);
  return failed(`unknown command: ${call.argv.join(" ")}`);
}

export function fakeEngine() {
  const state = fakeEngineState();
  /** @type {import("@chuggy/worker-core/engine.mjs").Engine} */
  const engine = {
    exec: async (argv, engineCall = {}) => {
      /** @type {FakeCall} */
      const call = {
        argv: [...argv],
        environment: { ...engineCall.environment },
      };
      state.calls.push(call);
      engineCall.signal?.throwIfAborted();
      return Promise.race([answer(state, call), aborted(engineCall.signal)]);
    },
    execTail: async (argv) => {
      state.calls.push({ argv: [...argv], environment: {} });
      const reference = argv.at(-1) ?? "";
      const container = found(state, reference);
      const none = { tail: Buffer.alloc(0), cut: false, lines: 0 };
      if (state.unreachable) return { ...failed(unreachable), ...none };
      if (state.logsFail || container === undefined)
        return { ...missing(reference), ...none };
      const tail = Buffer.from(`the log of ${container.name}\n`);
      return { ...answered(), tail, cut: false, lines: 1 };
    },
  };
  return { engine, state };
}

/**
 * A promise and the hand that settles it, for a pull a suite ends by hand.
 *
 * @template T
 */
export function deferred() {
  /** @type {(value: T) => void} */
  let resolve = () => undefined;
  /** @type {Promise<T>} */
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
