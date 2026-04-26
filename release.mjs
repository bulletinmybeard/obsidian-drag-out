/*
 * release.mjs
 *
 * Bumps package.json unless --version is supplied to refresh an existing release.
 *
 * Steps:
 *   1. Resolve the target version (--version, or --bump with patch default)
 *   2. Sync into package.json and manifest.json
 *   3. Add entry to versions.json (mapping version -> manifest.minAppVersion)
 *   4. Run production build
 *   5. Freshly stage release artifacts into dist/<version>/
 *   6. Optionally create/update the GitHub Release assets
 *
 * Usage:  bun run release
 *         bun run release --bump minor
 *         bun run release --dry-run
 *         bun run release:github
 *         bun run release:github --version 0.1.2 --push --move-tag
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
const isDryRun = process.argv.includes("--dry-run");
const shouldPushBranch = process.argv.includes("--push");
const shouldMoveTag = process.argv.includes("--move-tag");

function logDryRun(message) {
    if (isDryRun) {
        console.log(`  [dry-run] ${message}`);
    }
}

function writeJsonFile(file, value) {
    const json = JSON.stringify(value, null, 2) + "\n";
    if (isDryRun) {
        logDryRun(`would write ${file}`);
        return;
    }

    writeFileSync(file, json);
}

function runCommand(command, args, options = {}) {
    if (isDryRun) {
        logDryRun(`would run: ${[command, ...args].join(" ")}`);
        return undefined;
    }

    return execFileSync(command, args, options);
}

function readArgValue(name) {
    const equalsArg = process.argv.find((arg) => arg.startsWith(`${name}=`));
    if (equalsArg) {
        return equalsArg.slice(name.length + 1);
    }

    const argIndex = process.argv.indexOf(name);
    if (argIndex >= 0) {
        return process.argv[argIndex + 1];
    }

    return undefined;
}

function parseStableVersion(version) {
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match) {
        throw new Error(`version ${version} is not a stable semver version`);
    }

    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
    };
}

function bumpVersion(version, bumpType) {
    const parsed = parseStableVersion(version);

    switch (bumpType) {
        case "patch":
            return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
        case "minor":
            return `${parsed.major}.${parsed.minor + 1}.0`;
        case "major":
            return `${parsed.major + 1}.0.0`;
        default:
            throw new Error(
                `unsupported bump type ${bumpType}; use patch, minor, or major`
            );
    }
}

function hasRemoteTag(tagName) {
    try {
        execFileSync(
            "git",
            ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tagName}`],
            { stdio: "ignore" }
        );
        return true;
    } catch {
        return false;
    }
}

function hasLocalTag(tagName) {
    try {
        execFileSync("git", ["rev-parse", "--verify", `refs/tags/${tagName}`], {
            stdio: "ignore",
        });
        return true;
    } catch {
        return false;
    }
}

function isWorkingTreeClean() {
    const status = execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf8",
    });
    return status.trim().length === 0;
}

function ensureRemoteTag(tagName) {
    if (hasRemoteTag(tagName)) {
        return;
    }

    if (!hasLocalTag(tagName)) {
        if (!isWorkingTreeClean()) {
            throw new Error(
                `tag ${tagName} does not exist locally and the working tree is not clean`
            );
        }

        if (hasLocalTag(`v${tagName}`)) {
            console.warn(
                `  found local tag v${tagName}; creating Obsidian-compatible tag ${tagName}`
            );
        } else {
            console.log(`  creating local tag ${tagName}`);
        }
        runCommand("git", ["tag", tagName], { stdio: "inherit" });
    }

    console.log(`  pushing local tag ${tagName} to origin`);
    runCommand("git", ["push", "origin", tagName], { stdio: "inherit" });
}

function getCurrentBranch() {
    const branch = execFileSync("git", ["branch", "--show-current"], {
        encoding: "utf8",
    }).trim();

    if (!branch) {
        throw new Error("not on a branch; cannot push current branch");
    }

    return branch;
}

function pushCurrentBranch() {
    const branch = getCurrentBranch();
    if (!isWorkingTreeClean()) {
        console.warn(
            "  working tree is not clean; git push will only include committed changes"
        );
    }

    console.log(`  pushing branch ${branch}`);
    runCommand("git", ["push", "origin", branch], { stdio: "inherit" });
}

function moveAndPushTag(tagName) {
    if (isDryRun) {
        logDryRun(`would require a clean working tree before moving tag ${tagName}`);
        logDryRun(`would run: git tag -f ${tagName} HEAD`);
        logDryRun(`would run: git push origin ${tagName} --force`);
        return;
    }

    if (!isWorkingTreeClean()) {
        throw new Error(
            `refusing to move tag ${tagName}; commit or discard local changes first`
        );
    }

    if (hasRemoteTag(tagName)) {
        console.warn(
            `  moving existing remote tag ${tagName}; GitHub source archives will point to HEAD`
        );
    } else if (hasLocalTag(`v${tagName}`)) {
        console.warn(
            `  found local tag v${tagName}; creating Obsidian-compatible tag ${tagName}`
        );
    } else {
        console.log(`  creating local tag ${tagName}`);
    }

    runCommand("git", ["tag", "-f", tagName, "HEAD"], { stdio: "inherit" });
    console.log(`  force-pushing tag ${tagName} to origin`);
    runCommand("git", ["push", "origin", tagName, "--force"], {
        stdio: "inherit",
    });
}

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
const explicitVersion = readArgValue("--version");
const bumpType = readArgValue("--bump") ?? "patch";
let targetVersion;
if (explicitVersion) {
    targetVersion = explicitVersion;
} else {
    try {
        targetVersion = bumpVersion(version, bumpType);
    } catch (err) {
        console.error(`\nERROR: ${err.message}`);
        process.exit(1);
    }
}
const tagName = targetVersion;
console.log(`Releasing version ${targetVersion}\n`);
if (isDryRun) {
    console.log("Dry run enabled; no files, tags, releases, or assets will be changed.\n");
}
if (explicitVersion) {
    if (targetVersion !== version) {
        console.log(`  package.json remains at ${version}; staging ${targetVersion}`);
    }
} else {
    const previousPackageVersion = pkg.version;
    pkg.version = targetVersion;
    writeJsonFile("package.json", pkg);
    console.log(`  package.json: ${previousPackageVersion} -> ${targetVersion}`);
}

// --- 2. Sync manifest.json -------------------------------------------------
const previousManifestVersion = manifest.version;
manifest.version = targetVersion;
writeJsonFile("manifest.json", manifest);
console.log(`  manifest.json: ${previousManifestVersion} -> ${targetVersion}`);

// --- 3. Update versions.json -----------------------------------------------
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
if (versions[targetVersion]) {
    console.log(`  versions.json: entry for ${targetVersion} already exists (${versions[targetVersion]})`);
} else {
    versions[targetVersion] = minAppVersion;
    writeJsonFile("versions.json", versions);
    console.log(`  versions.json: added ${targetVersion} -> ${minAppVersion}`);
}

// --- 4. Build production ---------------------------------------------------
console.log("\nBuilding production bundle...");
try {
    if (isDryRun) {
        logDryRun("would run: bun run build");
    } else {
        execSync("bun run build", { stdio: "inherit" });
    }
} catch (err) {
    console.error("\nBuild failed. Aborting release.");
    process.exit(1);
}

// --- 5. Copy artifacts to dist/<version>/ ----------------------------------
const distDir = join("dist", targetVersion);
if (isDryRun) {
    logDryRun(`would remove ${distDir}/`);
    logDryRun(`would create ${distDir}/`);
} else {
    rmSync(distDir, { recursive: true, force: true });
    mkdirSync(distDir, { recursive: true });
}

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
    if (isDryRun) {
        logDryRun(`would copy ${file} -> ${stagedFile}`);
    } else {
        copyFileSync(file, stagedFile);
    }
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

// --- 6. Optionally push branch and move tag ---------------------------------
if (shouldPushBranch || shouldMoveTag) {
    console.log("\nPublishing git refs...");
    try {
        if (shouldPushBranch) {
            pushCurrentBranch();
        } else if (shouldMoveTag) {
            console.warn(
                "  --move-tag was provided without --push; branch changes may remain unpushed"
            );
        }

        if (shouldMoveTag) {
            moveAndPushTag(tagName);
        }
    } catch (err) {
        console.error(`\nERROR: ${err.message}`);
        process.exit(1);
    }
}

// --- 7. Optionally create/update GitHub Release assets ----------------------
if (shouldPublishGithubRelease) {
    console.log(`\nPublishing GitHub Release assets for tag ${tagName}...`);
    if (isDryRun) {
        logDryRun(`would check whether GitHub Release ${tagName} exists`);
        logDryRun(
            `would upload assets with --clobber if it exists: ${stagedReleaseFiles.join(", ")}`
        );
        logDryRun(
            `would ensure tag ${tagName} exists on origin and create the release if it does not exist`
        );
    } else {
        try {
            execFileSync("gh", ["release", "view", tagName], { stdio: "ignore" });
            runCommand(
                "gh",
                ["release", "upload", tagName, ...stagedReleaseFiles, "--clobber"],
                { stdio: "inherit" }
            );
        } catch {
            try {
                ensureRemoteTag(tagName);
                runCommand(
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
}

// --- Done ------------------------------------------------------------------
console.log(`
Release ${targetVersion} prepared.

Typical next steps for a new release:
  git add -A
  git commit -m "Release ${targetVersion}"
  bun run release:github --version ${targetVersion} --push --move-tag

To refresh this existing release after committing code changes:
  bun run release:github --version ${targetVersion} --push --move-tag
`);
