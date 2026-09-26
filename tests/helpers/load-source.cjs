const { buildSync } = require("esbuild");
const Module = require("node:module");
const path = require("node:path");

// Bundle in memory so Node can test TS without VS Code or generated test files.
module.exports = function loadSource(source, mocks = {}, define = {}) {
  const filename = path.resolve(__dirname, "../..", source);
  const { outputFiles } = buildSync({
    entryPoints: [filename],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["vscode"],
    write: false,
    define,
  });
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = (id) => Object.hasOwn(mocks, id) ? mocks[id] : originalRequire(id);
  loaded._compile(outputFiles[0].text, filename);
  return loaded.exports;
};
