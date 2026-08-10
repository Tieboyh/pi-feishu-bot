import { execFile } from "node:child_process";

export interface GroupHistoryItem {
  message_id?: string;
  msg_type?: string;
  create_time?: string;
  deleted?: boolean;
  sender?: {
    sender_type?: string;
    sender_name?: string;
  };
  body?: { content: string };
  mentions?: Array<{ id: string }>;
}

export interface GroupHistoryClient {
  im: {
    v1: {
      message: {
        list(payload: {
          params: {
            container_id_type: string;
            container_id: string;
            start_time: string;
            end_time: string;
            sort_type: "ByCreateTimeDesc";
            page_size: number;
            with_sender_name: boolean;
          };
        }): Promise<{
          code?: number;
          msg?: string;
          data?: { items?: GroupHistoryItem[] };
        }>;
      };
    };
  };
}

export interface RecentGroupContextOptions {
  chatId: string;
  triggerMessageId: string;
  messageLimit: number;
  lookbackMs: number;
  botOpenId?: string;
  nowMs?: number;
  timeoutMs?: number;
}

export type LarkCliRunner = (args: string[], timeoutMs: number) => Promise<string>;

const MESSAGE_TEXT_LIMIT = 500;
const CLI_ENV_KEYS = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR",
]);

export function buildSafeLarkCliEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
  };
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (CLI_ENV_KEYS.has(key) || key.startsWith("LC_") || key.startsWith("XDG_"))) env[key] = value;
  }
  return env;
}

export const runLarkCliRead: LarkCliRunner = (args, timeoutMs) => new Promise((resolve, reject) => {
  execFile("lark-cli", args, {
    env: buildSafeLarkCliEnv(),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  }, (error, stdout) => {
    if (error) {
      const code = typeof error.code === "number" ? `（退出码 ${error.code}）` : "";
      reject(new Error(`lark-cli 获取群聊上下文失败${code}`));
      return;
    }
    resolve(stdout);
  });
});

function truncate(value: string, max = MESSAGE_TEXT_LIMIT): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function collectPostText(value: unknown, out: string[], depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectPostText(item, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  if (typeof object.title === "string") out.push(object.title);
  if (typeof object.text === "string") out.push(object.text);
  for (const [key, child] of Object.entries(object)) {
    if (key === "title" || key === "text" || key === "href") continue;
    collectPostText(child, out, depth + 1);
  }
}

export function readableMessageContent(item: GroupHistoryItem): string | undefined {
  const placeholders: Record<string, string> = {
    image: "[图片]",
    file: "[文件]",
    audio: "[语音]",
    media: "[视频]",
    sticker: "[贴纸]",
    interactive: "[卡片消息]",
    share_chat: "[群名片]",
    share_user: "[个人名片]",
    merge_forward: "[合并转发消息]",
  };
  if (item.msg_type && placeholders[item.msg_type]) return placeholders[item.msg_type];
  const raw = item.body?.content;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (item.msg_type === "text" && typeof parsed === "object" && parsed !== null) {
      const text = (parsed as { text?: unknown }).text;
      return typeof text === "string" && truncate(text) ? truncate(text) : undefined;
    }
    if (item.msg_type === "post") {
      const parts: string[] = [];
      collectPostText(parsed, parts);
      const text = truncate(parts.join(" "));
      return text || undefined;
    }
  } catch {
    const text = truncate(raw);
    return text || undefined;
  }
  return undefined;
}

function isHumanSender(senderType: string | undefined): boolean {
  return senderType === "user";
}

function formatGroupHistoryItems(
  items: GroupHistoryItem[],
  options: RecentGroupContextOptions,
): string | undefined {
  const lines = items
    .filter((item) => !item.deleted)
    .filter((item) => item.message_id !== options.triggerMessageId)
    .filter((item) => !options.botOpenId || !item.mentions?.some((mention) => mention.id === options.botOpenId))
    .filter((item) => isHumanSender(item.sender?.sender_type))
    .map((item) => {
      const content = readableMessageContent(item);
      if (!content) return undefined;
      const sender = truncate(item.sender?.sender_name ?? "未知成员", 80);
      return `- ${sender}：${content}`;
    })
    .filter((line): line is string => Boolean(line))
    .slice(0, Math.max(0, Math.min(50, Math.floor(options.messageLimit))))
    .reverse();
  return lines.length > 0 ? lines.join("\n") : undefined;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`获取群聊上下文超时（${timeoutMs}ms）`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function fetchRecentGroupContext(
  client: GroupHistoryClient,
  options: RecentGroupContextOptions,
): Promise<string | undefined> {
  const messageLimit = Math.max(0, Math.min(50, Math.floor(options.messageLimit)));
  if (messageLimit === 0 || !options.chatId.trim()) return undefined;
  const nowMs = options.nowMs ?? Date.now();
  const lookbackMs = Math.max(60_000, options.lookbackMs);
  const response = await withTimeout(client.im.v1.message.list({
    params: {
      container_id_type: "chat",
      container_id: options.chatId,
      start_time: String(Math.floor((nowMs - lookbackMs) / 1000)),
      end_time: String(Math.floor(nowMs / 1000)),
      sort_type: "ByCreateTimeDesc",
      page_size: Math.min(50, Math.max(messageLimit, messageLimit * 2)),
      with_sender_name: true,
    },
  }), options.timeoutMs ?? 5_000);
  if (response.code !== undefined && response.code !== 0) {
    throw new Error(`获取群聊上下文失败：${response.msg ?? `code ${response.code}`}`);
  }

  return formatGroupHistoryItems(response.data?.items ?? [], options);
}

function isoTime(valueMs: number): string {
  return new Date(valueMs).toISOString();
}

export async function fetchRecentGroupContextViaLarkCli(
  options: RecentGroupContextOptions,
  runCli: LarkCliRunner,
): Promise<string | undefined> {
  const messageLimit = Math.max(0, Math.min(50, Math.floor(options.messageLimit)));
  if (messageLimit === 0 || !options.chatId.trim()) return undefined;
  const nowMs = options.nowMs ?? Date.now();
  const lookbackMs = Math.max(60_000, options.lookbackMs);
  const output = await runCli([
    "im", "+chat-messages-list",
    "--as", "user",
    "--chat-id", options.chatId,
    "--start", isoTime(nowMs - lookbackMs),
    "--end", isoTime(nowMs),
    "--order", "desc",
    "--page-size", String(Math.min(50, Math.max(messageLimit, messageLimit * 2))),
    "--no-reactions",
    "--jq", ".data.messages | map({message_id,msg_type,create_time,deleted,sender,content,mentions})",
  ], options.timeoutMs ?? 5_000);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("lark-cli 返回了无法解析的群聊历史数据");
  }
  if (!Array.isArray(parsed)) throw new Error("lark-cli 返回的群聊历史格式不正确");
  const items = parsed.map((value): GroupHistoryItem => {
    const item = value as {
      message_id?: string;
      msg_type?: string;
      deleted?: boolean;
      sender?: { sender_type?: string; name?: string };
      content?: string;
      mentions?: Array<{ id?: string }> | null;
    };
    return {
      message_id: item.message_id,
      msg_type: item.msg_type,
      deleted: item.deleted,
      sender: {
        sender_type: item.sender?.sender_type,
        sender_name: item.sender?.name,
      },
      body: typeof item.content === "string" ? { content: item.content } : undefined,
      mentions: item.mentions?.flatMap((mention) => mention.id ? [{ id: mention.id }] : []) ?? undefined,
    };
  });
  return formatGroupHistoryItems(items, options);
}
