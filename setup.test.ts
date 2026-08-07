import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MaskedSecretInput,
  normalizeFeishuSetup,
  persistFeishuEnv,
  renderFeishuEnv,
} from "./setup.ts";

test("setup values reject empty or whitespace-bearing credentials", () => {
  expect(() => normalizeFeishuSetup({ appId: "", appSecret: "secret", requireMention: true })).toThrow("不能为空");
  expect(() => normalizeFeishuSetup({ appId: "cli_ok", appSecret: "has space", requireMention: true })).toThrow("空白");
});

test("env rendering preserves optional pool settings without shell quoting ambiguity", () => {
  expect(renderFeishuEnv({
    appId: "cli_example",
    appSecret: "secret_example",
    requireMention: false,
    maxConversations: "12",
    idleConversationMs: "60000",
  })).toBe([
    "FEISHU_APP_ID=cli_example",
    "FEISHU_APP_SECRET=secret_example",
    "FEISHU_REQUIRE_MENTION=false",
    "FEISHU_MAX_CONVERSATIONS=12",
    "FEISHU_IDLE_CONVERSATION_MS=60000",
    "",
  ].join("\n"));
});

test("interactive secret input never renders its plaintext and still submits it", () => {
  const input = new MaskedSecretInput("App Secret");
  let submitted = "";
  input.onSubmit = (value) => { submitted = value; };
  input.focused = true;
  input.handleInput("top-secret-123");
  const rendered = input.render(80).join("\n");
  expect(rendered).not.toContain("top-secret-123");
  expect(rendered).toContain("•".repeat("top-secret-123".length));
  expect(input.getValue()).toBe("top-secret-123");
  input.handleInput("\n");
  expect(submitted).toBe("top-secret-123");
});

test("persisted setup uses private Unix permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-feishu-setup-"));
  const state = join(root, "state");
  const env = join(state, ".env");
  await persistFeishuEnv(state, env, {
    appId: "cli_example",
    appSecret: "secret_example",
    requireMention: true,
  });
  expect(await readFile(env, "utf8")).toContain("FEISHU_APP_SECRET=secret_example\n");
  if (process.platform !== "win32") {
    expect((await stat(state)).mode & 0o777).toBe(0o700);
    expect((await stat(env)).mode & 0o777).toBe(0o600);
  }
});
