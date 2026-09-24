#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".mjs",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".sol",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".txt",
  ".example",
]);
const EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  "artifacts",
  "cache",
  "coverage",
  "out",
  "dist",
  "build",
  "private",
  "secrets",
  "scratch",
]);
const PUBLIC_TREES = [
  "packages/hardhat/contracts",
  "packages/hardhat/scripts",
  "packages/hardhat/test",
  "packages/nextjs/app",
  "packages/nextjs/components",
  "packages/nextjs/hooks",
  "packages/nextjs/lib",
  "packages/nextjs/types",
  "packages/nextjs/test",
  "scripts",
];
const PUBLIC_FILES = [
  "template.json",
  "package.json",
  "README.md",
  "AGENTS.md",
  "LICENSE",
  ".env.example",
  "docs/architecture.md",
  "docs/testnet-evidence.md",
  "packages/hardhat/package.json",
  "packages/hardhat/hardhat.config.cjs",
  "packages/hardhat/.env.example",
  "packages/nextjs/package.json",
  "packages/nextjs/next.config.js",
  "packages/nextjs/next.config.mjs",
  "packages/nextjs/next.config.ts",
  "packages/nextjs/tsconfig.json",
  "packages/nextjs/eslint.config.mjs",
  "packages/nextjs/.env.example",
];
const REQUIRED_FILES = [
  "package.json",
  "README.md",
  "AGENTS.md",
  "LICENSE",
  "docs/architecture.md",
  "packages/hardhat/package.json",
  "packages/hardhat/hardhat.config.cjs",
  "packages/hardhat/contracts/HTSCheckout.sol",
  "packages/nextjs/package.json",
  "packages/nextjs/app/layout.tsx",
  "packages/nextjs/app/page.tsx",
];
const EXPECTED = {
  frontend: "nextjs-app",
  solidityFramework: "hardhat",
  packageManager: "npm",
};
const OPTIONAL_STRINGS = ["description", "version"];
const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value) =>
  typeof value === "string" && value.trim().length > 0;

// Structural checks follow create-scaffold-hbar/src/types.ts, plus this
// template's deliberately narrower package/default contract.
function validateManifest(manifest) {
  const errors = [];
  const need = (condition, message) => {
    if (!condition) errors.push(message);
  };
  need(isObject(manifest), "manifest must be an object");
  if (!isObject(manifest)) return errors;
  need(nonempty(manifest.name), "manifest name must be a nonempty string");
  for (const key of OPTIONAL_STRINGS) {
    if (key in manifest)
      need(typeof manifest[key] === "string", key + " must be a string");
  }
  const config = manifest["create-scaffold-hbar"];
  need(
    isObject(config),
    "create-scaffold-hbar configuration is required for this template",
  );
  if (!isObject(config)) return errors;
  for (const [key, selected] of Object.entries(EXPECTED)) {
    const values = config.capabilities?.[key];
    need(
      Array.isArray(values) && values.length === 1 && values[0] === selected,
      "capabilities." + key + " must contain only " + selected,
    );
    need(
      config.defaults?.[key] === selected,
      "defaults." + key + " must be " + selected,
    );
  }
  if (config.requirements !== undefined) {
    need(
      isObject(config.requirements) &&
        Object.values(config.requirements).every(
          (item) => typeof item === "string",
        ),
      "requirements must map tool names to version strings",
    );
  }
  if (config.instructions !== undefined)
    need(
      Array.isArray(config.instructions) &&
        config.instructions.every((item) => typeof item === "string"),
      "instructions must be strings",
    );
  if (config.envVars !== undefined)
    need(
      Array.isArray(config.envVars) &&
        config.envVars.every(
          (item) =>
            isObject(item) &&
            nonempty(item.key) &&
            typeof item.description === "string",
        ),
      "envVars must have key and description strings",
    );
  if (config.rename !== undefined) {
    need(
      isObject(config.rename) &&
        Object.values(config.rename).every(
          (item) =>
            isObject(item) &&
            nonempty(item.to) &&
            Array.isArray(item.paths) &&
            item.paths.length > 0 &&
            item.paths.every(nonempty),
        ),
      "rename entries need a replacement and nonempty path list",
    );
  }
  if (config.outro !== undefined) {
    const outro = config.outro;
    need(isObject(outro), "outro must be an object");
    if (isObject(outro)) {
      need(
        outro.sections !== undefined ||
          outro.steps !== undefined ||
          outro.installCommand !== undefined,
        "outro needs sections, steps or installCommand",
      );
      if (outro.installCommand !== undefined)
        need(
          nonempty(outro.installCommand),
          "outro.installCommand must be a nonempty string",
        );
      if (outro.steps !== undefined)
        need(
          Array.isArray(outro.steps) &&
            outro.steps.length > 0 &&
            outro.steps.every(nonempty),
          "outro.steps must contain nonempty strings",
        );
      if (outro.sections !== undefined) {
        need(
          Array.isArray(outro.sections) && outro.sections.length > 0,
          "outro.sections must be a nonempty array",
        );
        for (const section of Array.isArray(outro.sections)
          ? outro.sections
          : []) {
          need(isObject(section), "outro section must be an object");
          if (!isObject(section)) continue;
          if (section.title !== undefined)
            need(
              nonempty(section.title),
              "outro section title must be nonempty",
            );
          need(
            Array.isArray(section.steps) && section.steps.length > 0,
            "outro section needs steps",
          );
          for (const step of Array.isArray(section.steps)
            ? section.steps
            : []) {
            need(
              isObject(step) &&
                ["label", "command", "url", "text"].some((key) =>
                  nonempty(step[key]),
                ),
              "outro step needs label, command, url or text",
            );
            if (isObject(step))
              for (const key of ["label", "command", "url", "text"]) {
                if (step[key] !== undefined)
                  need(
                    nonempty(step[key]),
                    "outro step " + key + " must be a nonempty string",
                  );
              }
          }
        }
      }
    }
  }
  return errors;
}

// Public addresses, transaction hashes and regular-expression source are not
// secrets. Hex keys are flagged only when assigned to credential-named fields.
// Never include a matched value in diagnostics.
function credentialFindings(text) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  const tokenShape =
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{40,255}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{20,255}|sk-(?:proj-|live-)?[A-Za-z0-9_-]{32,255})\b/;
  const assignment =
    /["']?([A-Za-z_$][A-Za-z0-9_$]*(?:PRIVATE_KEY|privateKey|private_key|MNEMONIC|mnemonic|SEED_PHRASE|seedPhrase|seed_phrase|PASSWORD|password|API_KEY|apiKey|api_key|CLIENT_SECRET|clientSecret|ACCESS_TOKEN|accessToken)|PRIVATE_KEY|privateKey|private_key|MNEMONIC|mnemonic|SEED_PHRASE|seedPhrase|seed_phrase|PASSWORD|password|API_KEY|apiKey|api_key|CLIENT_SECRET|clientSecret|ACCESS_TOKEN|accessToken)["']?\s*[:=]\s*(?:(["'])([^"'\r\n]+)\2|([^\s#;,]+))/g;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(line))
      findings.push({ line: index + 1, kind: "private-key PEM block" });
    if (tokenShape.test(line))
      findings.push({ line: index + 1, kind: "recognizable credential token" });
    assignment.lastIndex = 0;
    for (const match of line.matchAll(assignment)) {
      const key = match[1];
      const value = match[3] || match[4] || "";
      if (
        /^(?:YOUR_|REPLACE_|EXAMPLE_|<|\$\{|process\.env\b|undefined\b|null\b)/i.test(
          value,
        )
      )
        continue;
      if (/^0x[0-9a-f]{40}$/i.test(value)) continue;
      if (/private.?key/i.test(key) && /^(?:0x)?[0-9a-f]{64,}$/i.test(value))
        findings.push({ line: index + 1, kind: "literal signing key" });
      if (/mnemonic|seed.?phrase/i.test(key)) {
        const words = value.trim().split(/\s+/);
        if (
          [12, 15, 18, 21, 24].includes(words.length) &&
          words.every((word) => /^[a-z]+$/i.test(word))
        )
          findings.push({ line: index + 1, kind: "literal seed phrase" });
      }
      if (
        /password|api.?key|client.?secret|access.?token/i.test(key) &&
        !/private.?key/i.test(key) &&
        match[2] &&
        value.length >= 16 &&
        /^[A-Za-z0-9_./+=-]+$/.test(value) &&
        !/^https?:/i.test(value)
      )
        findings.push({
          line: index + 1,
          kind: "literal credential assignment",
        });
    }
  }
  return findings;
}

function collectPublicSources() {
  const files = new Set();
  const addFile = (relative) => {
    const absolute = path.join(ROOT, relative);
    if (!fs.existsSync(absolute)) return;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink())
      throw new Error("Public source path is a symlink: " + relative);
    if (stat.isFile()) files.add(relative);
  };
  const walk = (relative) => {
    const absolute = path.join(ROOT, relative);
    if (!fs.existsSync(absolute)) return;
    if (fs.lstatSync(absolute).isSymbolicLink())
      throw new Error("Public source tree is a symlink: " + relative);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Public source path is a symlink: " + child);
      if (entry.isDirectory()) {
        if (
          !entry.name.startsWith(".") &&
          !EXCLUDED_DIRECTORIES.has(entry.name)
        )
          walk(child);
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)))
        addFile(child);
    }
  };
  PUBLIC_FILES.forEach(addFile);
  PUBLIC_TREES.forEach(walk);
  return [...files].sort();
}

function unsafeTrackedPath(relative) {
  const basename = path.posix.basename(relative.replaceAll("\\", "/"));
  const environmentFile =
    basename === ".env" ||
    (basename.startsWith(".env.") &&
      ![".env.example", ".env.sample", ".env.template"].includes(basename));
  return environmentFile || /\.(?:pem|key|dpapi)$/i.test(basename);
}

function run() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--scaffolded", "--self-test"].includes(arg)))
    throw new Error(
      "Usage: node scripts/validate-template.cjs [--scaffolded] [--self-test]",
    );
  if (args.includes("--self-test")) {
    selfTest();
    return;
  }
  const scaffolded = args.includes("--scaffolded");
  const failures = [];
  for (const relative of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(ROOT, relative)))
      failures.push("Missing required file: " + relative);
  }
  const readJson = (relative) => {
    try {
      return JSON.parse(
        fs
          .readFileSync(path.join(ROOT, relative), "utf8")
          .replace(/^\uFEFF/, ""),
      );
    } catch {
      failures.push("Cannot read valid JSON: " + relative);
      return null;
    }
  };
  if (!scaffolded || fs.existsSync(path.join(ROOT, "template.json"))) {
    const manifest = readJson("template.json");
    if (manifest)
      failures.push(
        ...validateManifest(manifest).map((message) => "Manifest: " + message),
      );
  }
  const root = readJson("package.json");
  if (root) {
    if (root.license !== "MIT") failures.push("Root license must be MIT");
    if (
      !Array.isArray(root.workspaces) ||
      !["packages/*", "packages/hardhat"].some((item) =>
        root.workspaces.includes(item),
      ) ||
      !["packages/*", "packages/nextjs"].some((item) =>
        root.workspaces.includes(item),
      )
    )
      failures.push("Root workspaces must include contracts and frontend");
    for (const command of [
      "dev",
      "build",
      "lint",
      "test",
      "chain",
      "deploy",
      "testnet:probe",
      "validate:template",
    ]) {
      if (!nonempty(root.scripts?.[command]))
        failures.push("Missing root command: " + command);
    }
  }
  for (const [relative, name] of [
    ["packages/hardhat/package.json", "@hts-checkout/contracts"],
    ["packages/nextjs/package.json", "@hts-checkout/web"],
  ]) {
    const pkg = readJson(relative);
    if (pkg && pkg.name !== name)
      failures.push("Unexpected workspace name in " + relative);
  }
  if (
    fs.existsSync(path.join(ROOT, "LICENSE")) &&
    !fs
      .readFileSync(path.join(ROOT, "LICENSE"), "utf8")
      .includes("Permission is hereby granted, free of charge")
  )
    failures.push("LICENSE does not contain MIT license text");

  const sources = collectPublicSources();
  for (const relative of sources) {
    for (const finding of credentialFindings(
      fs.readFileSync(path.join(ROOT, relative), "utf8"),
    )) {
      failures.push(
        relative.replaceAll("\\", "/") +
          ":" +
          finding.line +
          " " +
          finding.kind +
          " (value withheld)",
      );
    }
  }
  let trackedAudit = "checked";
  try {
    const tracked = execFileSync("git", ["ls-files", "-z"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\0")
      .filter(Boolean);
    for (const relative of tracked)
      if (unsafeTrackedPath(relative))
        failures.push("Environment or credential file is tracked: " + relative);
  } catch {
    trackedAudit = "unavailable; run again in a Git checkout";
  }
  if (failures.length) {
    for (const failure of failures) console.error("FAIL " + failure);
    process.exitCode = 1;
    return;
  }
  console.log(
    "PASS " +
      (scaffolded ? "generated-project" : "source-template") +
      " layout and metadata",
  );
  console.log(
    "PASS public-source credential scan (" +
      sources.length +
      " files; dependency, generated and private trees excluded)",
  );
  console.log("Git tracked-file audit: " + trackedAudit);
  console.log(
    "Run lint, tests and build separately. Local checks do not establish live testnet settlement.",
  );
}

function selfTest() {
  const valid = {
    name: "fixture",
    "create-scaffold-hbar": {
      capabilities: {
        frontend: ["nextjs-app"],
        solidityFramework: ["hardhat"],
        packageManager: ["npm"],
      },
      defaults: { ...EXPECTED },
    },
  };
  assert.deepEqual(validateManifest(valid), []);
  assert.ok(validateManifest({ ...valid, name: "" }).length > 0);
  const unsupported = structuredClone(valid);
  unsupported["create-scaffold-hbar"].capabilities.packageManager = ["pnpm"];
  assert.ok(validateManifest(unsupported).length > 0);
  assert.deepEqual(
    credentialFindings('const router = "0x' + "1".repeat(40) + '";'),
    [],
  );
  assert.deepEqual(
    credentialFindings('const transactionHash = "0x' + "2".repeat(64) + '";'),
    [],
  );
  assert.deepEqual(
    credentialFindings("const privateKey = process.env.HEDERA_PRIVATE_KEY;"),
    [],
  );
  assert.deepEqual(
    credentialFindings("HEDERA_PRIVATE_KEY=YOUR_TESTNET_KEY"),
    [],
  );
  assert.ok(
    credentialFindings('HEDERA_PRIVATE_KEY="0x' + "3".repeat(64) + '"').some(
      (item) => item.kind === "literal signing key",
    ),
  );
  assert.ok(
    credentialFindings("HEDERA_PRIVATE_KEY=" + "4".repeat(64)).length > 0,
  );
  assert.ok(
    credentialFindings(
      'const mnemonic = "' + Array(12).fill("example").join(" ") + '";',
    ).length > 0,
  );
  assert.ok(
    credentialFindings('const token = "ghp_' + "A".repeat(36) + '";').length >
      0,
  );
  assert.deepEqual(
    credentialFindings(
      String.raw`const privateKeyPattern = /^(?:0x)?[0-9a-f]{64}$/i;`,
    ),
    [],
  );
  assert.equal(unsafeTrackedPath("packages/nextjs/.env.local"), true);
  assert.equal(unsafeTrackedPath("packages/nextjs/.env.example"), false);
  assert.equal(unsafeTrackedPath("private/deployer.dpapi"), true);
  console.log(
    "PASS validator self-test: manifest rejection, credential shapes, public identifiers, regex source and tracked-file policy",
  );
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error("FAIL " + error.message);
    process.exitCode = 1;
  }
}
module.exports = { validateManifest, credentialFindings, unsafeTrackedPath };
