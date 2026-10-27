const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const loadSource = require("./helpers/load-source.cjs");
const { stripCommentLines } = loadSource("src/Language/parser.ts");

test("submission normalization preserves raw-string values as evaluated by real R", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r-console-raw-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, "raw.R");
  const checks = require("./helpers/raw-string-cases.cjs").map(({ literal, content }) => {
    const source = stripCommentLines(`value <- ${literal}\n# outside`);
    return `${source}\nstopifnot(identical(value, ${JSON.stringify(content)}))`;
  });
  fs.writeFileSync(script, `${checks.join("\n")}\ncat("RAW_STRING_VALUES_OK\\n")\n`);
  const output = execFileSync(process.env.R_TEST_EXECUTABLE || "R", ["--vanilla", "--slave", "-f", script], {
    encoding: "utf8", timeout: 30000,
  });
  assert.match(output, /RAW_STRING_VALUES_OK/);
});
