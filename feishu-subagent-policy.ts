import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { registerSubagentCapabilityCeiling } from "pi-subagents/capability-ceiling";
import { feishuCapabilityCeiling } from "./agent-runtime.ts";

// pi-subagents 0.42.1 public tool action schema. Kept explicit because the
// package does not export a stable actions constant from its public API.
export const OFFICIAL_SUBAGENT_ACTIONS = ["list", "get", "models", "create", "update", "delete", "eject", "disable", "enable", "reset", "mission.create", "mission.list", "mission.show", "mission.update", "mission.attach-run", "mission.close", "worktree.discard", "inspector.open", "inspector.status", "inspector.close", "project.open", "project.status", "project.close", "status", "grant-spawn-budget", "interrupt", "resume", "steer", "stop", "append-step", "approve-checkpoint", "reject-checkpoint", "doctor", "watchdog.status", "watchdog.check", "watchdog.configure", "watchdog.recommend-model", "schedule.create", "schedule.list", "schedule.show", "schedule.history", "schedule.pause", "schedule.resume", "schedule.run", "schedule.run-due", "schedule.delete"] as const;

// Deliberately narrow: only read-only inspection and controls whose upstream
// implementation terminates an existing run. Every other current/future action
// is denied, including metadata writes and actions that open long-lived state.
export const SAFE_MANAGEMENT_ACTIONS = new Set<string>([
  "list", "get", "models", "doctor", "status",
  "mission.list", "mission.show",
  "schedule.list", "schedule.show", "schedule.history",
  "inspector.status", "project.status", "watchdog.status",
  "stop", "interrupt",
]);

export function foregroundOnlyViolation(input: Record<string, unknown>): string | undefined {
  const action = typeof input.action === "string" ? input.action : undefined;
  if (action) {
    if (SAFE_MANAGEMENT_ACTIONS.has(action)) return undefined;
    return `Subagent action '${action}' is not in the Feishu read-only/termination management allowlist.`;
  }
  if (input.async !== false) return "Feishu sessions require foreground subagents. Pass async:false; detached/background delegation is disabled.";
  return undefined;
}

export default function feishuSubagentPolicy(pi: ExtensionAPI): void {
  let handle: { dispose(): void } | undefined;
  pi.on("tool_call", (event: ToolCallEvent) => {
    if (event.toolName !== "subagent") return undefined;
    const reason = foregroundOnlyViolation(event.input as Record<string, unknown>);
    return reason ? { block: true, reason } : undefined;
  });
  pi.on("session_start", (_event, ctx) => {
    handle?.dispose();
    const identity = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
    if (!identity) throw new Error("Feishu RPC session identity is unavailable.");
    handle = registerSubagentCapabilityCeiling({ sessionId: identity, source: "feishu-bot-isolated-session", ceiling: feishuCapabilityCeiling() });
  });
  pi.on("session_shutdown", () => { handle?.dispose(); handle = undefined; });
}
