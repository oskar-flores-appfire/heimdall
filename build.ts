const proc = Bun.spawnSync([
  "bun",
  "build",
  "--compile",
  "--minify",
  "./src/index.ts",
  "--outfile",
  "./dist/heimdall",
]);

if (proc.exitCode === 0) {
  console.log("Built: ./dist/heimdall");
} else {
  console.error("Compile failed:", new TextDecoder().decode(proc.stderr));
  process.exit(1);
}
