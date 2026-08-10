export const FEISHU_AGENT_TOOLS = [
  "read", "bash", "edit", "write", "grep", "find", "ls", "notify", "subagent", "subagent_wait",
] as const;

export const FEISHU_DELEGATE_AGENTS = ["worker", "reviewer", "scout", "planner"] as const;
const FEISHU_CHILD_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export function feishuCapabilityCeiling() {
  return {
    allowedTools: [...FEISHU_CHILD_TOOLS],
    allowedAgents: [...FEISHU_DELEGATE_AGENTS],
    denyExtensions: true,
  };
}

export function isSubagentProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_SUBAGENT_CHILD === "1";
}
