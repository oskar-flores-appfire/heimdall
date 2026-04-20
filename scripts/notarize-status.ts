const BINARY = "./dist/heimdall";
const APPLE_ID = process.env.APPLE_ID;
const TEAM_ID = process.env.APPLE_TEAM_ID;
const APP_PASSWORD = process.env.APPLE_APP_PASSWORD;

if (!APPLE_ID || !TEAM_ID || !APP_PASSWORD) {
  console.error("Missing env vars: APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD");
  process.exit(1);
}

// --- Signature details ---
const details = Bun.spawnSync(["codesign", "-dv", "--verbose=4", BINARY]);
const info = new TextDecoder().decode(details.stderr);

const get = (key: string) => info.match(new RegExp(`${key}=(.+)`))?.[1] ?? "unknown";
const authorities = [...info.matchAll(/Authority=(.+)/g)].map(m => m[1]);

// --- Latest notarization log ---
const history = Bun.spawnSync([
  "xcrun", "notarytool", "history",
  "--apple-id", APPLE_ID, "--team-id", TEAM_ID, "--password", APP_PASSWORD,
  "--output-format", "json",
]);
const submissions = JSON.parse(new TextDecoder().decode(history.stdout));
const latest = submissions.history?.[0];

if (!latest) {
  console.error("No notarization submissions found.");
  process.exit(1);
}

const log = Bun.spawnSync([
  "xcrun", "notarytool", "log", latest.id,
  "--apple-id", APPLE_ID, "--team-id", TEAM_ID, "--password", APP_PASSWORD,
]);
const logData = JSON.parse(new TextDecoder().decode(log.stdout));

// --- Report ---
console.log(`
Heimdall Binary — Signing & Notarization Report
=================================================

Binary:          ${BINARY}
Format:          ${get("Format")}
Identifier:      ${get("Identifier")}
Team ID:         ${get("TeamIdentifier")}
Signed at:       ${get("Timestamp")}
Runtime:         Hardened (${get("Runtime Version")})

Authority Chain:
${authorities.map((a, i) => `  ${i + 1}. ${a}`).join("\n")}

Notarization:
  Status:        ${logData.status} — ${logData.statusSummary}
  Submission ID: ${logData.jobId}
  Uploaded:      ${logData.uploadDate}
  SHA-256:       ${logData.sha256}
  CDHash:        ${logData.ticketContents?.[0]?.cdhash ?? "N/A"}
  Issues:        ${logData.issues ?? "None"}

Verify independently:
  codesign -dv --verbose=4 ${BINARY}
`);
