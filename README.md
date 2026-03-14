# HunterClaw

HunterClaw is a local-first MVP for a personal coding agent inspired by OpenClaw-style workflows, but intentionally much smaller and simpler.

The app runs entirely on your machine for the MVP:
- Next.js web chat UI
- deterministic local provider with no paid API dependency
- SQLite-backed memory and tool logs
- approval flow for medium/high-risk actions
- local tools for files, shell, and browser automation

## Stack

- Next.js App Router
- TypeScript
- Tailwind CSS
- SQLite
- Drizzle ORM
- Zod
- Playwright

## What works

- chat UI with inline messages, tool activity, and approval cards
- `POST /api/chat`, `POST /api/approve`, `GET /api/history`
- SQLite persistence for messages, summaries, preferences, tool executions, and approvals
- rolling summary memory for older messages
- file tool restricted to `data/workspace`
- safe shell tool with allowlist and blocked dangerous commands
- Playwright-backed browser tool with approval for `click` and `type`
- provider abstraction with a working `localProvider` and stubbed `codexProvider`

## Project structure

```text
app/
  api/chat
  api/approve
  api/history
  page.tsx

components/chat/

lib/
  agent/
  db/
  llm/
  tools/

data/workspace/
scripts/
```

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create the SQLite database and seed the local workspace:

   ```bash
   npm run db:setup
   ```

3. Install Playwright Chromium for the browser tool:

   ```bash
   npm run playwright:install
   ```

4. Start the app:

   ```bash
   npm run dev
   ```

5. Open the local URL printed by Next.js, usually [http://localhost:3000](http://localhost:3000).

## Scripts

- `npm run dev` - start the local dev server
- `npm run build` - create a production build
- `npm run start` - run the production server after build
- `npm run typecheck` - run TypeScript checks
- `npm run db:setup` - create SQLite tables and seed `data/workspace/welcome.txt`
- `npm run playwright:install` - install Chromium for Playwright

## Supported command patterns

The local provider is deterministic, so it expects fairly direct commands.

- `list files`
- `list directory src`
- `read file welcome.txt`
- `write file notes.txt with content hello`
- `write file notes.txt`
  then put the file contents on the following lines
- `run pwd`
- `run rg HunterClaw`
- `open https://example.com`
- `extract title`
- `extract visible text`
- `click a`
- `type input[name="q"] with hello`

## Safety model

- low-risk actions auto-run
- medium/high-risk actions pause for approval
- file writes require approval by default
- browser `click` and `type` require approval
- dangerous shell commands are blocked instead of queued for approval
- all file access stays inside `data/workspace`
- all shell commands run with `data/workspace` as the cwd

Optional override:
- set `AUTO_APPROVE_FILE_WRITES=true` in your environment to skip approvals for file writes

## Persistence

- SQLite database: `data/agent.db`
- local workspace: `data/workspace`
- the DB file is ignored by git

## Provider status

### Working now

- `lib/llm/localProvider.ts`
  - deterministic intent parsing
  - direct replies for unsupported input
  - tool call routing for file, shell, and browser actions
  - deterministic summary generation

### Stubbed for later

- `lib/llm/codexProvider.ts`
  - same provider interface as the working local provider
  - intentionally throws a clear not-implemented error today
  - includes TODOs for Codex/ChatGPT-auth-backed integration later

## Next steps for Codex auth/provider integration

1. Add a real authenticated session/client layer for Codex or ChatGPT-backed workflows.
2. Map provider tool-planning output into the existing `ProviderDecision` format.
3. Reuse the current approval layer and tool registry rather than rebuilding them.
4. Add a provider selector in config or the UI so `localProvider` stays the fallback.
5. Replace deterministic summarization with model-backed summarization once auth is wired.

## Notes

- This MVP uses a single conversation id: `default`.
- There is no user auth system, multi-agent orchestration, or cloud dependency.
- The browser session is process-local and ephemeral.
- The local provider is intentionally narrow so the system stays easy to debug and extend.

