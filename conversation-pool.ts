export function createGenerationIsCurrent(shuttingDown: boolean, expected: number, current: number): boolean {
  return !shuttingDown && expected === current;
}

export class SerialCapacityGate {
  private tail = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}

export interface EvictableConversation {
  active: unknown | null;
  lastUsedAt: number;
  queuedTurnCount: number;
  session: { isSafeToEvict(): boolean };
}

export function selectSafeIdleVictim<T extends EvictableConversation>(
  entries: Iterable<T>, now: number, idleMs: number, forceForCapacity = false,
): T | undefined {
  return [...entries]
    .filter((item) => item.queuedTurnCount === 0 && item.active === null && item.session.isSafeToEvict() && (forceForCapacity || now - item.lastUsedAt >= idleMs))
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
}
