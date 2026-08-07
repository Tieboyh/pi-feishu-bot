export interface DisposableSession {
  sessionFile: string;
  dispose(): Promise<void>;
}

export async function initializeConversationOwned<TSession extends DisposableSession, TConversation>(options: {
  session: TSession;
  secureSessionFile(file: string): Promise<void>;
  registerCeiling(file: string): { dispose(): void };
  create(ceiling: { dispose(): void }): TConversation;
  subscribe(conversation: TConversation): () => void;
  setUnsubscribe(conversation: TConversation, unsubscribe: () => void): void;
  commit(file: string): Promise<void>;
  publish(conversation: TConversation): void;
}): Promise<TConversation> {
  let ceiling: { dispose(): void } | undefined;
  let unsubscribe: (() => void) | undefined;
  let published = false;
  try {
    if (!options.session.sessionFile) throw new Error("Persistent session file is unavailable.");
    await options.secureSessionFile(options.session.sessionFile);
    ceiling = options.registerCeiling(options.session.sessionFile);
    const conversation = options.create(ceiling);
    unsubscribe = options.subscribe(conversation);
    options.setUnsubscribe(conversation, unsubscribe);
    await options.commit(options.session.sessionFile);
    options.publish(conversation);
    published = true;
    return conversation;
  } finally {
    if (!published) {
      unsubscribe?.();
      ceiling?.dispose();
      await options.session.dispose();
    }
  }
}
