export const NEW_CHAT_TITLE = "New chat";

const MAX_TITLE_LENGTH = 56;

export function deriveConversationTitle(content: string) {
  const normalized = content.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return NEW_CHAT_TITLE;
  }

  if (normalized.length <= MAX_TITLE_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_TITLE_LENGTH - 3).trimEnd()}...`;
}
