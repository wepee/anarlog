#!/usr/bin/env node
// [fork] Fails when an upstream merge brings back what this fork removed:
// a path listed in branding/removed-paths.txt, or Windows/Linux-only code in
// the app. See FORK.md, section 4 ter.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const removedPrefixes = readFileSync("branding/removed-paths.txt", "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

const violations = [];

for (const file of files) {
  const prefix = removedPrefixes.find((p) => file.startsWith(p));
  if (prefix) {
    violations.push(`${file}: path removed by the fork (${prefix})`);
  }
}

const RUST_PATTERN =
  /target_os\s*=\s*"(windows|linux|android|ios|freebsd)"|\bcfg!?\(\s*(windows|not\(\s*unix\s*\))\s*\)|not\(\s*target_os\s*=\s*"macos"\s*\)|target_env\s*=\s*"(gnu|musl|msvc)"|target_family\s*=\s*"windows"/;
const TS_PATTERN =
  /platform\(\)\s*[!=]==?\s*["'](windows|linux)["']|["'](windows|linux)["']\s*[!=]==?\s*platform\(\)/;

const isRust = (file) =>
  /^(apps|crates|plugins)\//.test(file) &&
  (file.endsWith(".rs") || file.endsWith("Cargo.toml"));
const isFrontend = (file) =>
  /^(apps\/desktop\/src|packages)\//.test(file) &&
  /\.(ts|tsx)$/.test(file) &&
  !file.endsWith(".gen.ts");

for (const file of files) {
  const pattern = isRust(file)
    ? RUST_PATTERN
    : isFrontend(file)
      ? TS_PATTERN
      : null;
  if (!pattern) continue;

  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (!pattern.test(line)) return;
    // The one intended non-mac cfg: the guard that refuses to build elsewhere.
    if (
      /not\(target_os = "macos"\)/.test(line) &&
      /compile_error!/.test(lines[index + 1] ?? "")
    ) {
      return;
    }
    violations.push(`${file}:${index + 1}: Windows/Linux code: ${line.trim()}`);
  });
}

if (violations.length > 0) {
  console.error("This fork is macOS-only; the following came back:\n");
  for (const violation of violations) console.error(`  ${violation}`);
  console.error(
    "\nDelete removed paths again, and resolve platform branches by keeping only the macOS one (FORK.md, section 4 ter).",
  );
  process.exit(1);
}

console.log("macOS-only invariants hold");
