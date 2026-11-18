const assert = require("node:assert/strict");
const { test } = require("node:test");
const { assessAudit, checkResult } = require("../../scripts/audit-dependencies");

function fixture() {
  const advisory = {
    name: "picomatch",
    url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
    severity: "high",
  };
  const entries = [
    ["ovsx", "node_modules/ovsx", "1.4.0", ["@vscode/vsce"]],
    ["@vscode/vsce", "node_modules/@vscode/vsce", "4.1.1", ["tinyglobby"]],
    ["tinyglobby", "node_modules/tinyglobby", "0.2.17", ["fdir", "picomatch"]],
    ["fdir", "node_modules/tinyglobby/node_modules/fdir", "6.5.0", ["picomatch"]],
    ["picomatch", "node_modules/tinyglobby/node_modules/picomatch", "4.0.7", [advisory]],
  ];
  return {
    report: {
      auditReportVersion: 2,
      vulnerabilities: Object.fromEntries(entries.map(([name, nodePath, , via]) =>
        [name, { name, severity: "high", nodes: [nodePath], via }])),
      metadata: { vulnerabilities: { total: entries.length } },
    },
    lock: { packages: Object.fromEntries(entries.map(([, nodePath, version]) =>
      [nodePath, { version, dev: true }])) },
  };
}

test("allows the reviewed advisory and its inherited VSCE findings", () => {
  const { report, lock } = fixture();
  assert.deepEqual(assessAudit(report, lock), {
    allowed: ["ovsx", "@vscode/vsce", "tinyglobby", "fdir", "picomatch"], blocked: [],
  });
});

test("a second advisory in picomatch blocks the entire affected chain", () => {
  const { report, lock } = fixture();
  report.vulnerabilities.picomatch.via.push({
    name: "picomatch", url: "https://github.com/advisories/another-advisory", severity: "low",
  });
  assert.equal(assessAudit(report, lock).blocked.length, 5);
});

test("only the reviewed VSCE finding can be inherited by ovsx", () => {
  const { report, lock } = fixture();
  report.vulnerabilities.ovsx.via = ["picomatch"];
  assert.deepEqual(assessAudit(report, lock).blocked, ["ovsx"]);
});

test("an unrelated low-severity finding remains blocking", () => {
  const { report, lock } = fixture();
  report.vulnerabilities.other = { name: "other", severity: "low", via: [] };
  report.metadata.vulnerabilities.total++;
  assert.deepEqual(assessAudit(report, lock).blocked, ["other"]);
});

for (const [description, change] of [
  ["production use", (r, l, p) => { l.packages[p].dev = false; }],
  ["an unreviewed version", (r, l, p) => { l.packages[p].version = "4.0.8"; }],
  ["a missing lock entry", (r, l, p) => { delete l.packages[p]; }],
  ["an additional installation", (r) => { r.vulnerabilities.picomatch.nodes.push("node_modules/picomatch"); }],
  ["a different advisory", (r) => { r.vulnerabilities.picomatch.via[0].url += "-different"; }],
  ["increased severity", (r) => { r.vulnerabilities.picomatch.severity = "critical"; }],
  ["an unknown dependency cause", (r) => { r.vulnerabilities.picomatch.via = ["unknown"]; }],
  ["a dependency cycle", (r) => { r.vulnerabilities.picomatch.via = ["tinyglobby"]; }],
  ["missing causes", (r) => { r.vulnerabilities.picomatch.via = []; }],
]) {
  test(`does not except ${description}`, () => {
    const { report, lock } = fixture();
    change(report, lock, "node_modules/tinyglobby/node_modules/picomatch");
    assert.equal(assessAudit(report, lock).blocked.length, 5);
  });
}

test("accepts a clean audit after the upstream fix", () => {
  const report = { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } };
  assert.deepEqual(checkResult({ status: 0, stdout: JSON.stringify(report) }, { packages: {} }),
    { allowed: [], blocked: [] });
  assert.throws(() => checkResult({ status: 1, stdout: JSON.stringify(report) }, {}));
});

test("fails closed on audit command, registry, JSON, and schema errors", () => {
  const { report, lock } = fixture();
  for (const result of [
    { error: new Error("spawn failed") },
    { status: null, stderr: "terminated" },
    { status: 2, stdout: JSON.stringify(report), stderr: "registry failure" },
    { status: 1, stdout: "invalid JSON" },
    { status: 1, stdout: JSON.stringify({ error: { code: "ENOAUDIT" } }) },
    { status: 1, stdout: JSON.stringify({ ...report, auditReportVersion: 3 }) },
    { status: 1, stdout: JSON.stringify({ ...report, vulnerabilities: {} }) },
  ]) {
    assert.throws(() => checkResult(result, lock));
  }
});
