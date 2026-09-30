// Run in a fresh Bun process: module mocks must not affect real-RPC tests.
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "feishu-model-routing-"));
process.env.PI_CODING_AGENT_DIR = root;
process.env.FEISHU_APP_ID = "cli_fake_routing_test";
process.env.FEISHU_APP_SECRET = "fake-routing-test-not-a-secret";
delete process.env.PI_SUBAGENT_CHILD;
process.env.FEISHU_GROUP_CONTEXT_MESSAGES = "1";
process.env.FEISHU_GROUP_CONTEXT_SOURCE = "bot";
const replies = new Map<string, string>();
let handlers: any;
let releaseContext: (() => void) | undefined;
const channel = {
  on(value: any) { handlers = value; },
  async send(_chat: string, input: any, options: any) {
    if (input.text) replies.set(options.replyTo, input.text);
    return { messageId: `reply-${options.replyTo}` };
  },
  async updateCard() {},
  async connect() {},
  async disconnect() {},
  getConnectionStatus: () => ({ state: "connected" }),
};
mock.module("@larksuiteoapi/node-sdk", () => ({ createLarkChannel: () => channel, LoggerLevel: { warn: "warn" } }));
mock.module("../../src/messaging/group-context.ts", () => ({
  fetchRecentGroupContext: () => new Promise<string>((resolve) => { releaseContext = () => resolve(""); }),
  fetchRecentGroupContextViaLarkCli: async () => "",
  runLarkCliRead: async () => ({}),
}));
const models = [{ provider: "test", id: "a", name: "A" }, { provider: "test", id: "b", name: "B" }];
const runtimes: any[] = [];
mock.module("../../src/runtime/rpc-agent-session.ts", () => ({
  resolveSubagentsInstall: () => ({ entry: "fake", manifest: "fake" }),
  RpcAgentSession: {
    async create(options: any) {
      const session: any = {
        model: models.find((model) => model.id === options.selectedModel?.modelId) ?? models[0],
        modelSettingsIsolated: true,
        sessionId: `runtime-${runtimes.length}`,
        sessionFile: join(options.sessionDir, `runtime-${runtimes.length}.jsonl`),
        unusable: false,
        prompts: 0,
        subscribe: () => () => {},
        isSafeToEvict: () => true,
        async dispose() {},
        async abort() {},
        async prompt() {
          session.prompts++;
          await new Promise<void>((resolve) => { session.releasePrompt = resolve; });
        },
        async request(type: string, fields: any) {
          if (type === "get_state") return { model: session.model, isStreaming: false, pendingMessageCount: 0 };
          if (type === "get_available_models") return { models };
          if (type === "set_model") { session.model = models.find((model) => model.id === fields.modelId); return session.model; }
          throw new Error(`Unexpected request: ${type}`);
        },
      };
      runtimes.push(session);
      return session;
    },
  },
}));
const commands = new Map<string, any>();
const events = new Map<string, any>();
const pi: any = {
  registerTool() {},
  registerCommand(name: string, command: any) { commands.set(name, command); },
  on(name: string, handler: any) { events.set(name, handler); },
};
const context = {
  cwd: root,
  sessionManager: { getSessionId: () => "routing-test", getSessionFile: () => undefined },
  ui: { notify() {} },
};
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 300 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate(), "timed out waiting for routing");
}
let id = 0;
async function message(content: string, senderId = "u1", chatType = "p2p", chatId = "chat") {
  const messageId = `message-${++id}`;
  await handlers.message({ content, senderId, chatType, chatId, messageId, createTime: Date.now(), resources: [] });
  return messageId;
}
async function command(text: string, sender = "u1", type = "p2p", chat = "chat") {
  const messageId = await message(text, sender, type, chat);
  await waitFor(() => replies.has(messageId));
  return replies.get(messageId)!;
}
try {
  const { default: extension } = await import("../../src/index.ts");
  extension(pi);
  await events.get("session_start")(context);
  await commands.get("connect-feishu").handler("", context);
  assert.match(await command("/help"), /\/models/);
  assert.equal(runtimes.length, 0);
  assert.match(await command("/models"), /test\/a/);
  assert.match(await command("/model test/b"), /已切换/);
  assert.match(await command("/model"), /test\/b/);
  assert.match(await command("/model", "u2"), /test\/a/);
  assert.match(await command("/model test/b", "u1", "group", "group1"), /已切换/);
  assert.match(await command("/model", "u2", "group", "group1"), /test\/b/);
  assert.match(await command("/model", "u2", "group", "group2"), /test\/a/);
  assert.equal(runtimes.reduce((count, runtime) => count + runtime.prompts, 0), 0);
  const index = JSON.parse(await readFile(join(root, "state/pi-feishu-bot/sessions/index.json"), "utf8"));
  assert.deepEqual(index.chats["user:u1"].sessions[0].model, { provider: "test", modelId: "b" });
  assert.match(await command("/new fresh"), /已创建/);
  assert.match(await command("/model"), /test\/a/);
  assert.match(await command("/restore"), /已切换/);
  assert.match(await command("/model"), /test\/b/);

  await message("ordinary task");
  await waitFor(() => runtimes.some((runtime) => runtime.releasePrompt));
  await message("queued ordinary task");
  assert.match(await command("/model test/a"), /仍有任务/);
  const active = runtimes.find((runtime) => runtime.releasePrompt);
  active.releasePrompt();
  await waitFor(() => active.prompts === 2);
  assert.match(await command("/model test/a"), /仍有任务/);
  active.releasePrompt();
  await waitFor(() => active.prompts === 2);
  // A group message still fetching context must not be overtaken by a model command.
  await message("group task", "u1", "group", "group2");
  await waitFor(() => Boolean(releaseContext));
  assert.match(await command("/model test/b", "u2", "group", "group2"), /仍有任务/);
  releaseContext!();
  await waitFor(() => runtimes.filter((runtime) => runtime.releasePrompt).length === 2);
  const group = runtimes.find((runtime) => runtime !== active && runtime.releasePrompt);
  group.releasePrompt();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await commands.get("disconnect-feishu").handler("", context);
  await commands.get("connect-feishu").handler("", context);
  assert.match(await command("/model"), /test\/b/);
  console.log("Model command routing, busy guards, chat isolation and restart restoration verified.");
} finally {
  for (const runtime of runtimes) runtime.releasePrompt?.();
  await events.get("session_shutdown")?.(context);
  await rm(root, { recursive: true, force: true });
}
