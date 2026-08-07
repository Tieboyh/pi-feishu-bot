interface RoutedMessage {
  role?: string;
  customType?: string;
  display?: boolean;
  content?: unknown;
}
interface RoutedEvent {
  type?: string;
  message?: RoutedMessage;
}

export function isUnexpectedAutonomousStart(event: { type?: string }, hasActiveTurn: boolean): boolean {
  return event.type === "agent_start" && !hasActiveTurn;
}

export function visibleSubagentCustomText(event: RoutedEvent): string | undefined {
  if (event.type !== "message_end") return undefined;
  const message = event.message;
  if (message?.role !== "custom" || !["subagent-slash-result", "subagent-slash-text-result"].includes(message.customType ?? "") || message.display === false) return undefined;
  if (typeof message.content !== "string" || !message.content.trim() || message.content.includes("Running subagent")) return undefined;
  return message.content.trim();
}
