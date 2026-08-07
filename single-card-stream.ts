import { INITIAL_PROGRESS, progressCard, progressMarkdown } from "./stream-card.ts";

export interface SingleCardChannel {
  send(to: string, input: { card: object }, options?: { replyTo?: string }): Promise<{ messageId: string }>;
  updateCard(messageId: string, card: object): Promise<void>;
}

export interface ProgressController {
  append(chunk: string): Promise<void>;
  readonly messageId: string;
}

export interface ProgressRunResult {
  messageId: string | null;
  creationError?: unknown;
  producerError?: unknown;
  progressUpdateError?: unknown;
}

export async function replaceCardWithRetry(
  channel: Pick<SingleCardChannel, "updateCard">,
  messageId: string,
  terminalCard: object,
  attempts = 3,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await channel.updateCard(messageId, terminalCard);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** A controlled one-message stream: unlike SDK markdown stream, the message id
 * is retained when the producer or a PATCH fails, and content never rolls over. */
export async function runSingleCardProgress(
  channel: SingleCardChannel,
  to: string,
  replyTo: string,
  producer: (controller: ProgressController) => Promise<void>,
  options: { throttleMs?: number; maxChars?: number } = {},
): Promise<ProgressRunResult> {
  const throttleMs = options.throttleMs ?? 800;
  const maxChars = options.maxChars;
  let messageId: string;
  try {
    ({ messageId } = await channel.send(to, { card: progressCard(INITIAL_PROGRESS, maxChars) }, { replyTo }));
  } catch (creationError) {
    return { messageId: null, creationError };
  }

  let content = INITIAL_PROGRESS;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let updateTail = Promise.resolve();
  let progressUpdateError: unknown;

  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!dirty || progressUpdateError) return;
    dirty = false;
    const snapshot = progressMarkdown(content, maxChars);
    const operation = updateTail.then(() => channel.updateCard(messageId, progressCard(snapshot, maxChars)));
    updateTail = operation.catch(() => {});
    try {
      await operation;
    } catch (error) {
      progressUpdateError = error;
    }
  };

  const schedule = () => {
    if (timer || progressUpdateError) return;
    timer = setTimeout(() => void flush(), throttleMs);
  };

  let producerError: unknown;
  try {
    await producer({
      messageId,
      async append(chunk) {
        if (!chunk) return;
        content += chunk;
        dirty = true;
        if (throttleMs === 0) await flush();
        else schedule();
      },
    });
  } catch (error) {
    producerError = error;
  } finally {
    await flush();
    await updateTail;
  }

  return {
    messageId,
    ...(producerError ? { producerError } : {}),
    ...(progressUpdateError ? { progressUpdateError } : {}),
  };
}
