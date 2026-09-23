const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const loadSource = require("../helpers/load-source.cjs");

function resolver(platform) {
  const files = new Set();
  const settings = {};
  const extension = { exports: {} };
  const folder = path.resolve("test workspace");
  const pathFolder =
    platform !== "win32" && process.platform === "win32"
      ? path.relative(path.parse(folder).root, folder)
      : folder;
  let registry = "";
  const api = loadSource("src/Terminal/options.ts", {
    vscode: {
      extensions: { getExtension: () => extension },
      workspace: {
        getConfiguration: () => ({ get: (key) => settings[key] }),
        workspaceFolders: [{ uri: { fsPath: folder } }],
        getWorkspaceFolder: () => ({ uri: { fsPath: folder } }),
      },
      window: { activeTextEditor: { document: { uri: { fsPath: path.join(folder, "file.R") } } } },
    },
    fs: { existsSync: (file) => files.has(file) },
    child_process: { spawnSync: () => ({ stdout: registry }) },
  }, { "process.platform": JSON.stringify(platform), "process.env.PATH": JSON.stringify(pathFolder) });
  return { ...api, files, settings, extension, folder, pathFolder, setRegistry: (value) => { registry = value; } };
}

for (const platform of ["linux", "darwin", "win32"]) {
  test(`R resolution precedence and vscode-R rollback (${platform})`, () => {
    const r = resolver(platform);
    const help = path.join(r.folder, "help-R");
    const configured = path.join(r.folder, "configured-R");
    const legacy = path.join(r.folder, "legacy-R");
    const onPath = path.join(r.pathFolder, platform === "win32" ? "R.exe" : "R");
    [help, configured, legacy, onPath].forEach((file) => r.files.add(file));
    r.extension.exports.helpPanel = { rPath: help };
    r.settings.executablePath = configured;
    r.settings[r.getPlatformRPathConfigEntry()] = legacy;
    assert.equal(r.discoverRBinaryPath(), help);
    r.extension.exports = {}; // Older/newer vscode-R without the help API.
    assert.equal(r.discoverRBinaryPath(), configured);
    delete r.settings.executablePath;
    assert.equal(r.discoverRBinaryPath(), legacy);
    r.files.delete(legacy);
    assert.equal(r.discoverRBinaryPath(), onPath);
    r.files.delete(onPath);
    const registryR = path.join(r.folder, "bin", "R.exe");
    r.files.add(registryR);
    r.setRegistry(`    InstallPath    REG_SZ    ${r.folder}\r\n`);
    assert.equal(r.discoverRBinaryPath(), platform === "win32" ? registryR : undefined);
    r.files.delete(registryR);
    assert.equal(r.discoverRBinaryPath(), undefined);
  });
}

test("configured paths expand workspace variables, quotes, and executable names", () => {
  const r = resolver(process.platform);
  const binary = path.join(r.folder, process.platform === "win32" ? "custom-R.exe" : "custom-R");
  r.files.add(binary);
  for (const variable of ["workspaceFolder", "fileWorkspaceFolder", "fileDirname"]) {
    r.settings.executablePath = `"\${${variable}}/${path.basename(binary)}"`;
    // Variable replacement retains the slash in the setting on Windows.
    r.files.add(`${r.folder}/${path.basename(binary)}`);
    assert.equal(r.discoverRBinaryPath(), `${r.folder}/${path.basename(binary)}`);
  }
  r.settings.executablePath = "custom-R";
  assert.equal(r.discoverRBinaryPath(), binary);
});
