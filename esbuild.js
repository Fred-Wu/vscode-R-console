const fs = require("fs");
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  fs.rmSync("dist", { recursive: true, force: true });

  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    outfile: "dist/extension.js",
    external: ["vscode"],
    sourcemap: !production,
    sourcesContent: !production,
    minify: production,
    logLevel: "info",
    tsconfig: "tsconfig.json",
  });

  if (watch) {
    await ctx.watch();
    return;
  }

  try {
    await ctx.rebuild();
  } finally {
    await ctx.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
