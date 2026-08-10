import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_FEISHU_NOTIFY_TIMEOUT_MS,
  FEISHU_NOTIFY_TOOL,
  MAX_FEISHU_NOTIFY_TIMEOUT_MS,
  registerFeishuNotifyTool,
  sendFeishuNotification,
} from "../src/tools/notify.ts";

const WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/fixed-group";
const config = (webhook = WEBHOOK, timeoutMs = DEFAULT_FEISHU_NOTIFY_TIMEOUT_MS) => () => ({ webhook, timeoutMs });

describe("Pi fixed-group Feishu notify tool", () => {
  test("sends a bounded interactive card without exposing target selection", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const fetchMock: typeof fetch = async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify({ code: 0, msg: "success" }), { status: 200 });
    };

    const result = await sendFeishuNotification(
      `  ${"🙂".repeat(70)}  `,
      `  ${"m".repeat(1_210)}  `,
      undefined,
      { resolveConfig: config(), fetch: fetchMock },
    );

    expect(result).toEqual({
      ok: true,
      channel: "feishu",
      title: "🙂".repeat(64),
      message: "m".repeat(1_200),
    });
    expect(requestUrl).toBe(WEBHOOK);
    expect(requestInit).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      redirect: "error",
    });
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      msg_type: "interactive",
      card: {
        header: {
          title: { tag: "plain_text", content: "🙂".repeat(64) },
          template: "blue",
        },
        elements: [{ tag: "div", text: { tag: "lark_md", content: "m".repeat(1_200) } }],
      },
    });
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
  });

  test("rejects empty text, unsafe webhooks, and invalid timeout before network I/O", async () => {
    let calls = 0;
    const fetchMock: typeof fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    };
    const invalidWebhooks = [
      "not-a-url",
      "http://open.feishu.cn/open-apis/bot/v2/hook/a",
      "https://example.com/open-apis/bot/v2/hook/a",
      "https://open.feishu.cn/open-apis/bot/v2/hook/a?redirect=1",
      "https://open.feishu.cn/open-apis/bot/v2/other/a",
    ];

    await expect(sendFeishuNotification(" ", "message", undefined, { resolveConfig: config(), fetch: fetchMock }))
      .rejects.toThrow("title must not be empty");
    await expect(sendFeishuNotification("title", " ", undefined, { resolveConfig: config(), fetch: fetchMock }))
      .rejects.toThrow("message must not be empty");
    for (const webhook of invalidWebhooks) {
      await expect(sendFeishuNotification("title", "message", undefined, { resolveConfig: config(webhook), fetch: fetchMock }))
        .rejects.toThrow(/webhook|credential/);
    }
    await expect(sendFeishuNotification("title", "message", undefined, {
      resolveConfig: config(WEBHOOK, MAX_FEISHU_NOTIFY_TIMEOUT_MS + 1),
      fetch: fetchMock,
    })).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test("surfaces transport and Feishu response failures without leaking the webhook", async () => {
    const responses = [
      new Response("", { status: 503 }),
      new Response("not-json", { status: 200 }),
      new Response(JSON.stringify({ code: 1, msg: "denied" }), { status: 200 }),
    ];
    const messages: string[] = [];
    for (const response of responses) {
      try {
        await sendFeishuNotification("title", "message", undefined, {
          resolveConfig: config(),
          fetch: async () => response,
        });
      } catch (error) {
        messages.push(error instanceof Error ? error.message : String(error));
      }
    }
    expect(messages).toEqual([
      "notify: Feishu webhook returned HTTP 503",
      "notify: Feishu webhook returned a non-JSON response",
      "notify: Feishu webhook rejected the message: denied",
    ]);
    expect(JSON.stringify(messages)).not.toContain(WEBHOOK);
  });

  test("registers notify as a strict Pi tool with lifecycle guidance", () => {
    let definition: any;
    registerFeishuNotifyTool({ registerTool(tool: unknown) { definition = tool; } } as ExtensionAPI);
    expect(definition.name).toBe(FEISHU_NOTIFY_TOOL);
    expect(definition.parameters.required).toEqual(["title", "message"]);
    expect(definition.parameters.additionalProperties).toBe(false);
    expect(definition.description).toContain("recipient cannot be selected");
    expect(definition.promptGuidelines[0]).toContain("Use notify");
  });
});
