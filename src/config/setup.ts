import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Input, truncateToWidth, type Component, type Focusable } from "@earendil-works/pi-tui";

export interface FeishuSetupValues {
  appId: string;
  appSecret: string;
  requireMention: boolean;
  maxConversations?: string;
  idleConversationMs?: string;
  groupContextMessages?: string;
  groupContextLookbackMs?: string;
  groupContextSource?: string;
}

function requiredCredential(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} 不能为空。`);
  if (/\s|[\r\n\0]/u.test(trimmed)) throw new Error(`${label} 不能包含空白或换行。`);
  return trimmed;
}

export function normalizeFeishuSetup(values: FeishuSetupValues): FeishuSetupValues {
  return {
    appId: requiredCredential(values.appId, "FEISHU_APP_ID"),
    appSecret: requiredCredential(values.appSecret, "FEISHU_APP_SECRET"),
    requireMention: values.requireMention,
    ...(values.maxConversations === undefined ? {} : { maxConversations: values.maxConversations }),
    ...(values.idleConversationMs === undefined ? {} : { idleConversationMs: values.idleConversationMs }),
    ...(values.groupContextMessages === undefined ? {} : { groupContextMessages: values.groupContextMessages }),
    ...(values.groupContextLookbackMs === undefined ? {} : { groupContextLookbackMs: values.groupContextLookbackMs }),
    ...(values.groupContextSource === undefined ? {} : { groupContextSource: values.groupContextSource }),
  };
}

export function renderFeishuEnv(values: FeishuSetupValues): string {
  const normalized = normalizeFeishuSetup(values);
  const lines = [
    `FEISHU_APP_ID=${normalized.appId}`,
    `FEISHU_APP_SECRET=${normalized.appSecret}`,
    `FEISHU_REQUIRE_MENTION=${String(normalized.requireMention)}`,
  ];
  if (normalized.maxConversations) lines.push(`FEISHU_MAX_CONVERSATIONS=${normalized.maxConversations}`);
  if (normalized.idleConversationMs) lines.push(`FEISHU_IDLE_CONVERSATION_MS=${normalized.idleConversationMs}`);
  if (normalized.groupContextMessages) lines.push(`FEISHU_GROUP_CONTEXT_MESSAGES=${normalized.groupContextMessages}`);
  if (normalized.groupContextLookbackMs) lines.push(`FEISHU_GROUP_CONTEXT_LOOKBACK_MS=${normalized.groupContextLookbackMs}`);
  if (normalized.groupContextSource) lines.push(`FEISHU_GROUP_CONTEXT_SOURCE=${normalized.groupContextSource}`);
  return `${lines.join("\n")}\n`;
}

export async function persistFeishuEnv(
  stateDir: string,
  envFile: string,
  values: FeishuSetupValues,
): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(stateDir, 0o700);
  const temp = join(stateDir, `.env.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, renderFeishuEnv(values), { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") await chmod(temp, 0o600);
    await rename(temp, envFile);
    if (process.platform !== "win32") await chmod(envFile, 0o600);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/** Single-line Pi TUI input whose render path never contains the real secret. */
export class MaskedSecretInput implements Component, Focusable {
  private readonly input = new Input();
  onSubmit?: (value: string) => void;
  onCancel?: () => void;

  constructor(
    private readonly title: string,
    private readonly requestRender: () => void = () => {},
  ) {
    this.input.onSubmit = (value) => this.onSubmit?.(value);
    this.input.onEscape = () => this.onCancel?.();
  }

  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }

  getValue(): string { return this.input.getValue(); }

  handleInput(data: string): void {
    this.input.handleInput(data);
    this.requestRender();
  }

  render(width: number): string[] {
    const secret = this.input.getValue();
    this.input.setValue("•".repeat(secret.length));
    try {
      return [truncateToWidth(this.title, width, "…"), ...this.input.render(width)];
    } finally {
      this.input.setValue(secret);
    }
  }

  invalidate(): void { this.input.invalidate(); }
}
