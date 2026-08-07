import { expect, test } from "bun:test";
import { isUnexpectedAutonomousStart, visibleSubagentCustomText } from "./event-routing.ts";

test("unexpected autonomous starts are detected only without an active turn", () => {
  expect(isUnexpectedAutonomousStart({ type: "agent_start" }, false)).toBe(true);
  expect(isUnexpectedAutonomousStart({ type: "agent_start" }, true)).toBe(false);
});

test("custom routing permits only two public displayed result types", () => {
  for (const customType of ["subagent-slash-result", "subagent-slash-text-result"]) {
    expect(visibleSubagentCustomText({ type: "message_end", message: { role: "custom", customType, display: true, content: "Public result" } })).toBe("Public result");
  }
  const rejected = [
    { role: "custom", customType: "subagent-notify", display: true, content: "internal" },
    { role: "custom", customType: "subagent-slash-result", display: false, content: "hidden" },
    { role: "custom", customType: "unknown", display: true, content: "unknown" },
    { role: "user", customType: "subagent-slash-result", display: true, content: "user" },
  ];
  for (const message of rejected) expect(visibleSubagentCustomText({ type: "message_end", message })).toBeUndefined();
});
