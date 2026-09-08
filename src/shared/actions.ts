import type { ActionDefinition } from "./contracts.js";

export const ACTIONS: readonly ActionDefinition[] = [
  ["new", "/new", "New task", "Start a fresh Muse session in this project", "Muse", "New task", "always"],
  ["resume", "/resume", "Resume task", "Open an existing Muse session", "Muse", "Task sidebar", "always"],
  ["resync", "/resync", "Refresh task", "Reload this task's history and live state", "mortiφ", "Task menu", "session"],
  ["fork", "/fork", "Fork task", "Fork this session and preserve its lineage", "Muse", "Task menu", "session"],
  ["rename", "/rename", "Rename task", "Set a local mortiφ label for this task", "mortiφ", "Task menu", "session"],
  ["delete", "/delete", "Remove task", "Remove this task from mortiφ while preserving its Muse session", "mortiφ", "Task menu", "session"],
  ["clear", "/clear", "Fresh task", "Start another session here; keep this task in history", "Muse", "Task menu", "session"],
  ["compact", "/compact", "Compact context", "Ask Muse to compact this session", "Muse", "Task menu", "session"],
  ["model", "/model", "Model", "Open the Muse model catalog and choose a model", "Muse", "Composer model", "session"],
  ["effort", "/effort", "Reasoning effort", "Choose how much reasoning Muse should use", "Muse", "Composer effort", "always"],
  ["permissions", "/permissions", "Permissions", "Select a preconfigured Muse approval mode", "Muse", "Composer permissions", "session"],
  ["stop", "/stop", "Stop and retract", "Interrupt the active turn and restore its prompt after retraction", "Muse", "Stop button", "activeTurn"],
  ["copy", "/copy", "Copy last response", "Copy the most recent agent response", "mortiφ", "Message action", "session"],
  ["help", "/help", "Command help", "Show every action and its GUI equivalent", "mortiφ", "Command palette", "always"],
  ["queue", "/queue", "Queue prompt", "Run this prompt after the active turn", "Muse", "Send menu", "activeTurn"],
  ["steer", "/steer", "Steer active turn", "Add guidance to the active turn", "Muse", "Send menu", "activeTurn"],
  ["replace", "/replace", "Replace active turn", "Stop and replace the active turn after confirmation", "Muse", "Send menu", "activeTurn"],
  ["unqueue", "/unqueue", "Remove queued turn", "Retract a queued prompt", "Muse", "Queued prompt action", "queuedTurn"],
  ["tasks", "/tasks", "Tasks", "Focus the project and task navigator", "mortiφ", "Task sidebar", "always"],
  ["details", "/details", "Overview", "Open session overview", "mortiφ", "Details · Overview", "session"],
  ["changes", "/changes", "Workspace changes", "Inspect all working-tree changes", "mortiφ", "Details · Changes", "session"],
  ["activity", "/activity", "Activity", "Inspect tools, retries, approvals, and questions", "mortiφ", "Details · Activity", "session"],
  ["settings", "/settings", "Settings", "Open appearance and new-task defaults", "mortiφ", "Sidebar footer", "always"],
].map(([id, command, label, description, source, gui, availableWhen]) => ({ id, command, label, description, source, gui, availableWhen })) as ActionDefinition[];

export const ACTION_BY_COMMAND = new Map(ACTIONS.map((action) => [action.command, action]));
