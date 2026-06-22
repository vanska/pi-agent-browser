# Agent Browser Toggle Feature

## Overview

The pi-agent-browser extension currently always registers its `browser` tool with no way to disable it. Users who don't need browser automation have no way to hide the tool from the agent.

## Motivation

Some projects don't need browser automation. Having the tool always available adds noise to the LLM's tool selection and system prompt. Following the precedent set by the pi-exa extension (which has enable/disable/status commands), agent-browser should support the same toggle pattern.

## End Goal

Users can enable, disable, and check the status of the agent-browser extension via slash commands. When disabled, the browser tool is hidden from the agent and the system prompt is rebuilt to exclude it. A status bar indicator shows the disabled state. All settings persist across sessions in `~/.pi/agent/settings.json`.

## Implementation

### Step 1: Settings read/write helpers

- [x] Add `getAgentDir()` import from `@mariozechner/pi-coding-agent`
- [x] Define `SETTINGS_PATH` as `join(getAgentDir(), "settings.json")`
- [x] Add `readSettings()` async helper — reads `SETTINGS_PATH` via `fs/promises readFile`, returns parsed JSON (or `{}` if file missing/unparseable)
- [x] Add `writeSettings(updates)` async helper — reads current settings, merges `updates` into the top-level object, writes back as formatted JSON with trailing newline

Context: The settings key is nested under `piAgentBrowser`: `{ piAgentBrowser: { enabled: boolean } }`. The write helper must preserve all existing settings keys. The `enabled` key defaults to `true` (enabled) if the `piAgentBrowser` block doesn't exist yet.

### Step 2: Tool visibility sync

- [x] Add `BROWSER_TOOL_NAME = "browser"` constant
- [x] Add `syncToolAvailability()` async helper that:
  - Reads the `piAgentBrowser.enabled` setting (defaults to `true`)
  - Calls `pi.getAllTools()` and `pi.getActiveTools()`
  - If `enabled` is `false`: filters out `"browser"` from active tools
  - If `enabled` is `true` (or missing): ensures `"browser"` is in active tools
  - Calls `pi.setActiveTools([...nextActive])`

Context: This follows pi-exa's `syncToolAvailability()` pattern. It uses `setActiveTools()` which rebuilds the system prompt — changes take effect on the next agent turn.

### Step 3: Status bar update

- [x] Add `updateStatusBar(ctx)` async helper that:
  - Reads `piAgentBrowser.enabled` setting
  - If `false`: calls `ctx.ui.setStatus("agent-browser", ctx.ui.theme.fg("warning", "agent-browser: disabled"))`
  - If `true`: calls `ctx.ui.setStatus("agent-browser", undefined)` to hide
- [x] Call `syncToolAvailability()` and `updateStatusBar(ctx)` in the existing `session_start` handler

Context: Matches pi-exa's pattern of showing a warning-colored status message when disabled, hidden when enabled (since enabled is the default state).

### Step 4: Slash commands

- [x] Register `/agent-browser-enable` command:
  - Reads current setting; if already enabled, notify "already enabled" and return
  - Writes `{ piAgentBrowser: { enabled: true } }` via `writeSettings()`
  - Calls `syncToolAvailability()` + `updateStatusBar(ctx)`
  - Notify: "agent-browser enabled. The browser tool will be available on the next turn."
- [x] Register `/agent-browser-disable` command:
  - Reads current setting; if already disabled, notify "already disabled" and return
  - Writes `{ piAgentBrowser: { enabled: false } }` via `writeSettings()`
  - Calls `syncToolAvailability()` + `updateStatusBar(ctx)`
  - Notify: "agent-browser disabled. The browser tool is hidden from the agent."
- [x] Register `/agent-browser-status` command:
  - Reads current setting and checks `pi.getActiveTools()` for `"browser"`
  - Notify with current state, e.g. "agent-browser: enabled, browser tool active" or "agent-browser: disabled, browser tool hidden"

Context: Commands apply immediately via `setActiveTools()` — no `/reload` needed. The system prompt is rebuilt automatically by `setActiveTools()`.

### Step 5: Verify and clean up

- [x] Ensure the existing `browser` tool registration in the factory function is unchanged (it always registers)
- [x] Ensure the existing `session_shutdown` browser close handler is unchanged (always runs)
- [x] Ensure `ensureInstalled()` prompt logic in `execute()` is unchanged
- [x] Run `npm run lint:noexit` to verify code quality
