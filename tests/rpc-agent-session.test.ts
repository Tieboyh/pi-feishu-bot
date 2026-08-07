import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSafeRpcEnv, FEISHU_SUBAGENT_SYSTEM_PROMPT, OFFICIAL_PROVIDER_ENV, RpcAgentSession } from "../src/runtime/rpc-agent-session.ts";

const sessions: RpcAgentSession[] = [];
afterEach(async () => { await Promise.allSettled(sessions.splice(0).map((session) => session.dispose())); });

test("Feishu system prompt defaults to direct work and scopes explicit delegation", () => {
  expect(FEISHU_SUBAGENT_SYSTEM_PROMPT).toContain("subagent and subagent_wait tools are available");
  expect(FEISHU_SUBAGENT_SYSTEM_PROMPT).toContain("do not use them by default");
  expect(FEISHU_SUBAGENT_SYSTEM_PROMPT).toContain("latest direct user message explicitly asks");
  expect(FEISHU_SUBAGENT_SYSTEM_PROMPT).toContain("never reuse authorization from earlier messages");
  expect(FEISHU_SUBAGENT_SYSTEM_PROMPT).toContain("agent worker and async:false");
  expect(FEISHU_SUBAGENT_SYSTEM_PROMPT).toContain("detached/background delegation is disabled");
});

test("safe child env removes bot credentials but preserves provider and Pi capability variables", () => {
  const env = buildSafeRpcEnv({
    PATH: "/bin", HOME: "/tmp", FEISHU_APP_SECRET: "sentinel", FEISHU_APP_ID: "sentinel",
    LARK_APP_SECRET: "sentinel", BOT_TOKEN: "sentinel", SLACK_API_KEY: "sentinel", ROBOT_API_KEY: "sentinel",
    MATTERMOST_AUTH_TOKEN: "sentinel", RANDOM_API_KEY: "sentinel", OPENAI_API_KEY: "provider",
    ANTHROPIC_AUTH_TOKEN: "provider", PI_SUBAGENT_CAPABILITY_CEILING_V1: "ceiling", PI_CACHE_RETENTION: "30d",
    PI_OAUTH_CALLBACK_HOST: "drop", KIMI_CODE_OAUTH_HOST: "drop", KIMI_OAUTH_HOST: "drop",
  });
  expect(Boolean(env.FEISHU_APP_SECRET)).toBe(false);
  expect(Boolean(env.FEISHU_APP_ID)).toBe(false);
  expect(Boolean(env.LARK_APP_SECRET)).toBe(false);
  expect(Boolean(env.BOT_TOKEN)).toBe(false);
  expect(Boolean(env.SLACK_API_KEY)).toBe(false);
  expect(Boolean(env.ROBOT_API_KEY)).toBe(false);
  expect(Boolean(env.MATTERMOST_AUTH_TOKEN)).toBe(false);
  expect(Boolean(env.RANDOM_API_KEY)).toBe(false);
  expect(Boolean(env.OPENAI_API_KEY)).toBe(true);
  expect(Boolean(env.ANTHROPIC_AUTH_TOKEN)).toBe(true);
  expect(Boolean(env.PI_SUBAGENT_CAPABILITY_CEILING_V1)).toBe(true);
  expect(env.PI_CACHE_RETENTION).toBe("30d");
  expect(env.PI_OAUTH_CALLBACK_HOST).toBeUndefined();
  expect(env.KIMI_CODE_OAUTH_HOST).toBeUndefined();
  expect(env.KIMI_OAUTH_HOST).toBeUndefined();
  const officialSource = Object.fromEntries([...OFFICIAL_PROVIDER_ENV].map((key) => [key, "official"]));
  const officialResult = buildSafeRpcEnv(officialSource);
  expect([...OFFICIAL_PROVIDER_ENV].every((key) => officialResult[key] === "official")).toBe(true);
});

test("real RPC bash sees only provider/capability sentinels", async () => {
  const previous = { f: process.env.FEISHU_APP_SECRET, l: process.env.LARK_APP_SECRET, o: process.env.OPENAI_API_KEY };
  process.env.FEISHU_APP_SECRET = "sentinel";
  process.env.LARK_APP_SECRET = "sentinel";
  process.env.OPENAI_API_KEY = "provider-sentinel";
  try {
    const session = await RpcAgentSession.create({ cwd: process.cwd(), sessionDir: await mkdtemp(join(tmpdir(), "rpc-env-")) });
    sessions.push(session);
    const result = await session.request("bash", { command: `node -e 'console.log(JSON.stringify({feishu:!!process.env.FEISHU_APP_SECRET,lark:!!process.env.LARK_APP_SECRET,provider:!!process.env.OPENAI_API_KEY,ceiling:!!process.env.PI_SUBAGENT_CAPABILITY_CEILING_V1}))'` });
    const visibility = JSON.parse(result.output);
    expect(visibility).toEqual({ feishu: false, lark: false, provider: true, ceiling: true });
  } finally {
    for (const [key, value] of Object.entries({ FEISHU_APP_SECRET: previous.f, LARK_APP_SECRET: previous.l, OPENAI_API_KEY: previous.o })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("image prompts forward Pi ImageContent through RPC", async () => {
  const script = `const r=require('readline').createInterface({input:process.stdin});r.on('line',l=>{const x=JSON.parse(l);if(x.type==='prompt'){const ok=x.images?.[0]?.type==='image'&&x.images[0].data==='iVBORw=='&&x.images[0].mimeType==='image/png';console.log(JSON.stringify({type:'response',id:x.id,command:'prompt',success:ok,error:ok?undefined:'missing image'}));if(ok){console.log(JSON.stringify({type:'agent_start'}));console.log(JSON.stringify({type:'agent_settled'}))}}else if(x.type==='get_state')console.log(JSON.stringify({type:'response',id:x.id,command:'get_state',success:true,data:{isStreaming:false,pendingMessageCount:0}}))})`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  const session = RpcAgentSession.fromProcessForTest(child, { requestTimeoutMs: 500, promptTimeoutMs: 500, shutdownTimeoutMs: 30 });
  sessions.push(session);
  await session.prompt("inspect", [{ type: "image", data: "iVBORw==", mimeType: "image/png" }]);
  expect(session.pendingRequestCount).toBe(0);
});

test("ordinary prompt waits through agent_end until agent_settled", async () => {
  const script = `const r=require('readline').createInterface({input:process.stdin});r.on('line',l=>{const x=JSON.parse(l);if(x.type==='prompt'){console.log(JSON.stringify({type:'response',id:x.id,command:'prompt',success:true}));console.log(JSON.stringify({type:'agent_start'}));console.log(JSON.stringify({type:'agent_end'}));setTimeout(()=>console.log(JSON.stringify({type:'agent_settled'})),40)}else if(x.type==='get_state')console.log(JSON.stringify({type:'response',id:x.id,command:'get_state',success:true,data:{isStreaming:true,pendingMessageCount:0}}))})`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  const session = RpcAgentSession.fromProcessForTest(child, { requestTimeoutMs: 500, promptTimeoutMs: 500, shutdownTimeoutMs: 30 });
  sessions.push(session);
  let ended = false;
  let resolvedAtEnd = false;
  session.subscribe((event) => { if (event.type === "agent_end") ended = true; });
  const promise = session.prompt("normal").then(() => { resolvedAtEnd = ended; });
  for (let i = 0; i < 30 && !ended; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  expect(ended).toBe(true);
  expect(resolvedAtEnd).toBe(false);
  await promise;
  expect(resolvedAtEnd).toBe(true);
});

test("request timeout clears pending state, marks dead, and notifies owner once", async () => {
  let deaths = 0;
  const child = spawn(process.execPath, ["-e", "process.stdin.resume();setInterval(()=>{},1000)"], { stdio: ["pipe", "pipe", "pipe"] });
  const session = RpcAgentSession.fromProcessForTest(child, { requestTimeoutMs: 30, shutdownTimeoutMs: 30, onDeath: () => deaths++ });
  sessions.push(session);
  await expect(session.request("get_state")).rejects.toThrow("timed out");
  expect(session.pendingRequestCount).toBe(0);
  expect(session.unusable).toBe(true);
  await expect(session.request("get_state")).rejects.toThrow("timed out");
  expect(deaths).toBe(1);
});

test("dispose escalates through SIGTERM to confirmed SIGKILL and is idempotent", async () => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000)"], { stdio: ["pipe", "pipe", "pipe"] });
  const session = RpcAgentSession.fromProcessForTest(child, { shutdownTimeoutMs: 40 });
  const first = session.dispose();
  const second = session.dispose();
  expect(first).toBe(second);
  await first;
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

test("abnormal exit notifies owner, becomes unusable, and persisted session can be recreated", async () => {
  let evicted = false;
  const dir = await mkdtemp(join(tmpdir(), "rpc-crash-"));
  const first = await RpcAgentSession.create({ cwd: process.cwd(), sessionDir: dir, onDeath: () => { evicted = true; } });
  sessions.push(first);
  const file = first.sessionFile;
  first.terminateForTest();
  for (let i = 0; i < 50 && !evicted; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(evicted).toBe(true);
  expect(first.unusable).toBe(true);
  await expect(first.request("get_state")).rejects.toThrow("exited");
  const restored = await RpcAgentSession.create({ cwd: process.cwd(), sessionDir: dir, savedPath: file });
  sessions.push(restored);
  expect(restored.sessionFile).toBe(file);
  expect(restored.pid).not.toBe(first.pid);
});

test("slash command settles and releases the next prompt slot", async () => {
  const session = await RpcAgentSession.create({ cwd: process.cwd(), sessionDir: await mkdtemp(join(tmpdir(), "rpc-slash-")), promptTimeoutMs: 2_000 });
  sessions.push(session);
  await session.prompt("/subagents");
  await session.prompt("/subagents");
  expect(session.pendingRequestCount).toBe(0);
});
