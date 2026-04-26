/*
 * release.mjs
 *
 * Run after bumping the version in package.json (e.g. via `bun pm version patch`).
 *
 * Steps:
 *   1. Read version from package.json
 *   2. Sync into manifest.json
 *   3. Add entry to versions.json (mapping version -> manifest.minAppVersion)
 *   4. Run production build
 *   5. Freshly stage release artifacts into dist/<version>/
 *   6. Optionally create/update the GitHub Release assets
 *
 * Usage:  bun run release
 *         bun run release:github
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, execSync } from "node:child_process";

const RELEASE_FILES = [
    { path: "main.js", required: true },
    { path: "manifest.json", required: true },
    { path: "icon.png", required: false },
];
const shouldPublishGithubRelease = process.argv.includes("--github");

// --- 1. Read target version from package.json ------------------------------
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const minAppVersion = manifest.minAppVersion;
if (!minAppVersion || typeof minAppVersion !== "string") {
    console.error("manifest.json has no valid 'minAppVersion'. Aborting.");
    process.exit(1);
}
const version = pkg.version;
if (!version) {
    console.error("package.json has no 'version' field. Aborting.");
    process.exit(1);
}
const tagName = version;
console.log(`Releasing version ${version}\n`);

// --- 2. Sync manifest.json -------------------------------------------------
const previousManifestVersion = manifest.version;
manifest.version = version;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
console.log(`  manifest.json: ${previousManifestVersion} -> ${version}`);

// --- 3. Update versions.json -----------------------------------------------
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
if (versions[version]) {
    console.log(`  versions.json: entry for ${version} already exists (${versions[version]})`);
} else {
    versions[version] = minAppVersion;
    writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");
    console.log(`  versions.json: added ${version} -> ${minAppVersion}`);
}

// --- 4. Build production ---------------------------------------------------
console.log("\nBuilding production bundle...");
try {
    execSync("bun run build", { stdio: "inherit" });
} catch (err) {
    console.error("\nBuild failed. Aborting release.");
    process.exit(1);
}

// --- 5. Copy artifacts to dist/<version>/ ----------------------------------
const distDir = join("dist", version);
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

console.log(`\nStaging release files in ${distDir}/`);
const missingRequired = [];
const missingOptional = [];
const stagedReleaseFiles = [];
for (const { path: file, required } of RELEASE_FILES) {
    if (!existsSync(file)) {
        if (required) {
            missingRequired.push(file);
        } else {
            missingOptional.push(file);
        }
        continue;
    }
    const stagedFile = join(distDir, file);
    copyFileSync(file, stagedFile);
    stagedReleaseFiles.push(stagedFile);
    console.log(`  ${file}`);
}

if (missingOptional.length > 0) {
    console.warn(`\nWARNING: missing optional files (skipped): ${missingOptional.join(", ")}`);
}
if (missingRequired.length > 0) {
    console.error(`\nERROR: missing required release files (aborting): ${missingRequired.join(", ")}`);
    process.exit(1);
}

// --- 6. Optionally create/update GitHub Release assets ----------------------
if (shouldPublishGithubRelease) {
    console.log(`\nPublishing GitHub Release assets for tag ${tagName}...`);
    try {
        execFileSync("gh", ["release", "view", tagName], { stdio: "ignore" });
        execFileSync(
            "gh",
            ["release", "upload", tagName, ...stagedReleaseFiles, "--clobber"],
            { stdio: "inherit" }
        );
    } catch {
        try {
            execFileSync(
                "gh",
                [
                    "release",
                    "create",
                    tagName,
                    ...stagedReleaseFiles,
                    "--title",
                    tagName,
                    "--generate-notes",
                    "--verify-tag",
                ],
                { stdio: "inherit" }
            );
        } catch {
            console.error(`
ERROR: could not create or update the GitHub Release.

Make sure:
  - GitHub CLI is installed and authenticated (gh auth status)
  - the tag ${tagName} exists on GitHub (git push origin ${tagName})
  - you have release permissions for this repo
`);
            process.exit(1);
        }
    }
}

// --- Done ------------------------------------------------------------------
console.log(`
Release ${version} prepared.

Next steps:
  git add -A
  git commit -m "Release ${version}"
  git tag ${tagName}        # if this tag does not already exist
  git push && git push origin ${tagName}

Then create/update the GitHub Release assets:
  bun run release:github

Or manually on GitHub:
  - Draft a new release at tag ${tagName}
  - Attach release files from ${distDir}/ as LOOSE assets (main.js, manifest.json, and icon.png if present; do not zip)
  - Publish
`);
