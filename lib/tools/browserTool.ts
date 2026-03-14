import type { Browser, Page } from "playwright";
import { chromium } from "playwright";
import { z } from "zod";

import type { JsonValue, RiskLevel } from "@/lib/agent/types";

export const browserToolSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("openPage"),
    url: z.string().url(),
  }),
  z.object({
    action: z.literal("extractTitle"),
  }),
  z.object({
    action: z.literal("extractVisibleText"),
  }),
  z.object({
    action: z.literal("click"),
    selector: z.string().min(1),
  }),
  z.object({
    action: z.literal("type"),
    selector: z.string().min(1),
    text: z.string(),
  }),
]);

export type BrowserToolArgs = z.infer<typeof browserToolSchema>;

type BrowserState = {
  browser: Browser | null;
  page: Page | null;
};

declare global {
  var __hunterClawBrowserState__: BrowserState | undefined;
}

const browserState: BrowserState = globalThis.__hunterClawBrowserState__ ?? {
  browser: null,
  page: null,
};

if (process.env.NODE_ENV !== "production") {
  globalThis.__hunterClawBrowserState__ = browserState;
}

async function getPage() {
  try {
    if (!browserState.browser) {
      browserState.browser = await chromium.launch({ headless: true });
    }
  } catch (error) {
    throw new Error(
      `Failed to launch Playwright Chromium. Run 'npm run playwright:install' first. ${error instanceof Error ? error.message : ""}`.trim(),
    );
  }

  if (!browserState.page || browserState.page.isClosed()) {
    browserState.page = await browserState.browser.newPage();
  }

  return browserState.page;
}

function requireOpenPage(page: Page | null) {
  if (!page || page.isClosed()) {
    throw new Error("No page is open. Open a URL first.");
  }

  return page;
}

export const browserTool = {
  name: "browserTool",
  description: "Open and inspect a web page with Playwright.",
  schema: browserToolSchema,
  getRiskLevel(args: BrowserToolArgs): RiskLevel {
    if (args.action === "click" || args.action === "type") {
      return "medium";
    }

    return "low";
  },
  async execute(args: BrowserToolArgs): Promise<JsonValue> {
    if (args.action === "openPage") {
      const page = await getPage();
      await page.goto(args.url, { waitUntil: "domcontentloaded" });

      return {
        action: "openPage",
        url: page.url(),
        title: await page.title(),
      };
    }

    const page = requireOpenPage(await getPage());

    if (args.action === "extractTitle") {
      return {
        action: "extractTitle",
        title: await page.title(),
      };
    }

    if (args.action === "extractVisibleText") {
      const rawText = await page.evaluate(() => document.body?.innerText ?? "");
      const normalized = rawText.replace(/\n{3,}/g, "\n\n").trim();
      const maxLength = 4_000;

      return {
        action: "extractVisibleText",
        text: normalized.slice(0, maxLength),
        truncated: normalized.length > maxLength,
        length: normalized.length,
      };
    }

    if (args.action === "click") {
      await page.locator(args.selector).click();

      return {
        action: "click",
        selector: args.selector,
        url: page.url(),
      };
    }

    await page.locator(args.selector).fill(args.text);

    return {
      action: "type",
      selector: args.selector,
      textLength: args.text.length,
      url: page.url(),
    };
  },
};

