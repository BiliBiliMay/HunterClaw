import type { Metadata } from "next";
import Script from "next/script";

import "./globals.css";

const themeBootstrapScript = `
(() => {
  const storageKey = "hc-theme";

  try {
    const savedTheme = window.localStorage.getItem(storageKey);
    const resolvedTheme = savedTheme === "dark" || savedTheme === "light"
      ? savedTheme
      : window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";

    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
  } catch {
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.colorScheme = "light";
  }
})();
`;

export const metadata: Metadata = {
  title: "HunterClaw",
  description: "Local-first personal coding agent MVP",
  icons: {
    icon: "/icon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html data-theme="light" lang="en" suppressHydrationWarning>
      <body>
        <Script id="hc-theme-init" strategy="beforeInteractive">
          {themeBootstrapScript}
        </Script>
        {children}
      </body>
    </html>
  );
}
