import { expect, test } from "bun:test";
import { createGenerationIsCurrent, selectSafeIdleVictim, SerialCapacityGate } from "./conversation-pool.ts";

const item = (lastUsedAt: number, safe: boolean, active: unknown | null = null, queuedTurnCount = 0) => ({
  lastUsedAt, active, queuedTurnCount, session: { isSafeToEvict: () => safe },
});

test("parallel creates are globally serialized for atomic capacity reservation", async () => {
  const gate = new SerialCapacityGate();
  let active = 0;
  let maxActive = 0;
  await Promise.all([1, 2, 3].map((value) => gate.run(async () => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--; return value;
  })));
  expect(maxActive).toBe(1);
});

test("max=1 concurrent first turns reserve before publish return so B cannot evict A", async () => {
  const gate = new SerialCapacityGate();
  const entries: any[] = [];
  const a = gate.run(async () => {
    const conversation = item(0, true, null, 1);
    entries.push(conversation);
    return conversation;
  });
  const b = gate.run(async () => selectSafeIdleVictim(entries, 1, 0, true));
  expect((await a).queuedTurnCount).toBe(1);
  expect(await b).toBeUndefined();
});

test("queued creates cancel after shutdown/generation change without spawning", async () => {
  const gate = new SerialCapacityGate();
  let release!: () => void;
  const blocker = gate.run(() => new Promise<void>((resolve) => { release = resolve; }));
  let spawns = 0;
  let shuttingDown = false;
  const queued = gate.run(async () => {
    if (!createGenerationIsCurrent(shuttingDown, 1, 2)) return false;
    spawns++; return true;
  });
  shuttingDown = true;
  await Promise.resolve();
  release(); await blocker;
  expect(await queued).toBe(false);
  expect(spawns).toBe(0);
});

test("idle LRU evicts only safely idle conversations with injectable clock", () => {
  const active = item(0, true, {});
  const background = item(0, false);
  const recent = item(950, true);
  const queued = item(0, true, null, 1);
  const oldest = item(100, true);
  expect(selectSafeIdleVictim([active, background, recent, queued, oldest], 1000, 500)).toBe(oldest);
  expect(selectSafeIdleVictim([active, background, recent], 1000, 500)).toBeUndefined();
});

test("capacity selection refuses active/background work and chooses safe LRU", () => {
  const active = item(1, true, {});
  const background = item(2, false);
  const safe = item(3, true);
  expect(selectSafeIdleVictim([active, background, safe], 10, 9999, true)).toBe(safe);
  expect(selectSafeIdleVictim([active, background], 10, 9999, true)).toBeUndefined();
});
