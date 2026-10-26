#!/usr/bin/env node
/**
 * Cross-platform installer & multi-agent bridge for Claude Code, Codex CLI, and Antigravity.
 * Works on Windows (using junctions, no Admin needed), macOS, and Linux.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rustReadiness } from "./rust.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
  <rect x="14" y="14" width="100" height="100" rx="22" fill="#18181B" stroke="#F97316" stroke-width="6"/>
  <path d="M40 48L58 64L40 80" stroke="#F97316" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M64 80H88" stroke="#FAFAFA" stroke-width="8" stroke-linecap="round"/>
  <circle cx="88" cy="48" r="7" fill="#22C55E"/>
</svg>
`;

/** Safely link `sourceDir` at `targetPath` using a junction on Windows or dir symlink on Unix. */
export function linkDirectory(sourceDir, targetPath, { platform = process.platform, dryRun = false } = {}) {
  const resolvedSource = fs.realpathSync(sourceDir);
  if (dryRun) return { status: "dry-run", source: resolvedSource, target: targetPath };

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  let stat = null;
  try { stat = fs.lstatSync(targetPath); } catch {}

  if (stat) {
    if (stat.isSymbolicLink()) {
      try {
        if (fs.realpathSync(targetPath) === resolvedSource) {
          return { status: "unchanged", source: resolvedSource, target: targetPath };
        }
      } catch {}
      fs.unlinkSync(targetPath);
    } else if (stat.isDirectory()) {
      // If target is already the exact same directory via parent symlink or similar, leave it;
      // otherwise replace the standalone copy with a live link to the repo source of truth.
      fs.rmSync(targetPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(targetPath);
    }
  }

  const linkType = platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(resolvedSource, targetPath, linkType);
  return { status: "linked", source: resolvedSource, target: targetPath, type: linkType };
}

/** Configure Claude Code, Codex CLI, and Antigravity under `homeDir`. */
export function setupAllAgents({
  homeDir = os.homedir(),
  pluginRoot = PLUGIN_ROOT,
  nodePath = process.execPath,
  platform = process.platform,
  dryRun = false,
} = {}) {
  const rustSkillSource = path.join(pluginRoot, "skills", "weedo-rust-dev-skill");
  const leadSkillSource = path.join(pluginRoot, "skills", "lead");
  if (!fs.existsSync(rustSkillSource)) {
    throw Error(`Missing bundled skill directory: ${rustSkillSource}`);
  }

  const links = [
    {
      agent: "claude-code",
      name: "weedo-rust-dev-skill",
      target: path.join(homeDir, ".claude", "skills", "weedo-rust-dev-skill"),
      source: rustSkillSource,
    },
    {
      agent: "codex-cli",
      name: "weedo-rust-dev-skill",
      target: path.join(homeDir, ".codex", "skills", "weedo-rust-dev-skill"),
      source: rustSkillSource,
    },
    {
      agent: "antigravity",
      name: "weedo-rust-dev-skill",
      target: path.join(homeDir, ".gemini", "config", "skills", "weedo-rust-dev-skill"),
      source: rustSkillSource,
    },
  ];

  const results = links.map(entry => ({
    agent: entry.agent,
    name: entry.name,
    ...linkDirectory(entry.source, entry.target, { platform, dryRun }),
  }));

  // Build the Antigravity toggleable plugin bundle: ~/.gemini/config/plugins/codex-rust-suite/
  const agyPluginDir = path.join(homeDir, ".gemini", "config", "plugins", "codex-rust-suite");
  const mcpServerScript = path.join(pluginRoot, "scripts", "mcp-server.mjs");
  const pluginManifest = {
    name: "codex-rust-suite",
    displayName: "Codex Team + Rust Suite",
    version: "1.2.2",
    description: "First-class Rust workspace architecture, fast TDD, Sentry triage, and multi-agent Codex worktree orchestration.",
    logo: "assets/logo.svg",
    suggestedPrompts: [
      "Scaffold or audit a multi-crate Rust workspace with PLATFORMS.md and fast TDD defaults",
      "Run codex_doctor to check Codex sandbox and offline Cargo readiness",
      "Triage a Sentry Rust crash report into an isolated worktree regression test and fix",
    ],
  };
  const mcpConfig = {
    mcpServers: {
      "codex-rust-suite-codex-team": {
        command: nodePath,
        args: [mcpServerScript],
      },
    },
  };

  if (!dryRun) {
    fs.mkdirSync(path.join(agyPluginDir, "assets"), { recursive: true });
    fs.mkdirSync(path.join(agyPluginDir, "skills"), { recursive: true });
    fs.writeFileSync(path.join(agyPluginDir, "plugin.json"), JSON.stringify(pluginManifest, null, 2) + "\n");
    fs.writeFileSync(path.join(agyPluginDir, "assets", "logo.svg"), LOGO_SVG);
    fs.writeFileSync(path.join(agyPluginDir, "mcp_config.json"), JSON.stringify(mcpConfig, null, 2) + "\n");
    linkDirectory(leadSkillSource, path.join(agyPluginDir, "skills", "lead"), { platform, dryRun });
    linkDirectory(rustSkillSource, path.join(agyPluginDir, "skills", "weedo-rust-dev-skill"), { platform, dryRun });
  }

  return {
    platform,
    homeDir,
    pluginRoot,
    skills: results,
    antigravityPlugin: {
      dir: "codex-rust-suite",
      path: agyPluginDir,
      mcpServer: mcpServerScript,
      status: dryRun ? "dry-run" : "installed",
    },
    rust: rustReadiness(pluginRoot, spawnSync),
  };
}

function main(argv = process.argv.slice(2)) {
  let homeDir = os.homedir();
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--home" && argv[i + 1]) homeDir = path.resolve(argv[++i]);
    else if (argv[i] === "--dry-run") dryRun = true;
  }
  const summary = setupAllAgents({ homeDir, dryRun });
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    process.stderr.write(`setup-all: ${error.message || error}\n`);
    process.exit(2);
  }
}
