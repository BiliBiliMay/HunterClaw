import { getConfiguredProviderName } from "@/lib/llm/resolveProvider";
import { ChatApp } from "@/components/chat/chat-app";

export default function HomePage() {
  return <ChatApp providerName={getConfiguredProviderName()} />;
}
