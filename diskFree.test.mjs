import assert from "node:assert/strict";
import test from "node:test";

import { diskFloorSaid, vmDiskFree } from "./diskFree.mjs";
import { fakeColima, fakeEngine } from "./engine.fixture.mjs";

const gib = 2 ** 30;

/**
 * Docker whose info says this beside its size and architecture.
 *
 * @param {Record<string, unknown>} info
 */
function dockerSaying(info) {
  const { engine, state } = fakeEngine();
  state.info = info;
  return engine;
}

/** Docker in Colima's default VM, storing images through containerd. */
const snapshotter = {
  Name: "colima",
  DockerRootDir: "/var/lib/docker",
  DriverStatus: [["driver-type", "io.containerd.snapshotter.v1"]],
};

/** Docker in Colima's default VM, storing images itself. */
const overlay = {
  Name: "colima",
  DockerRootDir: "/var/lib/docker",
  DriverStatus: [["Backing Filesystem", "extfs"]],
};

test("docker's free disk is measured in Colima's VM: its root directory's, and containerd's beside it where its images are stored through containerd, the lower of them", async () => {
  const rooted = fakeColima(40);
  assert.deepEqual(await vmDiskFree(dockerSaying(overlay), rooted.colima), {
    free: 40 * gib,
    where: "/var/lib/docker in Colima's VM",
  });
  assert.deepEqual(rooted.calls, [
    ["ssh", "--profile", "default", "--", "df", "-P", "-k", "/var/lib/docker"],
  ]);
  const both = fakeColima(40, { paths: { "/var/lib/containerd": 12.5 } });
  assert.deepEqual(await vmDiskFree(dockerSaying(snapshotter), both.colima), {
    free: 12.5 * gib,
    where: "/var/lib/containerd in Colima's VM",
  });
  assert.deepEqual(both.measured, ["/var/lib/docker", "/var/lib/containerd"]);
  assert.deepEqual(
    await vmDiskFree(
      dockerSaying({ ...overlay, DriverStatus: null }),
      fakeColima(3).colima,
    ),
    { free: 3 * gib, where: "/var/lib/docker in Colima's VM" },
  );
});

test("a VM Colima does not run, docker that cannot be asked or answers otherwise, and a VM that cannot be measured, are unknown", async () => {
  const { colima, calls } = fakeColima(30);
  assert.deepEqual(
    await vmDiskFree(
      dockerSaying({ ...overlay, Name: "docker-desktop" }),
      colima,
    ),
    {
      unknown:
        "docker names its machine docker-desktop, which is no Colima VM, so its disk cannot be measured",
    },
  );
  assert.deepEqual(await vmDiskFree(dockerSaying({ Name: "colima" }), colima), {
    unknown: "docker answered an info this runner cannot read",
  });
  const { engine, state } = fakeEngine();
  state.unreachable = true;
  assert.match(
    /** @type {{unknown: string}} */ (await vmDiskFree(engine, colima)).unknown,
    /^docker could not be asked where it stores what it holds: Cannot connect to the Docker daemon/u,
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(
    await vmDiskFree(dockerSaying({ ...overlay, Name: "colima-work" }), colima),
    {
      unknown:
        '/var/lib/docker could not be measured in Colima\'s VM work: time="2026-10-27T22:38:17-04:00" level=fatal msg="colima [profile=work] not running"',
    },
  );
  for (const stdout of [
    "Filesystem 1024-blocks Used Available Capacity Mounted on\n",
    "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vdb1 1 1 lots 1% /var/lib/docker\n",
  ])
    assert.deepEqual(
      await vmDiskFree(dockerSaying(overlay), {
        exec: async () => ({ code: 0, stdout, stderr: "" }),
      }),
      {
        unknown:
          "df in Colima's VM default answered what this runner cannot read",
      },
    );
});

test("doctor and status say the free disk against the floor, warning where it is unmeasured or under, and none is held at 0", async () => {
  const engine = dockerSaying(overlay);
  /** @param {number} diskFreeGibMin */
  const config = (diskFreeGibMin) =>
    /** @type {import("./runnerConfig.mjs").RunnerConfig} */ (
      /** @type {unknown} */ ({ diskFreeGibMin })
    );
  const said = await Promise.all(
    /** @type {const} */ ([
      [20, 20],
      [20, 19.5],
      [20, 10],
      [20, 9.9],
      [0, 1],
    ]).map(([min, free]) =>
      diskFloorSaid(config(min), engine, fakeColima(free).colima),
    ),
  );
  const where = "/var/lib/docker in Colima's VM";
  assert.deepEqual(said, [
    {
      detail: `20 GiB free at ${where}, over the floor of 20 GiB`,
      warning: false,
    },
    {
      detail: `19.5 GiB free at ${where}, under the floor of 20 GiB: the agent removes the images it may and takes no job until it is over`,
      warning: true,
    },
    {
      detail: `10 GiB free at ${where}, under the floor of 20 GiB: the agent removes the images it may and takes no job until it is over`,
      warning: true,
    },
    {
      detail: `9.9 GiB free at ${where}, under half the floor of 20 GiB: the agent removes the images it may, and stops a job each pass it is still under half`,
      warning: true,
    },
    {
      detail: "none: the runner's file sets diskFreeGibMin to 0",
      warning: false,
    },
  ]);
  assert.deepEqual(
    await diskFloorSaid(
      config(20),
      dockerSaying({ ...overlay, Name: "orbstack" }),
      fakeColima(30).colima,
    ),
    {
      detail:
        "none held, since the free disk could not be measured: docker names its machine orbstack, which is no Colima VM, so its disk cannot be measured",
      warning: true,
    },
  );
});
