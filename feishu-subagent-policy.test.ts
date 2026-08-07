import { expect, test } from "bun:test";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import feishuSubagentPolicy, { foregroundOnlyViolation, OFFICIAL_SUBAGENT_ACTIONS, SAFE_MANAGEMENT_ACTIONS } from "./feishu-subagent-policy.ts";

const expectedSafe = new Set([
  "list", "get", "models", "doctor", "status",
  "mission.list", "mission.show",
  "schedule.list", "schedule.show", "schedule.history",
  "inspector.status", "project.status", "watchdog.status",
  "stop", "interrupt",
]);

test("default-async execution remains blocked", () => {
  expect(foregroundOnlyViolation({ agent: "worker", task: "x", async: true })).toContain("foreground");
  expect(foregroundOnlyViolation({ agent: "worker", task: "x" })).toContain("foreground");
  expect(foregroundOnlyViolation({ workflowScript: "await runs.run()" })).toContain("foreground");
});

test("every official management action matches the explicit safe allowlist", () => {
  expect([...SAFE_MANAGEMENT_ACTIONS].sort()).toEqual([...expectedSafe].sort());
  for (const action of OFFICIAL_SUBAGENT_ACTIONS) {
    const violation = foregroundOnlyViolation({ action });
    if (expectedSafe.has(action)) expect(violation).toBeUndefined();
    else expect(violation).toContain("not in");
  }
  for (const action of ["project.open", "inspector.open", "steer", "resume", "append-step", "approve-checkpoint", "reject-checkpoint", "schedule.create", "schedule.resume", "schedule.run", "schedule.run-due", "create", "update", "delete", "mission.create", "mission.update", "unknown.future"]) {
    expect(foregroundOnlyViolation({ action })).toContain("not in");
  }
});

test("real registered tool_call hook blocks unsafe management and permits safe/foreground calls", async () => {
  let hook: ((event: ToolCallEvent) => unknown) | undefined;
  const fakePi = {
    on(name: string, handler: (event: ToolCallEvent) => unknown) { if (name === "tool_call") hook = handler; },
  } as unknown as ExtensionAPI;
  feishuSubagentPolicy(fakePi);
  expect(hook).toBeDefined();
  const invoke = async (input: Record<string, unknown>) => await hook!({ toolName: "subagent", input } as ToolCallEvent);
  expect(await invoke({ action: "doctor" })).toBeUndefined();
  expect(await invoke({ action: "stop" })).toBeUndefined();
  expect(await invoke({ action: "project.open" })).toMatchObject({ block: true });
  expect(await invoke({ action: "unknown.future" })).toMatchObject({ block: true });
  expect(await invoke({ agent: "worker", task: "x", async: false })).toBeUndefined();
  expect(await invoke({ workflowScript: "x", async: false })).toBeUndefined();
});

test("explicit foreground agent and workflow execution remain allowed", () => {
  expect(foregroundOnlyViolation({ agent: "worker", task: "x", async: false })).toBeUndefined();
  expect(foregroundOnlyViolation({ workflowScript: "x", async: false })).toBeUndefined();
});
