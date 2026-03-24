import { Suspense } from "react";

import { ChatApp } from "@/components/chat/chat-app";
import { getConfiguredRuntimeLabels } from "@/lib/llm/resolveProvider";

export default function HomePage() {
  const runtimeLabels = getConfiguredRuntimeLabels();

  return (
    <Suspense fallback={null}>
      <ChatApp {...runtimeLabels} />
    </Suspense>
  );
}
