export const HELP_TEXT = [
  "I am running in local-only MVP mode.",
  "",
  "Supported commands:",
  "- list files",
  "- list directory <path>",
  "- read file <path>",
  "- write file <path> with content <text>",
  "- write file <path> then put the content on the next line",
  "- run <safe shell command>",
  "- open <https://url>",
  "- extract title",
  "- extract visible text",
  "- click <selector> (approval required)",
  "- type <selector> with <text> (approval required)",
  "",
  "All file and shell access stays inside data/workspace.",
];

export const FALLBACK_TEXT = [
  "I did not match that request to a supported local MVP action.",
  "",
  "Try a direct command such as:",
  "- list files",
  "- read file welcome.txt",
  "- write file notes.txt with content hello",
  "- run pwd",
  "- open https://example.com",
].join("\n");

