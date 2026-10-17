// The runner's boundary: what a module at this repository's root may import.
//
// Every module here runs from the tarball `npm pack` builds, beside the
// packages it bundles and nothing else, and a suite is held to the same so that
// what it proves is what ships. So a module here reaches Node's own modules,
// its neighbours at the root, and the bundled packages, by name.
//
// Every rule below is proved to bite against a fixture tree carrying its
// violation, in `.chug/tasks/check-boundaries.test.sh`. A boundary rule that
// has never rejected anything is an unverified control.

/** A module of the runner: any `.mjs` at the root. */
const runner = "^[^/]+\\.mjs$";

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "runner-reaches-only-its-bundle",
      comment:
        "A module here reaches Node's own modules, its neighbours and the " +
        "packages the tarball bundles, and nothing else: a module it reached " +
        "anywhere else is one no install holds. The packages are named " +
        "rather than node_modules as a whole, because a devDependency " +
        "resolves in every suite here and in no install. Not reachability: " +
        "the `to` is everything but the exits, so a relay is caught at its " +
        "first edge.",
      severity: "error",
      from: { path: runner },
      to: {
        path: "^(?![^/]+\\.mjs$)",
        pathNot:
          "(^|/)node_modules/(@chuggy/worker-core|@chuggy/worker-contract|@modelcontextprotocol/sdk|zod)/",
        dependencyTypesNot: ["core"],
      },
    },
    {
      name: "runner-names-packages-by-name",
      comment:
        "A global install puts the bundled packages under this package's own " +
        "node_modules, so a relative path into node_modules/ spells a layout " +
        "only this checkout has.",
      severity: "error",
      from: { path: runner },
      to: {
        path: "(^|/)node_modules/",
        dependencyTypes: ["local"],
      },
    },
    {
      name: "runner-resolves-every-import",
      comment:
        "An import the resolver cannot follow is an edge dropped from the " +
        "graph, and the rules above then judge the runner without it: a " +
        "contract missing from node_modules/ would drop every contract " +
        "import at once. So an unresolved import is itself a finding.",
      severity: "error",
      from: { path: runner },
      to: { couldNotResolve: true },
    },
    {
      name: "no-circular-dependency",
      comment: "A cycle makes the order the modules load in unanswerable.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphan-module",
      comment:
        "A module nothing reaches and that reaches nothing is dead, or a " +
        "boundary nobody crossed; either way it is not what the tree claims " +
        "to hold.",
      severity: "error",
      from: { orphan: true },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "node", "default"],
      // An imported module whose extension is not listed is a leaf the cruise
      // does not follow.
      extensions: [".mjs", ".js"],
    },
  },
};
