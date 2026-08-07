/**
 * pi ↔ 飞书机器人桥接扩展
 *
 * 会话隔离规则：
 *   - 群聊：同一 chatId 共享一个持久化 AgentSession
 *   - 单聊：同一 senderId 共享一个持久化 AgentSession
 *
 * 飞书消息不再注入当前 TUI 会话；每个会话键拥有独立上下文、串行队列和回复流。
 */
import { createLarkChannel, LoggerLevel } from "@larksuiteoapi/node-sdk";
import {
  getAgentDir,
  type AgentSessionEvent,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { MaskedSecretInput, persistFeishuEnv } from "./config/setup.ts";
import {
  acquireConnectionLock,
  FeishuConnectionBusyError,
  readConnectionLock,
  releaseConnectionLock,
  type FeishuConnectionLock,
} from "./connection/connection-lock.ts";
import { isUnexpectedAutonomousStart, visibleSubagentCustomText } from "./messaging/event-routing.ts";
import { conversationKey, formatFeishuPrompt } from "./messaging/routing.ts";
import { replaceCardWithRetry, runSingleCardProgress } from "./messaging/single-card-stream.ts";
import { failureCard, finalMarkdownCard, THINKING_PROGRESS, toolProgress } from "./messaging/stream-card.ts";
import { isSubagentProcess } from "./runtime/agent-runtime.ts";
import { RpcAgentSession, resolveSubagentsInstall } from "./runtime/rpc-agent-session.ts";
import { initializeConversationOwned } from "./sessions/conversation-lifecycle.ts";
import { createGenerationIsCurrent, selectSafeIdleVictim, SerialCapacityGate } from "./sessions/conversation-pool.ts";
import {
  emptySessionIndex,
  findManagedSession,
  formatSessionList,
  migrateSessionIndex,
  normalizeSessionName,
  parseSessionControlCommand,
  uniqueDefaultSessionName,
  type ChatSessionState,
  type SessionControlCommand,
  type SessionIndexV2,
} from "./sessions/session-control.ts";
import { isRestorableSessionFile, secureEnvFileBeforeRead, secureSessionFile, secureSessionStorage } from "./sessions/storage-security.ts";

export { conversationKey, formatFeishuPrompt } from "./messaging/routing.ts";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const STATE_DIR = join(getAgentDir(), "state", "pi-feishu-bot");
const ENV_FILE = join(STATE_DIR, ".env");
const SESSION_DIR = join(STATE_DIR, "sessions");
const SESSION_INDEX_FILE = join(SESSION_DIR, "index.json");
const CONNECTION_LOCK_FILE = join(STATE_DIR, "connection.lock");

function loadEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(ENV_FILE)) return out;
  secureEnvFileBeforeRead(ENV_FILE);
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

const fileEnv = loadEnvFile();
const APP_ID = process.env.FEISHU_APP_ID ?? fileEnv.FEISHU_APP_ID ?? "";
const APP_SECRET = process.env.FEISHU_APP_SECRET ?? fileEnv.FEISHU_APP_SECRET ?? "";
const REQUIRE_MENTION =
  (process.env.FEISHU_REQUIRE_MENTION ?? fileEnv.FEISHU_REQUIRE_MENTION ?? "true") !== "false";

// ---------------------------------------------------------------------------
// 流式回复
// ---------------------------------------------------------------------------
interface TurnFeed {
  chunks: string[];
  waiters: Array<() => void>;
  done: boolean;
}

function createFeed(): TurnFeed {
  return { chunks: [], waiters: [], done: false };
}

function pushChunk(feed: TurnFeed, chunk: string): void {
  if (feed.done || !chunk) return;
  feed.chunks.push(chunk);
  const waiters = feed.waiters.splice(0);
  for (const resolve of waiters) resolve();
}

function finishFeed(feed: TurnFeed): void {
  if (feed.done) return;
  feed.done = true;
  const waiters = feed.waiters.splice(0);
  for (const resolve of waiters) resolve();
}

async function nextChunk(feed: TurnFeed): Promise<string | null> {
  while (feed.chunks.length === 0 && !feed.done) {
    await new Promise<void>((resolve) => feed.waiters.push(resolve));
  }
  return feed.chunks.length > 0 ? feed.chunks.shift()! : null;
}

interface PendingTurn {
  chatId: string;
  messageId: string;
  feed: TurnFeed;
  thinkingNoticed: boolean;
  finalText: string;
  failureText: string | null;
  progress: Promise<{ messageId: string | null; error?: unknown }>;
}

interface Conversation {
  key: string;
  session: RpcAgentSession;
  unsubscribe: () => void;
  tail: Promise<void>;
  active: PendingTurn | null;
  lastUsedAt: number;
  queuedTurnCount: number;
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------
function summarizeTool(toolName: string, args: any): string {
  const a = args ?? {};
  if (typeof a.command === "string") return truncate(a.command, 80);
  if (typeof a.path === "string") return a.path;
  if (typeof a.pattern === "string") return a.pattern;
  for (const value of Object.values(a)) {
    if (typeof value === "string") return truncate(value, 60);
    break;
  }
  return "";
}

function truncate(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? normalized.slice(0, max) + "…" : normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------
let activeChannel: ReturnType<typeof createLarkChannel> | null = null;

export function __getChannelStatus() {
  return activeChannel?.getConnectionStatus();
}

export default function (pi: ExtensionAPI) {
  // Child processes may explicitly load parent extensions. Never construct a
  // second Feishu channel there: it would duplicate the long connection/replies.
  if (isSubagentProcess()) return;

  pi.registerCommand("feishu-setup", {
    description: "交互配置飞书 App ID、App Secret 和群聊 @ 策略",
    handler: async (_args: string, ctx: any) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(`交互配置仅支持 Pi TUI；也可以手动写入 ${ENV_FILE}。`, "error");
        return;
      }
      if ((APP_ID || APP_SECRET) && !(await ctx.ui.confirm(
        "重新配置飞书机器人",
        "现有凭据将被新输入覆盖，是否继续？",
      ))) return;

      const appId = await ctx.ui.input("飞书 App ID", "cli_xxxxxxxxxxxxxxxx");
      if (appId === undefined) return;
      const appSecret: string | null | undefined = await ctx.ui.custom((tui: any, _theme: any, _keybindings: any, done: (value: string | null) => void) => {
        const input = new MaskedSecretInput("飞书 App Secret（输入内容已隐藏）", () => tui.requestRender());
        input.onSubmit = (value) => done(value);
        input.onCancel = () => done(null);
        return input;
      });
      if (appSecret === null || appSecret === undefined) return;
      const mentionChoice = await ctx.ui.select("群聊响应策略", [
        "仅在 @机器人时响应（推荐）",
        "响应群内所有文字消息",
      ]);
      if (mentionChoice === undefined) return;

      try {
        await persistFeishuEnv(STATE_DIR, ENV_FILE, {
          appId,
          appSecret,
          requireMention: mentionChoice.startsWith("仅在"),
          ...(fileEnv.FEISHU_MAX_CONVERSATIONS === undefined ? {} : { maxConversations: fileEnv.FEISHU_MAX_CONVERSATIONS }),
          ...(fileEnv.FEISHU_IDLE_CONVERSATION_MS === undefined ? {} : { idleConversationMs: fileEnv.FEISHU_IDLE_CONVERSATION_MS }),
        });
      } catch (error) {
        ctx.ui.notify(`飞书配置保存失败：${errorMessage(error)}`, "error");
        return;
      }
      ctx.ui.notify(`飞书配置已安全写入 ${ENV_FILE}，正在重新加载扩展。`, "info");
      await ctx.reload();
      return;
    },
  });

  if (!APP_ID || !APP_SECRET) {
    console.error(
      "[feishu-bot] ❌ 缺少 FEISHU_APP_ID / FEISHU_APP_SECRET，请设置环境变量，或写入 " +
        ENV_FILE +
        " 后执行 /reload",
    );
    return;
  }

  const channel = createLarkChannel({
    appId: APP_ID,
    appSecret: APP_SECRET,
    source: "pi-feishu-bot",
    loggerLevel: LoggerLevel.warn,
    policy: { requireMention: REQUIRE_MENTION },
    safety: {
      dedup: { ttl: 60_000 },
      chatQueue: { enabled: true },
      // SDK 默认会在 600ms 内合并同群消息，导致发送者和 replyTo 丢失。
      batch: { text: { delayMs: 0, maxMessages: 1 } },
    },
    // shutdown 需要等待连接尝试结束；为异常网络设置明确上限。
    handshakeTimeoutMs: 15_000,
    outbound: {
      // 降低 CardKit 更新频率，减少限频导致的静默停更风险。
      streamThrottleMs: 1_000,
      streamThrottleChars: 100,
    },
  });

  activeChannel = channel;

  const conversations = new Map<string, Conversation>();
  const pendingTurns = new Set<PendingTurn>();
  let sessionIndex: SessionIndexV2 = emptySessionIndex();
  let indexWrite = Promise.resolve();
  const pendingNewNames = new Map<string, string>();
  const pendingDeletes = new Map<string, { sessionId: string; senderId: string; expiresAt: number }>();
  let botCwd = "";
  let shuttingDown = false;
  let lifecycleGeneration = 0;
  let connectionPromise: Promise<void> | null = null;
  let lifecycleTail = Promise.resolve();
  const capacityGate = new SerialCapacityGate();
  let ownedLock: FeishuConnectionLock | null = null;
  const maxConversations = Math.max(1, Number(process.env.FEISHU_MAX_CONVERSATIONS ?? fileEnv.FEISHU_MAX_CONVERSATIONS ?? 20) || 20);
  const idleConversationMs = Math.max(60_000, Number(process.env.FEISHU_IDLE_CONVERSATION_MS ?? fileEnv.FEISHU_IDLE_CONVERSATION_MS ?? 30 * 60_000) || 30 * 60_000);
  let idleSweep: ReturnType<typeof setInterval> | null = null;

  function runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const current = lifecycleTail.then(operation, operation);
    lifecycleTail = current.then(
      () => {},
      () => {},
    );
    return current;
  }

  async function writeSessionIndex(): Promise<void> {
    const tempFile = SESSION_INDEX_FILE + ".tmp";
    const snapshot = JSON.stringify(sessionIndex, null, 2) + "\n";
    await writeFile(tempFile, snapshot, { encoding: "utf8", mode: 0o600 });
    await chmod(tempFile, 0o600);
    await rename(tempFile, SESSION_INDEX_FILE);
    await chmod(SESSION_INDEX_FILE, 0o600);
  }

  function mutateSessionIndex(mutate: (index: SessionIndexV2) => void): Promise<void> {
    const transaction = indexWrite.catch(() => {}).then(async () => {
      const previous = structuredClone(sessionIndex);
      mutate(sessionIndex);
      try {
        await writeSessionIndex();
      } catch (error) {
        sessionIndex = previous;
        throw error;
      }
    });
    indexWrite = transaction.then(() => {}, () => {});
    return transaction;
  }

  async function loadSessionIndex(): Promise<void> {
    await secureSessionStorage(SESSION_DIR);
    try {
      const parsed = JSON.parse(await readFile(SESSION_INDEX_FILE, "utf8"));
      sessionIndex = migrateSessionIndex(parsed, randomUUID);
      if (parsed?.version !== 2) await writeSessionIndex();
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        console.error("[feishu-bot] ⚠️ 会话索引读取失败，将创建新索引:", errorMessage(error));
      }
      sessionIndex = emptySessionIndex();
    }
  }

  function commitSessionMapping(key: string, sessionFile: string): Promise<void> {
    const requestedName = pendingNewNames.get(key);
    const transaction = mutateSessionIndex((index) => {
      const now = new Date().toISOString();
      const chat = index.chats[key] ??= { sessions: [] };
      const active = chat.sessions.find((entry) => entry.id === chat.activeId);
      if (active) {
        active.file = sessionFile;
        active.lastUsedAt = now;
        return;
      }
      const id = randomUUID();
      const name = requestedName ?? uniqueDefaultSessionName(chat);
      chat.sessions.push({ id, name, file: sessionFile, createdAt: now, lastUsedAt: now });
      chat.activeId = id;
    });
    return transaction.then(() => { pendingNewNames.delete(key); });
  }

  function touchActiveSession(key: string): Promise<void> {
    return mutateSessionIndex((index) => {
      const chat = index.chats[key];
      const active = chat?.sessions.find((entry) => entry.id === chat.activeId);
      if (active) active.lastUsedAt = new Date().toISOString();
    });
  }

  async function forceDisconnectChannel(): Promise<void> {
    try {
      await channel.disconnect();
    } finally {
      // SDK 1.72 在握手尚未标记 connected 时 disconnect() 不会 close；
      // 强制关闭底层客户端，阻止失败启动后的自动重连泄漏到新 runtime。
      try {
        channel.rawWsClient?.close({});
      } catch {
        /* noop */
      }
    }
  }

  async function initializeAgentRuntime(cwd: string): Promise<void> {
    botCwd = cwd;
    await loadSessionIndex();

    // Resolve through this package, never through ~/.pi or another platform layout.
    resolveSubagentsInstall();
    idleSweep ??= setInterval(() => { void evictSafeIdleConversation(false); }, Math.min(idleConversationMs, 60_000));
  }

  async function evictSafeIdleConversation(forceForCapacity = false): Promise<boolean> {
    const victim = selectSafeIdleVictim(conversations.values(), Date.now(), idleConversationMs, forceForCapacity);
    if (!victim) return false;
    conversations.delete(victim.key);
    victim.unsubscribe();
    await victim.session.dispose();
    return true;
  }

  async function createConversation(key: string, expectedGeneration: number): Promise<Conversation> {
    if (!createGenerationIsCurrent(shuttingDown, expectedGeneration, lifecycleGeneration)) throw new Error("机器人正在重启");
    if (!botCwd) {
      throw new Error("Agent runtime 尚未初始化");
    }

    const chatState = sessionIndex.chats[key];
    const activeSession = chatState?.sessions.find((entry) => entry.id === chatState.activeId);
    const savedPath = activeSession?.file;
    const restorablePath = isRestorableSessionFile(savedPath) ? savedPath : undefined;
    if (conversations.size >= maxConversations && !(await evictSafeIdleConversation(true))) {
      throw new Error(`飞书 Agent 会话已达安全上限（${maxConversations}），且没有可安全释放的空闲会话。`);
    }
    if (!createGenerationIsCurrent(shuttingDown, expectedGeneration, lifecycleGeneration)) throw new Error("机器人正在重启");
    let session!: RpcAgentSession;
    session = await RpcAgentSession.create({
      cwd: botCwd,
      sessionDir: SESSION_DIR,
      savedPath: restorablePath,
      onDeath: (dead) => {
        const owned = conversations.get(key);
        if (owned?.session === dead) {
          conversations.delete(key);
          owned.unsubscribe();
        }
      },
    });

    const conversation = await initializeConversationOwned({
      session,
      secureSessionFile,
      // The process-local policy extension already registered the ceiling
      // before get_state completed; this lease keeps cleanup transactional.
      registerCeiling: () => ({ dispose: () => {} }),
      create: () => ({ key, session, unsubscribe: () => {}, tail: Promise.resolve(), active: null, lastUsedAt: Date.now(), queuedTurnCount: 0 }),
      subscribe: (created) => session.subscribe((event) => handleAgentEvent(created, event)),
      setUnsubscribe: (created, unsubscribe) => { created.unsubscribe = unsubscribe; },
      commit: async (sessionFile) => {
        if (shuttingDown) throw new Error("机器人正在重启");
        await commitSessionMapping(key, sessionFile);
        if (shuttingDown) throw new Error("机器人正在重启");
      },
      publish: (created) => conversations.set(key, created),
    });
    console.log(`[feishu-bot] 🧠 会话已加载: ${key} → ${session.sessionId}`);
    return conversation;
  }

  function getConversationAndReserve(key: string, expectedGeneration: number): Promise<Conversation> {
    return capacityGate.run(async () => {
      if (!createGenerationIsCurrent(shuttingDown, expectedGeneration, lifecycleGeneration)) throw new Error("机器人正在重启");
      let existing = conversations.get(key);
      if (existing?.session.unusable) {
        conversations.delete(key); existing.unsubscribe(); await existing.session.dispose().catch(() => {}); existing = undefined;
      }
      const conversation = existing ?? await createConversation(key, expectedGeneration);
      // Reservation is acquired inside the same capacity transaction as lookup/create/publish.
      conversation.queuedTurnCount++;
      conversation.lastUsedAt = Date.now();
      return conversation;
    });
  }

  function handleAgentEvent(conversation: Conversation, event: AgentSessionEvent): void {
    const turn = conversation.active;
    if (!turn) {
      if (isUnexpectedAutonomousStart(event, false)) {
        console.warn(`[feishu-bot] ⚠️ 会话 ${conversation.key} 收到无当前 turn 的自主 agent_start，已忽略以防错投。`);
      }
      return;
    }

    switch (event.type) {
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (update.type === "thinking_delta" && !turn.thinkingNoticed) {
          turn.thinkingNoticed = true;
          pushChunk(turn.feed, THINKING_PROGRESS);
        } else if (update.type === "text_delta") {
          turn.finalText += update.delta;
          pushChunk(turn.feed, update.delta);
        }
        break;
      }
      case "message_end": {
        const visible = visibleSubagentCustomText(event);
        if (visible) {
          turn.finalText = visible;
          pushChunk(turn.feed, `\n${turn.finalText}\n`);
        }
        break;
      }
      case "tool_execution_start": {
        const detail = summarizeTool(event.toolName, event.args);
        pushChunk(turn.feed, toolProgress(event.toolName, detail));
        break;
      }
      default:
        break;
    }
  }

  function streamProducer(turn: PendingTurn) {
    return async (controller: { append(chunk: string): Promise<void> }) => {
      for (;;) {
        const chunk = await nextChunk(turn.feed);
        if (chunk === null) break;
        await controller.append(chunk);
      }
    };
  }

  async function safeSend(
    input: { text: string } | { markdown: string },
    chatId: string,
    replyTo?: string,
  ): Promise<void> {
    try {
      await channel.send(chatId, input, replyTo ? { replyTo } : undefined);
    } catch (error) {
      console.error("[feishu-bot] ❌ 发送消息失败:", errorMessage(error));
    }
  }

  function createPendingTurn(chatId: string, messageId: string): PendingTurn {
    const turn: PendingTurn = {
      chatId,
      messageId,
      feed: createFeed(),
      thinkingNoticed: false,
      finalText: "",
      failureText: null,
      progress: Promise.resolve({ messageId: null }),
    };
    pendingTurns.add(turn);
    turn.progress = runSingleCardProgress(channel, chatId, messageId, streamProducer(turn)).then((result) => ({
      messageId: result.messageId,
      error: result.creationError ?? result.producerError ?? result.progressUpdateError,
    }));
    return turn;
  }

  async function replaceTerminalCard(turn: PendingTurn): Promise<void> {
    finishFeed(turn.feed);
    const progress = await turn.progress;
    if (!progress.messageId) {
      console.error("[feishu-bot] ❌ 进度卡创建失败:", errorMessage(progress.error));
      return;
    }
    if (progress.error && !turn.failureText) {
      turn.failureText = `流式更新失败：${truncate(errorMessage(progress.error), 240)}`;
    }
    const terminal = turn.failureText
      ? failureCard(turn.failureText)
      : finalMarkdownCard(turn.finalText.trim());
    try {
      await replaceCardWithRetry(channel, progress.messageId, terminal);
    } catch (error) {
      // Never send a second message: all retries target the original message id.
      console.error("[feishu-bot] ❌ 最终卡片替换失败（已重试）:", errorMessage(error));
    }
  }

  async function runTurn(
    conversation: Conversation,
    turn: PendingTurn,
    prompt: string,
  ): Promise<void> {
    if (shuttingDown) {
      turn.failureText = "机器人正在重启，请稍后重试。";
      await replaceTerminalCard(turn);
      pendingTurns.delete(turn);
      return;
    }

    conversation.active = turn;
    try {
      await conversation.session.prompt(prompt);
      if (!turn.finalText.trim()) {
        const emptyReply = "\n✅ 处理完成，但没有生成文本回复。";
        turn.finalText = emptyReply.trim();
        pushChunk(turn.feed, emptyReply);
      }
    } catch (error) {
      turn.failureText ??= truncate(errorMessage(error), 300);
      pushChunk(turn.feed, `\n\n❌ 处理失败：${turn.failureText}`);
      console.error(`[feishu-bot] ❌ 会话 ${conversation.key} 处理失败:`, error);
    } finally {
      await secureSessionFile(conversation.session.sessionFile).catch((error) => {
        console.error("[feishu-bot] ❌ 会话文件权限设置失败:", errorMessage(error));
      });
      conversation.active = null;
      await touchActiveSession(conversation.key).catch((error) => {
        console.error("[feishu-bot] ⚠️ 会话最后使用时间保存失败:", errorMessage(error));
      });
      await replaceTerminalCard(turn);
      pendingTurns.delete(turn);
    }
  }

  async function enqueueMessage(msg: {
    chatType: "p2p" | "group";
    chatId: string;
    senderId: string;
    senderName?: string;
    messageId: string;
    content?: string;
  }): Promise<void> {
    if (shuttingDown) {
      await safeSend({ text: "⚠️ 机器人正在重启，请稍后重试。" }, msg.chatId, msg.messageId);
      return;
    }
    const turn = createPendingTurn(msg.chatId, msg.messageId);
    try {
      const key = conversationKey(msg);
      const prompt = formatFeishuPrompt(msg);
      const generation = lifecycleGeneration;
      const conversation = await getConversationAndReserve(key, generation);
      conversation.tail = conversation.tail
        .then(async () => {
          try { await runTurn(conversation, turn, prompt); }
          finally { conversation.queuedTurnCount--; conversation.lastUsedAt = Date.now(); }
        })
        .catch((error) => { console.error(`[feishu-bot] ❌ 会话队列 ${key} 异常:`, error); });
    } catch (error) {
      const failure = `\n❌ 无法创建会话：${truncate(errorMessage(error), 300)}`;
      turn.failureText = truncate(errorMessage(error), 300);
      turn.finalText = failure.trim();
      pushChunk(turn.feed, failure);
      await replaceTerminalCard(turn);
      pendingTurns.delete(turn);
      console.error("[feishu-bot] ❌ 消息入队失败:", error);
    }
  }

  function requireIdleConversation(key: string): Conversation | undefined {
    const conversation = conversations.get(key);
    if (conversation && (conversation.active !== null || conversation.queuedTurnCount > 0 || !conversation.session.isSafeToEvict())) {
      throw new Error("当前会话仍有任务正在处理，请等待完成后再管理会话。");
    }
    return conversation;
  }

  async function disposeLoadedConversation(key: string): Promise<void> {
    const conversation = requireIdleConversation(key);
    if (!conversation) return;
    conversations.delete(key);
    conversation.unsubscribe();
    await conversation.session.dispose();
  }

  function getChatState(key: string): ChatSessionState | undefined {
    return sessionIndex.chats[key];
  }

  function currentManagedSession(key: string) {
    const chat = getChatState(key);
    return chat?.sessions.find((entry) => entry.id === chat.activeId);
  }

  async function switchManagedSession(key: string, targetId: string): Promise<string> {
    const chat = getChatState(key);
    const target = chat?.sessions.find((entry) => entry.id === targetId);
    if (!chat || !target) throw new Error("找不到指定会话。");
    if (chat.activeId === target.id) return `当前已经是会话「${target.name}」。`;
    const hasHistory = isRestorableSessionFile(target.file);
    await disposeLoadedConversation(key);
    await mutateSessionIndex((index) => {
      const state = index.chats[key]!;
      const previousId = state.activeId;
      state.activeId = target.id;
      state.previousId = previousId;
      const selected = state.sessions.find((entry) => entry.id === target.id)!;
      selected.lastUsedAt = new Date().toISOString();
    });
    return hasHistory
      ? `✅ 已切换到会话「${target.name}」，下一条消息将继续该会话的历史上下文。`
      : `✅ 已切换到会话「${target.name}」。该会话尚无可恢复记录，下一条消息将从全新上下文开始。`;
  }

  async function handleSessionControl(
    msg: { chatType: "p2p" | "group"; chatId: string; senderId: string; messageId: string },
    command: SessionControlCommand,
  ): Promise<void> {
    const key = conversationKey(msg);
    const reply = async (text: string) => safeSend({ text }, msg.chatId, msg.messageId);
    try {
      if (command.type === "list") {
        await reply(formatSessionList(getChatState(key)));
        return;
      }
      if (command.type === "current") {
        const current = currentManagedSession(key);
        await reply(current
          ? `当前会话：${current.name}\nID: ${current.id.slice(0, 8)}\n创建时间：${current.createdAt.replace("T", " ").slice(0, 16)}`
          : "当前聊天还没有会话；发送普通消息后会自动创建。");
        return;
      }
      if (command.type === "cancel-delete") {
        const pending = pendingDeletes.get(key);
        if (pending?.senderId === msg.senderId) pendingDeletes.delete(key);
        await reply(pending?.senderId === msg.senderId ? "已取消删除会话。" : "当前没有由你发起的待确认删除操作。");
        return;
      }
      if (command.type === "delete") {
        const target = findManagedSession(getChatState(key), command.target);
        if (!target) throw new Error(`找不到会话「${command.target}」。请先说“查看历史会话”。`);
        pendingDeletes.set(key, { sessionId: target.id, senderId: msg.senderId, expiresAt: Date.now() + 5 * 60_000 });
        await reply(`⚠️ 删除会话「${target.name}」将永久删除其上下文。\n请在 5 分钟内回复：“确认删除会话 ${target.name}”\n回复“取消删除”可取消。`);
        return;
      }
      if (command.type === "confirm-delete") {
        const pending = pendingDeletes.get(key);
        if (!pending || pending.senderId !== msg.senderId || pending.expiresAt < Date.now()) {
          pendingDeletes.delete(key);
          throw new Error("没有有效的待确认删除操作，请先说“删除会话 会话名”。");
        }
        const chat = getChatState(key);
        const target = chat?.sessions.find((entry) => entry.id === pending.sessionId);
        if (!target) {
          pendingDeletes.delete(key);
          throw new Error("待删除会话已经不存在。");
        }
        if (command.target) {
          const confirmed = findManagedSession(chat, command.target);
          if (confirmed?.id !== target.id) throw new Error("确认的会话名称与待删除会话不一致。");
        }
        await capacityGate.run(async () => {
          if (chat?.activeId === target.id) await disposeLoadedConversation(key);
          await mutateSessionIndex((index) => {
            const state = index.chats[key];
            if (!state) return;
            state.sessions = state.sessions.filter((entry) => entry.id !== target.id);
            if (state.activeId === target.id) {
              const fallback = [...state.sessions].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))[0];
              state.activeId = fallback?.id;
            }
            if (state.previousId === target.id) delete state.previousId;
            if (state.sessions.length === 0) delete index.chats[key];
          });
        });
        pendingDeletes.delete(key);
        const sessionRoot = resolve(SESSION_DIR) + sep;
        if (resolve(target.file).startsWith(sessionRoot)) {
          await unlink(target.file).catch((error: any) => {
            if (error?.code !== "ENOENT") console.error("[feishu-bot] ⚠️ 历史会话文件删除失败:", errorMessage(error));
          });
        }
        await reply(`✅ 已删除会话「${target.name}」。`);
        return;
      }
      if (command.type === "switch") {
        const target = findManagedSession(getChatState(key), command.target);
        if (!target) throw new Error(`找不到会话「${command.target}」。请先说“查看历史会话”。`);
        const result = await capacityGate.run(() => switchManagedSession(key, target.id));
        await reply(result);
        return;
      }
      if (command.type === "restore") {
        const chat = getChatState(key);
        const target = chat?.sessions.find((entry) => entry.id === chat.previousId);
        if (!target) throw new Error("没有可以恢复的上一个会话。");
        const result = await capacityGate.run(() => switchManagedSession(key, target.id));
        await reply(result);
        return;
      }
      if (command.type === "new") {
        const result = await capacityGate.run(async () => {
          const existingChat = getChatState(key);
          const name = command.name ? normalizeSessionName(command.name) : uniqueDefaultSessionName(existingChat);
          if (existingChat?.sessions.some((entry) => entry.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
            throw new Error(`会话名称「${name}」已存在，请换一个名称。`);
          }
          await disposeLoadedConversation(key);
          await mutateSessionIndex((index) => {
            const state = index.chats[key] ??= { sessions: [] };
            state.previousId = state.activeId;
            delete state.activeId;
          });
          pendingNewNames.set(key, name);
          try {
            await createConversation(key, lifecycleGeneration);
          } catch (error) {
            pendingNewNames.delete(key);
            await mutateSessionIndex((index) => {
              const state = index.chats[key];
              if (state?.previousId) state.activeId = state.previousId;
            }).catch(() => {});
            throw error;
          }
          return name;
        });
        pendingDeletes.delete(key);
        await reply(`✅ 已创建并切换到新会话「${result}」，下一条普通消息将使用全新上下文。`);
      }
    } catch (error) {
      await reply(`❌ 会话操作失败：${errorMessage(error)}`);
    }
  }

  channel.on({
    error: (error) => {
      console.error(
        `[feishu-bot] ❌ 通道错误: ${error.code} ${error.message}`,
        error.cause ?? "",
      );
    },
    message: async (msg) => {
      const text = (msg.content ?? "").trim();
      if (!text) {
        if (msg.resources.length > 0) {
          await safeSend(
            { text: "📎 暂不支持图片/文件消息，请直接发文字给我" },
            msg.chatId,
            msg.messageId,
          );
        }
        return;
      }

      const sessionCommand = parseSessionControlCommand(text);
      if (sessionCommand) {
        void handleSessionControl({
          chatType: msg.chatType,
          chatId: msg.chatId,
          senderId: msg.senderId,
          messageId: msg.messageId,
        }, sessionCommand);
        return;
      }

      // 不阻塞飞书事件循环；每个会话内部由 conversation.tail 串行处理。
      void enqueueMessage({
        chatType: msg.chatType,
        chatId: msg.chatId,
        senderId: msg.senderId,
        senderName: msg.senderName,
        messageId: msg.messageId,
        content: text,
      });
    },
  });

  async function disposeAgentRuntime(notice: string): Promise<void> {
    for (const turn of pendingTurns) {
      turn.failureText = truncate(notice, 240);
      finishFeed(turn.feed);
    }

    // 等待已开始的会话创建完成；createConversation 会在 shuttingDown 时自行清理。
    await capacityGate.run(async () => {});
    await Promise.allSettled(
      [...conversations.values()]
        .filter((conversation) => conversation.session.isStreaming)
        .map((conversation) => conversation.session.abort()),
    );
    await Promise.allSettled([...conversations.values()].map((conversation) => conversation.tail));
    await Promise.allSettled([...pendingTurns].map((turn) => replaceTerminalCard(turn)));

    for (const conversation of conversations.values()) {
      conversation.unsubscribe();
      await conversation.session.dispose();
    }
    conversations.clear();
    if (idleSweep) clearInterval(idleSweep);
    idleSweep = null;
    pendingTurns.clear();
    pendingNewNames.clear();
    pendingDeletes.clear();
    await indexWrite.catch(() => {});
    botCwd = "";
  }

  async function connectFeishu(ctx: {
    cwd: string;
    sessionManager: {
      getSessionId(): string;
      getSessionFile(): string | undefined;
    };
  }): Promise<void> {
    if (ownedLock) return;
    if (connectionPromise) return connectionPromise;

    const generation = ++lifecycleGeneration;
    shuttingDown = false;
    connectionPromise = (async () => {
      await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
      await chmod(STATE_DIR, 0o700);
      ownedLock = await acquireConnectionLock(CONNECTION_LOCK_FILE, {
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
        cwd: ctx.cwd,
      });

      try {
        await initializeAgentRuntime(ctx.cwd);
        if (shuttingDown || generation !== lifecycleGeneration) {
          throw new Error("连接请求已取消");
        }
        await channel.connect();
        if (shuttingDown || generation !== lifecycleGeneration) {
          throw new Error("连接请求已取消");
        }
        console.log(
          `[feishu-bot] ✅ 飞书长连接已建立 | PID ${process.pid} | session ${ownedLock.sessionId} | cwd ${ownedLock.cwd}`,
        );
      } catch (error) {
        await forceDisconnectChannel().catch(() => {});
        await disposeAgentRuntime("\n\n⚠️ 飞书连接失败，本次任务已中止。\n");
        try {
          const released = await releaseConnectionLock(CONNECTION_LOCK_FILE, ownedLock);
          if (released) ownedLock = null;
        } catch (releaseError) {
          console.error("[feishu-bot] ⚠️ 连接失败后无法释放独占锁:", errorMessage(releaseError));
        }
        throw error;
      }
    })();

    try {
      await connectionPromise;
    } finally {
      connectionPromise = null;
    }
  }

  async function disconnectFeishu(finalShutdown: boolean): Promise<boolean> {
    shuttingDown = true;
    lifecycleGeneration++;
    await connectionPromise?.catch(() => {});
    connectionPromise = null;
    await forceDisconnectChannel().catch(() => {});
    await disposeAgentRuntime(
      finalShutdown
        ? "\n\n⚠️ 机器人会话正在关闭，本次任务已中止，请稍后重试。"
        : "\n\n⚠️ 飞书连接已由终端主动断开，本次任务已中止。",
    );
    let released = ownedLock === null;
    try {
      released = (await releaseConnectionLock(CONNECTION_LOCK_FILE, ownedLock)) || released;
      if (released) ownedLock = null;
    } catch (error) {
      console.error("[feishu-bot] ⚠️ 释放连接锁失败:", errorMessage(error));
    }
    if (!finalShutdown) shuttingDown = false;
    return released;
  }

  pi.on("session_start", async () => {
    shuttingDown = false;
    lifecycleGeneration++;
    console.log("[feishu-bot] ℹ️ 已加载但未连接；执行 /connect-feishu 开启飞书长连接");
  });

  pi.on("session_shutdown", async () => {
    await runLifecycle(() => disconnectFeishu(true));
  });

  pi.registerCommand("connect-feishu", {
    description: "在当前 pi 会话中独占连接飞书机器人",
    handler: async (_args: string, ctx: any) => {
      await runLifecycle(async () => {
        if (ownedLock) {
          ctx.ui.notify(
            `飞书已连接 | PID ${ownedLock.pid} | session ${ownedLock.sessionId} | cwd ${ownedLock.cwd}`,
            "info",
          );
          return;
        }
        try {
          await connectFeishu(ctx);
          ctx.ui.notify(`飞书连接成功，工作区：${ctx.cwd}`, "info");
        } catch (error) {
          const message =
            error instanceof FeishuConnectionBusyError
              ? error.message
              : `飞书连接失败：${errorMessage(error)}`;
          ctx.ui.notify(message, "error");
        }
      });
    },
  });

  pi.registerCommand("disconnect-feishu", {
    description: "断开当前 pi 会话持有的飞书连接并释放独占锁",
    handler: async (_args: string, ctx: any) => {
      await runLifecycle(async () => {
        if (!ownedLock) {
          const owner = await readConnectionLock(CONNECTION_LOCK_FILE);
          ctx.ui.notify(
            owner
              ? `当前会话未连接；飞书由 PID ${owner.pid}、session ${owner.sessionId} 占用，工作区：${owner.cwd}`
              : "飞书当前未连接",
            "info",
          );
          return;
        }
        const released = await disconnectFeishu(false);
        ctx.ui.notify(
          released
            ? "飞书连接已断开，独占锁已释放"
            : "飞书连接已断开，但独占锁释放失败；请再次执行 /disconnect-feishu 或退出 pi",
          released ? "info" : "error",
        );
      });
    },
  });

  pi.registerCommand("feishu", {
    description: "显示飞书机器人连接、锁持有者和隔离会话状态",
    handler: async (_args: string, ctx: any) => {
      const status = channel.getConnectionStatus();
      const activeCount = [...conversations.values()].filter(
        (conversation) => conversation.active !== null,
      ).length;
      const owner = ownedLock ?? (await readConnectionLock(CONNECTION_LOCK_FILE));
      const historicalCount = Object.values(sessionIndex.chats).reduce((total, chat) => total + chat.sessions.length, 0);
      ctx.ui.notify(
        owner
          ? `飞书: ${status?.state ?? "由其他进程持有"} | PID: ${owner.pid} | session: ${owner.sessionId} | cwd: ${owner.cwd} | 已加载: ${conversations.size} | 历史会话: ${historicalCount} | 活跃: ${activeCount}`
          : "飞书: 未连接（执行 /connect-feishu）",
        "info",
      );
    },
  });
}
