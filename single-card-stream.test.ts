import { describe, expect, test } from "bun:test";
import { replaceCardWithRetry, runSingleCardProgress } from "./single-card-stream.ts";
import { failureCard, finalMarkdownCard } from "./stream-card.ts";

class FakeChannel {
  sends: Array<{ to: string; input: any; options: any }> = [];
  updates: Array<{ id: string; card: any }> = [];
  createError?: Error;
  updateFailures = 0;
  async send(to: string, input: { card: object }, options?: { replyTo?: string }) {
    if (this.createError) throw this.createError;
    this.sends.push({ to, input, options });
    return { messageId: "progress-1" };
  }
  async updateCard(id: string, card: object) {
    this.updates.push({ id, card });
    if (this.updateFailures-- > 0) throw new Error("patch failed");
  }
}

const text = (card: any) => card.body.elements.map((e: any) => e.content).join("");

describe("controlled single-card flow", () => {
  test("success streams and replaces the sole message id", async () => {
    const channel = new FakeChannel();
    const run = await runSingleCardProgress(channel, "chat", "source", async (controller) => {
      await controller.append("思考");
      await controller.append("工具");
    }, { throttleMs: 0 });
    await replaceCardWithRetry(channel, run.messageId!, finalMarkdownCard("最终答案"));
    expect(channel.sends).toHaveLength(1);
    expect(channel.sends[0].options.replyTo).toBe("source");
    expect(channel.updates.every((u) => u.id === "progress-1")).toBe(true);
    expect(text(channel.updates.at(-1)!.card)).toBe("最终答案");
  });

  test("empty answer replaces the same card with neutral terminal content", async () => {
    const channel = new FakeChannel();
    const run = await runSingleCardProgress(channel, "chat", "source", async () => {}, { throttleMs: 0 });
    await replaceCardWithRetry(channel, run.messageId!, finalMarkdownCard(""));
    expect(channel.sends).toHaveLength(1);
    expect(text(channel.updates.at(-1)!.card)).toBe("（无文本回复）");
  });

  test("shutdown/queued failure replaces the same card", async () => {
    const channel = new FakeChannel();
    const run = await runSingleCardProgress(channel, "chat", "source", async () => {}, { throttleMs: 0 });
    await replaceCardWithRetry(channel, run.messageId!, failureCard("机器人正在重启"));
    expect(channel.sends).toHaveLength(1);
    expect(channel.updates.at(-1)!.id).toBe("progress-1");
    expect(text(channel.updates.at(-1)!.card)).toContain("机器人正在重启");
  });

  test("producer failure retains id for same-card failure replacement", async () => {
    const channel = new FakeChannel();
    const run = await runSingleCardProgress(channel, "chat", "source", async () => {
      throw new Error("model failed");
    }, { throttleMs: 0 });
    expect(run.producerError).toBeInstanceOf(Error);
    await replaceCardWithRetry(channel, run.messageId!, failureCard("model failed"));
    expect(channel.sends).toHaveLength(1);
    expect(channel.updates.at(-1)!.id).toBe("progress-1");
    expect(text(channel.updates.at(-1)!.card)).toContain("model failed");
  });

  test("creation failure creates no bot message and exposes no fake id", async () => {
    const channel = new FakeChannel();
    channel.createError = new Error("create failed");
    const run = await runSingleCardProgress(channel, "chat", "source", async () => {});
    expect(run.messageId).toBeNull();
    expect(run.creationError).toBeInstanceOf(Error);
    expect(channel.sends).toHaveLength(0);
    expect(channel.updates).toHaveLength(0);
  });

  test("progress patch failure retains id and terminal retry never sends again", async () => {
    const channel = new FakeChannel();
    channel.updateFailures = 1;
    const run = await runSingleCardProgress(channel, "chat", "source", async (controller) => {
      await controller.append("delta");
    }, { throttleMs: 0 });
    expect(run.progressUpdateError).toBeInstanceOf(Error);
    await replaceCardWithRetry(channel, run.messageId!, failureCard("stream failed"));
    expect(channel.sends).toHaveLength(1);
    expect(channel.updates.every((u) => u.id === "progress-1")).toBe(true);
  });

  test("terminal patch failure retries same id without extra send", async () => {
    const channel = new FakeChannel();
    channel.updateFailures = 99;
    await expect(replaceCardWithRetry(channel, "progress-1", failureCard("shutdown"), 3)).rejects.toThrow();
    expect(channel.updates).toHaveLength(3);
    expect(channel.updates.every((u) => u.id === "progress-1")).toBe(true);
    expect(channel.sends).toHaveLength(0);
  });

  test("small threshold truncates progress instead of creating rollover cards", async () => {
    const channel = new FakeChannel();
    const run = await runSingleCardProgress(channel, "chat", "source", async (controller) => {
      await controller.append("x".repeat(200));
    }, { throttleMs: 0, maxChars: 80 });
    await replaceCardWithRetry(channel, run.messageId!, finalMarkdownCard("y".repeat(200), 80));
    expect(channel.sends).toHaveLength(1);
    expect(channel.updates.every((u) => u.id === "progress-1")).toBe(true);
    expect(channel.updates.at(-1)!.card.body.elements).toHaveLength(3);
    expect(channel.updates.at(-1)!.card.body.elements.every((e: any) => e.content.length <= 80)).toBe(true);
  });
});
