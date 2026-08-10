import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { secureEnvFileBeforeRead } from "../sessions/storage-security.ts";

export const FEISHU_NOTIFY_TOOL = "notify";
export const DEFAULT_FEISHU_NOTIFY_TIMEOUT_MS = 10_000;
export const MAX_FEISHU_NOTIFY_TIMEOUT_MS = 60_000;
export const FEISHU_NOTIFY_WEBHOOK_ENV = "FEISHU_NOTIFY_WEBHOOK";
export const FEISHU_NOTIFY_TIMEOUT_ENV = "FEISHU_NOTIFY_TIMEOUT_MS";
export const FEISHU_NOTIFY_GUIDANCE =
  "Use notify for substantive work originating from Feishu: send one concise fixed-group update after work starts, at important milestones, immediately when blocked or failed or when user input is required, and once when fully complete. Do not use notify for ordinary conversation, trivial or single-step actions, routine tool calls, unchanged status, or duplicate milestones. notify targets the deployment-configured fixed group; use the normal final reply for the current chat.";

const TITLE_LIMIT = 64;
const MESSAGE_LIMIT = 1_200;
const CARD_HEADER_COLOR = "blue";
const STATE_ENV_FILE = join(getAgentDir(), "state", "pi-feishu-bot", ".env");

export interface FeishuNotifyResult {
  ok: true;
  channel: "feishu";
  title: string;
  message: string;
}

interface NotifyDependencies {
  resolveConfig?: () => { webhook: string; timeoutMs: number };
  fetch?: typeof fetch;
}

function boundedText(value: string, limit: number): string {
  return Array.from(value.trim()).slice(0, limit).join("");
}

function loadStateEnv(file = STATE_ENV_FILE): Record<string, string> {
  const values: Record<string, string> = {};
  if (!existsSync(file)) return values;
  secureEnvFileBeforeRead(file);
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}

function validateTimeout(timeoutMs: number): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_FEISHU_NOTIFY_TIMEOUT_MS) {
    throw new Error(`${FEISHU_NOTIFY_TIMEOUT_ENV} must be an integer from 1 to ${MAX_FEISHU_NOTIFY_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_FEISHU_NOTIFY_TIMEOUT_MS;
  return validateTimeout(Number(value));
}

function resolveNotifyConfig(): { webhook: string; timeoutMs: number } {
  const fileEnv = loadStateEnv();
  const webhook = process.env[FEISHU_NOTIFY_WEBHOOK_ENV] ?? fileEnv[FEISHU_NOTIFY_WEBHOOK_ENV];
  if (!webhook) {
    throw new Error(`notify: ${FEISHU_NOTIFY_WEBHOOK_ENV} is not configured in ${STATE_ENV_FILE}`);
  }
  return {
    webhook,
    timeoutMs: parseTimeout(process.env[FEISHU_NOTIFY_TIMEOUT_ENV] ?? fileEnv[FEISHU_NOTIFY_TIMEOUT_ENV]),
  };
}

function parseFeishuWebhook(value: string): URL {
  let webhook: URL;
  try {
    webhook = new URL(value);
  } catch {
    throw new Error("notify: the configured Feishu webhook is not a valid URL");
  }
  if (
    webhook.protocol !== "https:" ||
    webhook.username !== "" ||
    webhook.password !== "" ||
    webhook.hostname !== "open.feishu.cn" ||
    webhook.search !== "" ||
    webhook.hash !== "" ||
    !/^\/open-apis\/bot\/v2\/hook\/[^/]+\/?$/.test(webhook.pathname)
  ) {
    throw new Error("notify: the configured credential must contain an HTTPS Feishu custom-bot webhook");
  }
  return webhook;
}

export async function sendFeishuNotification(
  rawTitle: string,
  rawMessage: string,
  signal?: AbortSignal,
  dependencies: NotifyDependencies = {},
): Promise<FeishuNotifyResult> {
  const title = boundedText(rawTitle, TITLE_LIMIT);
  const message = boundedText(rawMessage, MESSAGE_LIMIT);
  if (!title) throw new Error("notify title must not be empty");
  if (!message) throw new Error("notify message must not be empty");

  const { webhook: rawWebhook, timeoutMs: rawTimeoutMs } = (dependencies.resolveConfig ?? resolveNotifyConfig)();
  const webhook = parseFeishuWebhook(rawWebhook);
  const timeoutMs = validateTimeout(rawTimeoutMs);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await (dependencies.fetch ?? fetch)(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      msg_type: "interactive",
      card: {
        header: {
          title: { tag: "plain_text", content: title },
          template: CARD_HEADER_COLOR,
        },
        elements: [{ tag: "div", text: { tag: "lark_md", content: message } }],
      },
    }),
    redirect: "error",
    signal: combinedSignal,
  });
  if (!response.ok) throw new Error(`notify: Feishu webhook returned HTTP ${response.status}`);

  let payload: { code?: unknown; msg?: unknown };
  try {
    payload = (await response.json()) as { code?: unknown; msg?: unknown };
  } catch {
    throw new Error("notify: Feishu webhook returned a non-JSON response");
  }
  if (payload.code !== 0) {
    const detail = typeof payload.msg === "string" && payload.msg
      ? `: ${boundedText(payload.msg, MESSAGE_LIMIT)}`
      : "";
    throw new Error(`notify: Feishu webhook rejected the message${detail}`);
  }
  return { ok: true, channel: "feishu", title, message };
}

export function registerFeishuNotifyTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: FEISHU_NOTIFY_TOOL,
    label: "飞书群通知",
    description:
      "Send a concise lifecycle notification to the deployment-configured fixed Feishu group through a custom-bot webhook. Use it for substantive task starts, important milestones, blockers, failures, required user input, and final completion. The recipient cannot be selected by the caller.",
    promptSnippet: "向固定飞书信息同步群发送任务生命周期通知",
    promptGuidelines: [FEISHU_NOTIFY_GUIDANCE],
    parameters: Type.Object({
      title: Type.String({ description: `通知标题；超过 ${TITLE_LIMIT} 个字符会被截断。` }),
      message: Type.String({ description: `通知正文；超过 ${MESSAGE_LIMIT} 个字符会被截断。` }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal) {
      const result = await sendFeishuNotification(params.title, params.message, signal);
      return {
        content: [{ type: "text", text: `已发送固定群飞书通知：${result.title}\n${result.message}` }],
        details: result,
      };
    },
  });
}

export default function notifyExtension(pi: ExtensionAPI): void {
  registerFeishuNotifyTool(pi);
}
