const BINARY = "./dist/heimdall";

// --- Signature ---
console.log("=== Signature ===\n");
const verify = Bun.spawnSync(["codesign", "--verify", "--verbose", BINARY]);
const verifyOut = new TextDecoder().decode(verify.stderr); // codesign writes to stderr
console.log(verifyOut || "valid on disk");

// --- Signing details ---
console.log("=== Signing Details ===\n");
const details = Bun.spawnSync(["codesign", "-dv", "--verbose=4", BINARY]);
console.log(new TextDecoder().decode(details.stderr));

// --- Notarization history ---
const APPLE_ID = process.env.APPLE_ID;
const TEAM_ID = process.env.APPLE_TEAM_ID;
const APP_PASSWORD = process.env.APPLE_APP_PASSWORD;

if (!APPLE_ID || !TEAM_ID || !APP_PASSWORD) {
  console.log("=== Notarization ===\n");
  console.log("Skipped. Set APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD to check.\n");
  process.exit(0);
}

console.log("=== Notarization History ===\n");
const history = Bun.spawnSync([
  "xcrun", "notarytool", "history",
  "--apple-id", APPLE_ID,
  "--team-id", TEAM_ID,
  "--password", APP_PASSWORD,
]);
console.log(new TextDecoder().decode(history.stdout));
