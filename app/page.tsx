import { Suspense } from "react";

import { ChatApp } from "@/components/chat/chat-app";

export default function HomePage() {
  return (
    <Suspense fallback={null}>
      <ChatApp />
    </Suspense>
  );
}
