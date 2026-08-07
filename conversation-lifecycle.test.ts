import { describe, expect, test } from "bun:test";
import { initializeConversationOwned } from "./conversation-lifecycle.ts";

for (const failure of ["secure", "ceiling", "subscribe", "commit"] as const) {
  test(`conversation initialization cleans exactly once when ${failure} fails`, async () => {
    const calls = { session: 0, ceiling: 0, unsubscribe: 0, published: 0 };
    const session = { sessionFile: "/sessions/a.jsonl", async dispose() { calls.session++; } };
    await expect(initializeConversationOwned({
      session,
      async secureSessionFile() { if (failure === "secure") throw new Error("secure"); },
      registerCeiling() {
        if (failure === "ceiling") throw new Error("ceiling");
        return { dispose() { calls.ceiling++; } };
      },
      create: () => ({ unsubscribe: () => {} }),
      subscribe() {
        if (failure === "subscribe") throw new Error("subscribe");
        return () => { calls.unsubscribe++; };
      },
      setUnsubscribe(conversation, unsubscribe) { conversation.unsubscribe = unsubscribe; },
      async commit() { if (failure === "commit") throw new Error("commit"); },
      publish() { calls.published++; },
    })).rejects.toThrow(failure);
    expect(calls.session).toBe(1);
    expect(calls.ceiling).toBe(failure === "secure" || failure === "ceiling" ? 0 : 1);
    expect(calls.unsubscribe).toBe(failure === "commit" ? 1 : 0);
    expect(calls.published).toBe(0);
  });
}

test("published conversation transfers ownership without cleanup", async () => {
  const calls = { session: 0, ceiling: 0, unsubscribe: 0, published: 0 };
  const result = await initializeConversationOwned({
    session: { sessionFile: "/sessions/a.jsonl", async dispose() { calls.session++; } },
    async secureSessionFile() {},
    registerCeiling: () => ({ dispose() { calls.ceiling++; } }),
    create: () => ({ unsubscribe: () => {} }),
    subscribe: () => () => { calls.unsubscribe++; },
    setUnsubscribe(conversation, unsubscribe) { conversation.unsubscribe = unsubscribe; },
    async commit() {},
    publish() { calls.published++; },
  });
  expect(result).toBeDefined();
  expect(calls).toEqual({ session: 0, ceiling: 0, unsubscribe: 0, published: 1 });
});
