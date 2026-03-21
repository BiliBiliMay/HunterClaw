import { Suspense } from "react";

import { ChatApp } from "@/components/chat/chat-app";
import { getConfiguredProviderName } from "@/lib/llm/resolveProvider";

export default function HomePage() {
  return (
    <Suspense fallback={null}>
      <ChatApp providerName={getConfiguredProviderName()} />
    </Suspense>
  );
}
