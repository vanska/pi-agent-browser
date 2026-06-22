import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  getAgentDir,
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const BROWSER_TOOL_NAME = "browser";

const SETTINGS_PATH = join(getAgentDir(), "settings.json");

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeSettings(updates: Record<string, unknown>): Promise<void> {
  const current = readSettings();
  const next = { ...current, ...updates };
  mkdirSync(getAgentDir(), { recursive: true });
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(next, null, 2)}\n`);
}

function getEnabledSetting(): boolean {
  const settings = readSettings();
  const piAgentBrowser = settings.piAgentBrowser as Record<string, unknown> | undefined;
  return piAgentBrowser?.enabled !== false;
}

async function syncToolAvailability(pi: ExtensionAPI): Promise<void> {
  const enabled = getEnabledSetting();

  const activeTools = pi.getActiveTools();
  if (!enabled && activeTools.includes(BROWSER_TOOL_NAME)) {
    pi.setActiveTools(activeTools.filter((name) => name !== BROWSER_TOOL_NAME));
  } else if (enabled && !activeTools.includes(BROWSER_TOOL_NAME)) {
    const allTools = pi.getAllTools();
    if (allTools.map((t) => t.name).includes(BROWSER_TOOL_NAME)) {
      pi.setActiveTools([...activeTools, BROWSER_TOOL_NAME]);
    }
  }
}

async function updateStatusBar(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const enabled = getEnabledSetting();

  if (!enabled) {
    ctx.ui.setStatus("pi-agent-browser", ctx.ui.theme.fg("warning", "pi-agent-browser: disabled"));
  } else {
    ctx.ui.setStatus("pi-agent-browser", undefined);
  }
}

const TOOL_DESCRIPTION = `Browser automation via agent-browser CLI.
Workflow: open URL → snapshot -i (get @refs like @e1) → interact → re-snapshot after page changes.
Commands:
  open <url> - Navigate to URL
  snapshot -i - Interactive elements with @refs (re-snapshot after navigation)
  click <@ref> - Click element
  fill <@ref> <text> - Clear and type
  type <@ref> <text> - Type without clearing
  select <@ref> <value> - Select dropdown
  press <key> - Press key (Enter, Tab, etc.)
  scroll <dir> [px] - Scroll (up/down/left/right)
  get text|url|title [@ref] - Get information
  wait <@ref|ms> - Wait for element or time
  screenshot [--full] - Take screenshot (image returned inline)
  close - Close browser
Any valid agent-browser command works.`;

function writeTempFile(content: string, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-browser-${prefix}-`));
  const file = join(dir, "output.txt");
  writeFileSync(file, content);
  return file;
}

async function ensureInstalled(pi: ExtensionAPI, ctx: any): Promise<boolean> {
  const check = await pi.exec("which", ["agent-browser"], { timeout: 5000 });
  if (check.code === 0 && check.stdout.trim()) {
    return true;
  }

  // Not found — prompt user
  if (!ctx.hasUI) {
    return false;
  }

  const ok = await ctx.ui.confirm(
    "agent-browser not found",
    "Install agent-browser globally with npm? (npm install -g agent-browser)"
  );
  if (!ok) {
    return false;
  }

  ctx.ui.notify("Installing agent-browser...", "info");
  const install = await pi.exec("npm", ["install", "-g", "agent-browser"], { timeout: 120000 });
  if (install.code !== 0) {
    ctx.ui.notify(`Installation failed: ${install.stderr}`, "error");
    return false;
  }

  // Also run install for Chromium
  ctx.ui.notify("Downloading Chromium...", "info");
  const chromium = await pi.exec("agent-browser", ["install"], { timeout: 120000 });
  if (chromium.code !== 0) {
    ctx.ui.notify(`Chromium install failed: ${chromium.stderr}`, "error");
    return false;
  }

  ctx.ui.notify("agent-browser installed successfully!", "info");
  return true;
}

export default function agentBrowserExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    await syncToolAvailability(pi);
    await updateStatusBar(pi, ctx);
  });

  pi.registerCommand("agent-browser-enable", {
    description: "Enable the agent-browser extension and its browser tool",
    handler: async (_args, ctx) => {
      if (getEnabledSetting()) {
        ctx.ui.notify("agent-browser is already enabled.", "info");
        return;
      }

      await writeSettings({ piAgentBrowser: { enabled: true } });
      await syncToolAvailability(pi);
      await updateStatusBar(pi, ctx);
      ctx.ui.notify("agent-browser enabled. The browser tool will be available on the next turn.", "info");
    },
  });

  pi.registerCommand("agent-browser-disable", {
    description: "Disable the agent-browser extension and hide its browser tool",
    handler: async (_args, ctx) => {
      if (!getEnabledSetting()) {
        ctx.ui.notify("agent-browser is already disabled.", "info");
        return;
      }

      await writeSettings({ piAgentBrowser: { enabled: false } });
      await syncToolAvailability(pi);
      await updateStatusBar(pi, ctx);
      ctx.ui.notify("agent-browser disabled. The browser tool is hidden from the agent.", "info");
    },
  });

  pi.registerCommand("agent-browser-status", {
    description: "Show agent-browser extension status",
    handler: async (_args, ctx) => {
      const enabled = getEnabledSetting();
      const activeTools = pi.getActiveTools();
      const toolActive = activeTools.includes(BROWSER_TOOL_NAME);

      const state = enabled
        ? `agent-browser: enabled, browser tool ${toolActive ? "active" : "hidden"}`
        : `agent-browser: disabled, browser tool hidden`;
      ctx.ui.notify(state, "info");
    },
  });

  pi.registerTool({
    name: BROWSER_TOOL_NAME,
    label: "Browser",
    description: TOOL_DESCRIPTION,
    parameters: Type.Object({
      command: Type.String({ description: "agent-browser command (without 'agent-browser' prefix)" }),
    }),

    renderCall(args: { command: string }, theme: any) {
      const text = theme.fg("toolTitle", theme.bold("browser ")) + theme.fg("accent", args.command);
      return new Text(text, 0, 0);
    },

    renderResult(result: any, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: any) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Running..."), 0, 0);
      }

      const details = result.details || {};

      // Error
      if (result.isError || details.error) {
        const errorText = details.error || result.content?.[0]?.text || "Error";
        return new Text(theme.fg("error", errorText), 0, 0);
      }

      const action = details.action || "";
      const content = result.content?.[0]?.text || "";

      // Screenshot
      if (action === "screenshot") {
        return new Text(theme.fg("success", `Screenshot saved: ${details.screenshotPath || "unknown"}`), 0, 0);
      }

      // Snapshot — show element count
      if (action === "snapshot") {
        const refCount = (content.match(/@e\d+/g) || []).length;
        let text = theme.fg("success", `${refCount} interactive elements`);
        if (details.truncated) {
          text += theme.fg("warning", " (truncated)");
        }
        if (expanded) {
          text += "\n" + theme.fg("dim", content);
        }
        return new Text(text, 0, 0);
      }

      // Default — compact output
      if (expanded) {
        return new Text(theme.fg("dim", content), 0, 0);
      }

      // Compact: first line only
      const firstLine = content.split("\n")[0] || "(no output)";
      const truncated = content.includes("\n") ? "…" : "";
      return new Text(theme.fg("dim", firstLine + truncated), 0, 0);
    },

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const installed = await ensureInstalled(pi, ctx);
      if (!installed) {
        return {
          content: [{ type: "text", text: "agent-browser is not installed. Install manually with: npm install -g agent-browser && agent-browser install" }],
          details: { error: "not-installed" },
          isError: true,
        };
      }

      const commandStr = params.command.trim();
      const parts = commandStr.split(/\s+/);
      const action = parts[0].toLowerCase();

      const result = await pi.exec("agent-browser", parts, {
        signal,
        timeout: 60000,
      });

      if (result.code !== 0) {
        const errorOutput = (result.stderr || result.stdout).trim();
        return {
          content: [{ type: "text", text: errorOutput || `Command failed with exit code ${result.code}` }],
          details: { error: errorOutput, exitCode: result.code, command: commandStr },
          isError: true,
        };
      }

      const output = result.stdout.trim();

      // Screenshot: extract path, read file, return as image
      if (action === "screenshot") {
        const pathMatch = output.match(/saved to (.+)$/i);
        if (pathMatch) {
        const screenshotPath = pathMatch[1].trim();
        try {
          const imageData = readFileSync(screenshotPath);
          const base64 = imageData.toString("base64");
          const ext = extname(screenshotPath).toLowerCase();
          const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
            : ext === ".webp" ? "image/webp"
              : "image/png";
          return {
            content: [
              { type: "text", text: `Screenshot saved: ${screenshotPath}` },
              { type: "image", data: base64, mimeType },
            ],
            details: { command: commandStr, action, screenshotPath },
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Screenshot saved to ${screenshotPath} but could not read file: ${err.message}` }],
            details: { command: commandStr, action, screenshotPath, readError: err.message },
          };
          }
        }
      }

      // Apply truncation to large outputs (especially snapshot)
      const truncation = truncateHead(output, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      let resultText = truncation.content;

      if (truncation.truncated) {
        const tempFile = writeTempFile(output, action);
        resultText += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
        resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
        resultText += ` Full output saved to: ${tempFile}]`;
      }

      return {
        content: [{ type: "text", text: resultText || "(no output)" }],
        details: { command: commandStr, action, truncated: truncation.truncated },
      };
    },
  });

  // Clean up browser on session exit
  pi.on("session_shutdown", async (_event, _ctx) => {
    try {
      await pi.exec("agent-browser", ["close"], { timeout: 5000 });
    } catch {
      // Ignore — browser may already be closed
    }
  });
}
