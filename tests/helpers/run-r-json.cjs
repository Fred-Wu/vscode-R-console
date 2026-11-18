const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Keep source and data out of Rscript's Windows command-line quoting and size
// limits. A file also lets R read Unicode and multiline inputs without loss.
function runRJson(source, input = null) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rconsole-probe-"));
  try {
    const script = path.join(directory, "probe.R");
    const data = path.join(directory, "input.json");
    fs.writeFileSync(data, JSON.stringify(input), "utf8");
    fs.writeFileSync(script,
      'inputs <- jsonlite::fromJSON(paste(readLines(commandArgs(TRUE)[1], encoding = "UTF-8", warn = FALSE), collapse = "\\n"), simplifyVector = FALSE)\n' + source,
      "utf8");
    return JSON.parse(execFileSync("Rscript", ["--vanilla", "--encoding=UTF-8", script, data], {
      encoding: "utf8", timeout: 15000,
    }));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { runRJson };
