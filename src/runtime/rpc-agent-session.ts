import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  decodeSubagentCapabilityCeiling,
  encodeSubagentCapabilityCeiling,
  intersectSubagentCapabilityCeilings,
  type ResolvedSubagentCapabilityCeiling,
} from "pi-subagents/capability-ceiling";
import type { RpcImageContent } from "../messaging/image-input.ts";
import { FEISHU_AGENT_TOOLS, feishuCapabilityCeiling } from "./agent-runtime.ts";

const require = createRequire(import.meta.url);
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60_000;
export const FEISHU_SUBAGENT_SYSTEM_PROMPT = "The subagent and subagent_wait tools are available in this isolated session, but do not use them by default. Use subagent only when the latest direct user message explicitly asks you to delegate, use a subagent, or have a named agent role perform work. Complexity, uncertainty, long duration, cross-role work, or a need for review do not imply authorization. Authorization applies only to the current request and requested scope; never reuse authorization from earlier messages. When explicitly authorized, you may delegate only to worker, reviewer, scout, or planner, every execution must pass async:false, detached/background delegation is disabled, and children cannot delegate again. When the user explicitly asks for a capability verification, invoke subagent with agent worker and async:false and report the tool result rather than a self-assessment.";
const FORBIDDEN_ENV = /^(?:FEISHU_|LARK_|SLACK_|DISCORD_|TELEGRAM_|DINGTALK_|WECOM_|WECHAT_|LINE_|TEAMS_|BOT_|CHANNEL_)|(?:COOKIE|WEBHOOK|APP_SECRET|APP_ID|BOT_TOKEN|CHANNEL_TOKEN|SIGNING_SECRET)/i;
const SYSTEM_ENV = /^(?:PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|TERM|COLORTERM|NO_PROXY|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_OPTIONS|NODE_EXTRA_CA_CERTS)$/;
const SYSTEM_PREFIX_ENV = /^(?:LC_|XDG_)/;
const PI_ENV = new Set(["PI_OFFLINE", "PI_PACKAGE_DIR", "PI_TELEMETRY", "PI_CACHE_RETENTION", "PI_SUBAGENT_PI_BINARY", "PI_SUBAGENT_CAPABILITY_CEILING_V1", "PI_SUBAGENT_MAX_DEPTH"]);
export const OFFICIAL_PROVIDER_ENV = new Set([
  // Pi 0.84.0 @earendil-works/pi-ai env-api-keys + CLI help contract.
  "COPILOT_GITHUB_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANT_LING_API_KEY",
  "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_RESOURCE_NAME",
  "AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_DEPLOYMENT_NAME_MAP", "DEEPSEEK_API_KEY", "NVIDIA_API_KEY",
  "GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY", "RADIUS_API_KEY", "FIREWORKS_API_KEY",
  "TOGETHER_API_KEY", "BASETEN_API_KEY", "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY", "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY", "MISTRAL_API_KEY", "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "MOONSHOT_API_KEY", "HF_TOKEN", "OPENCODE_API_KEY",
  "KIMI_API_KEY", "CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID",
  "QWEN_TOKEN_PLAN_API_KEY", "QWEN_TOKEN_PLAN_CN_API_KEY", "XIAOMI_API_KEY", "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY", "XIAOMI_TOKEN_PLAN_SGP_API_KEY", "AWS_PROFILE", "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_REGION", "AWS_DEFAULT_REGION",
  "AWS_BEDROCK_SKIP_AUTH", "AWS_BEDROCK_FORCE_HTTP1", "AWS_BEDROCK_FORCE_CACHE",
]);

export function buildSafeRpcEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || FORBIDDEN_ENV.test(key)) continue;
    if (SYSTEM_ENV.test(key) || SYSTEM_PREFIX_ENV.test(key) || PI_ENV.has(key) || OFFICIAL_PROVIDER_ENV.has(key)) env[key] = value;
  }
  delete env.PI_SUBAGENT_CHILD;
  delete env.PI_SUBAGENT_DEPTH;
  return env;
}

export function resolveSubagentsInstall(): { entry: string; manifest: string } {
  const entry = require.resolve("pi-subagents");
  return { entry, manifest: join(dirname(entry), "package.json") };
}
export function resolvePolicyExtension(): string {
  return fileURLToPath(new URL("./feishu-subagent-policy.ts", import.meta.url));
}
export function resolveNotifyExtension(): string {
  return fileURLToPath(new URL("../tools/notify.ts", import.meta.url));
}
function childCeiling(): ResolvedSubagentCapabilityCeiling {
  return intersectSubagentCapabilityCeilings(
    decodeSubagentCapabilityCeiling(process.env.PI_SUBAGENT_CAPABILITY_CEILING_V1),
    { version: 1, ...feishuCapabilityCeiling(), sources: ["feishu-rpc-process"] },
  )!;
}
type PendingRequest = { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

export class RpcAgentSession {
  readonly runtimeToken = Symbol("feishu-rpc-runtime");
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  private readonly requests = new Map<string, PendingRequest>();
  private promptCompletion: { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | null = null;
  private nextId = 0;
  private disposePromise: Promise<void> | null = null;
  private deadError: Error | null = null;
  private deathNotified = false;
  private promptSawAgentStart = false;
  sessionFile = "";
  sessionId = "";
  isStreaming = false;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    private readonly requestTimeoutMs: number,
    private readonly promptTimeoutMs: number,
    private readonly shutdownTimeoutMs: number,
    private readonly onDeath?: (session: RpcAgentSession, error: Error) => void,
  ) {
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) console.error("[feishu-agent-rpc]", text.replace(/[\r\n]+/g, " "));
    });
    child.once("error", (cause) => this.markDead(new Error(`Unable to start Feishu Agent RPC: ${cause.message}`)));
    child.once("exit", (code, signal) => this.markDead(new Error(`Feishu Agent RPC exited (${code ?? signal ?? "unknown"}).`)));
  }

  static fromProcessForTest(child: ChildProcessWithoutNullStreams, options: {
    requestTimeoutMs?: number; promptTimeoutMs?: number; shutdownTimeoutMs?: number;
    onDeath?: (session: RpcAgentSession, error: Error) => void;
  } = {}): RpcAgentSession {
    return new RpcAgentSession(child, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS, options.shutdownTimeoutMs ?? 5_000, options.onDeath);
  }

  static async create(options: {
    cwd: string; sessionDir: string; savedPath?: string; requestTimeoutMs?: number;
    promptTimeoutMs?: number; shutdownTimeoutMs?: number; onDeath?: (session: RpcAgentSession, error: Error) => void;
  }): Promise<RpcAgentSession> {
    const args = ["--mode", "rpc", "--no-extensions", "--extension", resolveSubagentsInstall().entry,
      "--extension", resolvePolicyExtension(), "--extension", resolveNotifyExtension(),
      "--tools", FEISHU_AGENT_TOOLS.join(","),
      "--session-dir", options.sessionDir,
      "--append-system-prompt", FEISHU_SUBAGENT_SYSTEM_PROMPT,
      "--append-system-prompt", "You are replying through Feishu. Preserve group context but do not expose sender IDs unless explicitly needed."];
    if (options.savedPath) args.push("--session", options.savedPath);
    const env = buildSafeRpcEnv();
    env.PI_SUBAGENT_MAX_DEPTH = "1";
    env.PI_SUBAGENT_CAPABILITY_CEILING_V1 = encodeSubagentCapabilityCeiling(childCeiling());
    const child = spawn(process.env.PI_SUBAGENT_PI_BINARY || "pi", args, { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const session = new RpcAgentSession(child, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS, options.shutdownTimeoutMs ?? 5_000, options.onDeath);
    try {
      const state = await session.request("get_state");
      session.sessionFile = state.sessionFile;
      session.sessionId = state.sessionId;
      if (!session.sessionFile) throw new Error("Feishu Agent RPC did not create a persistent session file.");
      return session;
    } catch (error) { await session.dispose(); throw error; }
  }

  get pid(): number | undefined { return this.child.pid; }
  terminateForTest(signal: NodeJS.Signals = "SIGKILL"): boolean { return this.child.kill(signal); }
  get unusable(): boolean { return this.deadError !== null; }
  get pendingRequestCount(): number { return this.requests.size; }
  isSafeToEvict(): boolean {
    return !this.unusable && !this.isStreaming && this.requests.size === 0 && !this.promptCompletion;
  }

  private markDead(error: Error): void {
    if (this.deadError) return;
    this.deadError = error;
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(error); }
    this.requests.clear();
    if (this.promptCompletion) {
      clearTimeout(this.promptCompletion.timer);
      this.promptCompletion.reject(error);
      this.promptCompletion = null;
    }
    if (!this.deathNotified) { this.deathNotified = true; this.onDeath?.(this, error); }
  }

  private handleLine(line: string): void {
    let value: any;
    try { value = JSON.parse(line); } catch { return; }
    if (value.type === "response" && value.id) {
      const pending = this.requests.get(value.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.requests.delete(value.id);
      value.success ? pending.resolve(value.data) : pending.reject(new Error(value.error || `RPC ${value.command} failed.`));
      return;
    }
    if (value.type === "agent_start") { this.isStreaming = true; this.promptSawAgentStart = true; }
    if (value.type === "agent_settled") {
      this.isStreaming = false;
      if (this.promptCompletion) {
        this.resolvePromptCompletion();
      }
    }
    for (const listener of this.listeners) listener(value as AgentSessionEvent);
  }

  request(type: string, fields: Record<string, unknown> = {}, timeoutMs = this.requestTimeoutMs): Promise<any> {
    if (this.deadError) return Promise.reject(this.deadError);
    if (this.disposePromise) return Promise.reject(new Error("Feishu Agent RPC is disposing."));
    const id = `feishu-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        const error = new Error(`Feishu Agent RPC request '${type}' timed out.`);
        reject(error); this.markDead(error); void this.dispose().catch(() => {});
      }, timeoutMs);
      this.requests.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer); this.requests.delete(id); reject(error); this.markDead(error);
      });
    });
  }

  private resolvePromptCompletion(): void {
    if (!this.promptCompletion) return;
    clearTimeout(this.promptCompletion.timer);
    this.promptCompletion.resolve();
    this.promptCompletion = null;
  }

  async prompt(message: string, images: readonly RpcImageContent[] = []): Promise<void> {
    if (this.promptCompletion) throw new Error("Feishu Agent RPC prompt already active.");
    if (this.deadError) throw this.deadError;
    this.promptSawAgentStart = false;
    let completionTimer!: ReturnType<typeof setTimeout>;
    const completion = new Promise<void>((resolve, reject) => {
      const timer = completionTimer = setTimeout(() => {
        const error = new Error("Feishu Agent RPC prompt did not settle before timeout.");
        this.promptCompletion = null; reject(error); this.markDead(error); void this.dispose().catch(() => {});
      }, this.promptTimeoutMs);
      // Install completion subscription before sending prompt (official promptAndWait ordering).
      this.promptCompletion = { resolve, reject, timer };
    });
    try {
      await this.request("prompt", { message, ...(images.length > 0 ? { images } : {}) });
      // Extension/slash commands do not start an agent turn and therefore do
      // not emit agent_settled. An ordered state read is their terminal boundary.
      const state = await this.request("get_state");
      if (!state.isStreaming && state.pendingMessageCount === 0 && !this.promptSawAgentStart) this.resolvePromptCompletion();
      await completion;
    }
    catch (error) {
      clearTimeout(completionTimer);
      this.promptCompletion = null; throw error;
    }
  }
  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    if (this.deadError) throw this.deadError;
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  async abort(): Promise<void> { await this.request("abort"); }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
      const done = () => { cleanup(); resolve(true); };
      const cleanup = () => { clearTimeout(timer); this.child.off("exit", done); };
      this.child.once("exit", done);
    });
  }
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = (async () => {
      this.listeners.clear();
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.stdin.end();
      if (await this.waitForExit(this.shutdownTimeoutMs)) return;
      this.child.kill("SIGTERM");
      if (await this.waitForExit(this.shutdownTimeoutMs)) return;
      this.child.kill("SIGKILL");
      await this.waitForExit(this.shutdownTimeoutMs);
      if (this.child.exitCode === null && this.child.signalCode === null) throw new Error("Feishu Agent RPC could not be terminated.");
    })();
    return this.disposePromise;
  }
}
