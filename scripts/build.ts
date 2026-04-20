const BINARY = "./dist/heimdall";
const SIGN = process.argv.includes("--sign");

// --- Build ---
const build = Bun.spawnSync([
  "bun", "build", "--compile", "--minify",
  "./src/index.ts", "--outfile", BINARY,
]);

if (build.exitCode !== 0) {
  console.error("Compile failed:", new TextDecoder().decode(build.stderr));
  process.exit(1);
}
console.log(`Built: ${BINARY}`);

if (!SIGN) {
  console.log("Skipping sign/notarize. Use --sign to enable.");
  process.exit(0);
}

// --- Resolve signing identity ---
const identityProc = Bun.spawnSync(["security", "find-identity", "-v", "-p", "codesigning"]);
const identityOutput = new TextDecoder().decode(identityProc.stdout);
const match = identityOutput.match(/"(Developer ID Application: [^"]+)"/);

if (!match) {
  console.error("No 'Developer ID Application' certificate found in keychain.");
  console.error("Run: security find-identity -v -p codesigning");
  process.exit(1);
}

const identity = match[1];
console.log(`Signing with: ${identity}`);

// --- Sign ---
const sign = Bun.spawnSync([
  "codesign", "--sign", identity, "--options", "runtime",
  "--timestamp", "--force", BINARY,
]);

if (sign.exitCode !== 0) {
  console.error("Signing failed:", new TextDecoder().decode(sign.stderr));
  process.exit(1);
}
console.log("Signed.");

// --- Verify signature ---
const verify = Bun.spawnSync(["codesign", "--verify", "--verbose", BINARY]);
if (verify.exitCode !== 0) {
  console.error("Verification failed:", new TextDecoder().decode(verify.stderr));
  process.exit(1);
}
console.log("Signature verified.");

// --- Notarize ---
const APPLE_ID = process.env.APPLE_ID;
const TEAM_ID = process.env.APPLE_TEAM_ID;
const APP_PASSWORD = process.env.APPLE_APP_PASSWORD;

if (!APPLE_ID || !TEAM_ID || !APP_PASSWORD) {
  console.log("\nSkipping notarization. Set these env vars to enable:");
  console.log("  APPLE_ID=your@email.com");
  console.log("  APPLE_TEAM_ID=XXXXXXXXXX");
  console.log("  APPLE_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx");
  process.exit(0);
}

const zipPath = `${BINARY}.zip`;
Bun.spawnSync(["zip", "-j", zipPath, BINARY]);

console.log("Submitting for notarization (this may take a few minutes)...");
const notarize = Bun.spawnSync([
  "xcrun", "notarytool", "submit", zipPath,
  "--apple-id", APPLE_ID,
  "--team-id", TEAM_ID,
  "--password", APP_PASSWORD,
  "--wait",
], { timeout: 600_000 });

const notarizeOutput = new TextDecoder().decode(notarize.stdout);
console.log(notarizeOutput);

if (notarize.exitCode !== 0 || !notarizeOutput.includes("Accepted")) {
  console.error("Notarization failed:", new TextDecoder().decode(notarize.stderr));
  Bun.spawnSync(["rm", zipPath]);
  process.exit(1);
}

// --- Staple ---
const staple = Bun.spawnSync(["xcrun", "stapler", "staple", BINARY]);
if (staple.exitCode !== 0) {
  console.warn("Staple failed (binary still notarized, just not stapled):",
    new TextDecoder().decode(staple.stderr));
}

Bun.spawnSync(["rm", zipPath]);
console.log("Done. Binary is signed and notarized.")
