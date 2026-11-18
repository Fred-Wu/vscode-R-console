const { spawnSync } = require("node:child_process");
const path = require("node:path");

const advisoryUrl = "https://github.com/advisories/GHSA-fc5q-39xc-vjpf";
// Temporary exception: no patched picomatch release exists as of 2026-11-18.
// VSCE uses fixed glob patterns during packaging; these are dev-only packages.
// Keep this tied to the reviewed versions and paths. See CONTRIBUTING.md.
const reviewedPackages = {
  ovsx: ["node_modules/ovsx", "1.4.0"],
  "@vscode/vsce": ["node_modules/@vscode/vsce", "4.1.1"],
  tinyglobby: ["node_modules/tinyglobby", "0.2.17"],
  fdir: ["node_modules/tinyglobby/node_modules/fdir", "6.5.0"],
  picomatch: ["node_modules/tinyglobby/node_modules/picomatch", "4.0.7"],
};

function assessAudit(report, lock) {
  if (report.error || report.auditReportVersion !== 2 ||
      !report.vulnerabilities || typeof report.vulnerabilities !== "object" ||
      Array.isArray(report.vulnerabilities) ||
      report.metadata?.vulnerabilities?.total !== Object.keys(report.vulnerabilities).length) {
    throw new Error("Incomplete or unsupported npm audit report");
  }

  function isExcepted(name, ancestors = new Set()) {
    const finding = report.vulnerabilities[name];
    const reviewed = reviewedPackages[name];
    if (!finding || !reviewed || ancestors.has(name)) return false;
    const [nodePath, version] = reviewed;
    if (finding.name !== name || finding.severity !== "high" ||
        !Array.isArray(finding.nodes) || finding.nodes.length !== 1 || finding.nodes[0] !== nodePath ||
        lock.packages?.[nodePath]?.dev !== true || lock.packages[nodePath].version !== version ||
        !Array.isArray(finding.via) || finding.via.length === 0) return false;

    // Publishing existing VSIX files bypasses ovsx's VSCE packaging path.
    if (name === "ovsx" && (finding.via.length !== 1 || finding.via[0] !== "@vscode/vsce")) return false;
    const visited = new Set([...ancestors, name]);
    return finding.via.every((cause) => typeof cause === "string"
      ? isExcepted(cause, visited)
      : name === "picomatch" && cause?.name === "picomatch" &&
        cause.url === advisoryUrl && cause.severity === "high");
  }

  const allowed = [];
  const blocked = [];
  for (const name of Object.keys(report.vulnerabilities)) {
    (isExcepted(name) ? allowed : blocked).push(name);
  }
  return { allowed, blocked };
}

function checkResult(result, lock) {
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`npm audit failed (exit ${result.status}): ${result.stderr || "no diagnostic"}`);
  }
  const assessment = assessAudit(JSON.parse(result.stdout), lock);
  if (result.status === 1 && assessment.allowed.length + assessment.blocked.length === 0) {
    throw new Error("npm audit failed without reporting vulnerabilities");
  }
  return assessment;
}

function main() {
  const root = path.resolve(__dirname, "..");
  // Running via npm supplies its CLI path and avoids shell quoting on Windows.
  if (!process.env.npm_execpath) throw new Error("Run this check with npm run audit:dependencies");
  const result = spawnSync(process.execPath,
    [process.env.npm_execpath, "audit", "--json", "--audit-level=low"],
    { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  const { allowed, blocked } = checkResult(result, require("../package-lock.json"));
  if (allowed.length) {
    const message = `Temporary dev-only VSCE exception: ${advisoryUrl} (${allowed.join(", ")}). Remove when patched upstream.`;
    console.warn(process.env.GITHUB_ACTIONS === "true" ? `::warning::${message}` : message);
  }
  if (blocked.length) {
    console.error(result.stdout);
    console.error(`Unexcepted vulnerable dependencies: ${blocked.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log(`Dependency audit passed (${allowed.length} temporarily excepted findings).`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { assessAudit, checkResult };
