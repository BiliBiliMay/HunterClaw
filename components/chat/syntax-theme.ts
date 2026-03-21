import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";

export type ThemeMode = "light" | "dark";

export function getSyntaxTheme(themeMode: ThemeMode) {
  return themeMode === "dark" ? oneDark : oneLight;
}
