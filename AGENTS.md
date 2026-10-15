## Workflow

- Start with `git status --short`. Review relevant diffs. Preserve user changes; edit only requested files.
- Find files with `rg --files` and symbols/callers with `rg -n`. Read nearby code and applicable `AGENTS.md` files.
- Trace affected UI, API handlers, shared logic, and tests. Reuse helpers and UI primitives before adding abstractions or dependencies.
- Make reversible choices within the authorized scope. Ask only when missing details materially affect behavior or scope.
- Before handoff, run `git diff --check`; inspect final diff and `git status --short`. Report behavior changes, validation, and blockers. Exclude unrelated files and generated artifacts.

## Communication and Documentation

- Communicate with users **in English**, even for Chinese requests.
- Write `docs/*.md` in Chinese, except `docs/review.md` in English. Maintain English and Simplified Chinese UI translations in `./app/i18n/messages`.
- Use relative document paths (for example, `./package.json`).
- Write commit subjects and PR titles/descriptions in Chinese, with conventional prefixes (for example, `fix: 修复邮箱权限检查`).
- Read `docs/develop.md` for development, `docs/deploy.md` for deployment, and `docs/usage.md` for product behavior. Verify commands in `package.json` and CI in `.github/workflows/deploy.yml`.

### Review ledger: `docs/review.md`

- Read before bug reviews or fixes. Respect recorded user decisions and deferred items. Never restore removed content, weaken/remove user annotations, or claim unverified fixes.
- Keep this English file the **only authoritative ledger**: one table, one row per finding, IDs descending (newest first). Assign increasing IDs; never renumber or reuse them.
- Each row contains only a brief issue and current status/resolution. Omit code, reproduction steps, causes, implementation details, commands, logs, and separate history. Keep decisions, deferrals, and verification limits in short notes.
- Allowed statuses: `Open`, `Deferred (user-requested)`, `Partially resolved`, `Resolved locally`, `Resolved`, `Accepted by user`.
- Use `Partially resolved` for incomplete fixes. `Accepted by user` is a decision, not a fix. `Resolved locally` does not establish remote verification or deployment.
- Update existing rows when status changes. Keep one current note per finding. Never add duplicate tables, dated update logs, or release-status summaries.

## Library Documentation

Use **Context7 MCP** for questions about libraries, frameworks, SDKs, APIs, CLIs, or cloud services: syntax, configuration, migrations, setup, and library-specific debugging. Skip it for repository inventory, code review, business-logic debugging, general programming concepts, and refactoring without library-documentation needs.

1. Call `resolve-library-id` with library name and question, unless given an exact `/org/project` ID.
2. Select by name, description, source reputation, snippet coverage, and benchmark score. Prefer a version-specific ID when relevant; retry ambiguous matches.
3. Call `query-docs` with one focused question per distinct concept. Combine questions only when their interaction matters.
4. Ground library guidance in retrieved docs. If Context7 is unavailable, disclose that and use official documentation.

## Project Structure

NextMail: Next.js 15 App Router, React 19, TypeScript, OpenNext on Cloudflare Workers, D1, KV, and separate email/cleanup Workers.

- `app/[locale]/`: localized home, login, mailbox, profile, shared-message pages.
- `app/api/`: route handlers. `app/lib/`: auth, permissions, DB schema/access, validation, shared logic.
- `app/components/`: features and shared Radix-based `ui/` primitives. `app/hooks/`: reusable hooks.
- `app/i18n/`: locale and request setup. `app/i18n/messages/{en,zh-CN}/`: translations.
- `app/config/`, `app/types/`: config and types. `app/globals.css`: shared styling and motion.
- `workers/email-receiver.ts`, `workers/cleanup.ts`: inbound email and scheduled cleanup.
- `drizzle/`: SQL migrations. `scripts/`: migration, deployment, fixture, webhook, icon tools.
- `tests/`: Node unit/route tests. `tests/helpers/database.ts`: in-memory SQLite/D1 adapter.
- `public/`: assets, icons, service worker. `docs/`: project documentation.

## Setup and Commands

- Use **Node.js 24+** and npm. Run `npm ci` for a clean lockfile-based install; `npm install` only for intentional dependency changes.
- Copy `.env.deploy.example` to ignored `.env.deploy`. Configure `.env.deploy` and the **three tracked Wrangler JSON files** per `docs/deploy.md`. Apply local migrations as needed.

| Command                       | Action                                                       |
| ----------------------------- | ------------------------------------------------------------ |
| `npm run dev`                 | Next.js development server                                   |
| `npm run lint`                | Next.js ESLint checks                                        |
| `npx tsc --noEmit`            | TypeScript check                                             |
| `npm test`                    | `tests/*.test.ts` via Node test runner, `tsx`, experimental module mocks |
| `npm run build`               | Production Next.js build                                     |
| `npm run build:worker`        | Build OpenNext; validate Worker artifact and bindings        |
| `npm run preview:worker`      | Build and preview in local Workers runtime                   |
| `npm run db:migrate-local`    | Local D1 migrations                                          |
| `npm run dev:cleanup`         | Cleanup Worker with scheduled testing enabled                |
| `npm run test:cleanup`        | Invoke local scheduled endpoint; cleanup Worker must be running |
| `npm run webhook-test-server` | Local webhook receiver                                       |
| `npm run generate-test-data`  | Fixture Worker; invocation URL in `docs/develop.md`          |
| `npm run generate:icons`      | Regenerate app icons                                         |
| `npm run delete`              | Delete this project's named Cloudflare resources; D1 data is removed |

- Remote commands: `npm run db:migrate-remote`, `npm run deploy`, `npm run deploy:worker`, `npm run deploy:email`, `npm run deploy:cleanup`, `npm run delete`. Run **only within authorized deployment scope**. `npm run delete` removes project-named Cloudflare resources and D1 data, but does not modify GitHub. Inspect migrations before remote application.
- On Windows, prefer `pwsh`, fallback `powershell`. Use UTF-8 `.ps1` or `.py` files for long/quoting-sensitive scripts.
- OpenNext Worker builds are not fully supported on Windows. Use Linux/WSL/CI; distinguish environment limits from application failures.
- For bracketed PowerShell paths such as `app/[locale]/`, use `-LiteralPath` with file cmdlets.

## Implementation

- Follow existing TypeScript conventions: two-space indentation, mostly no semicolons, surrounding quote style. `@/*` maps to `app/*`.
- PascalCase for components/types; `use-*.ts` for hooks; `page.tsx`, `layout.tsx`, `route.ts` for Next.js routes.
- Put user-facing text in `next-intl`; update English and Simplified Chinese. Reuse UI primitives and existing design.
- Preserve keyboard access, visible focus, responsive layouts, and reduced-motion behavior when editing controls or animations.

## Validation and PRs

- For code changes, run lint, TypeScript, relevant tests, and production build. Include OpenNext Worker build checks for deployment/runtime changes.
- Node tests use local fixtures, need no external services, and **do not prove production Cloudflare compatibility**.
- Run focused suites from repo root during development, for example:

```sh
node --import tsx --experimental-test-module-mocks --test tests/routes.test.ts tests/cleanup.test.ts
```

- For DB tests, reuse `tests/helpers/database.ts`; use existing external-service mocks. Assert visible behavior and side effects, including persisted data and external call counts. Restore mocks and close test DBs. See `docs/develop.md` for coverage and concurrency limits.
- Add focused regression tests or reproducible manual steps, especially for auth, permissions, API routes, DB operations, and Workers.
- **No automated browser suite is configured**. Check affected UI in both locales, themes, mobile/short viewports, and keyboard/reduced-motion modes as relevant.
- For UI edits, open affected pages, capture and inspect screenshots after transitions settle, and include screenshots in handoff. Build success or a running browser alone does not verify UI.
- For docs-only edits, verify paths, commands, and diff; application builds are unnecessary.
- Report exact validation commands, failures, and skipped checks. PRs must cover behavior, migrations/environment changes, relevant issues, and UI screenshots where applicable. Exclude generated build/test artifacts and unrelated edits.

## Configuration and Security

- Keep `.env` and other local environment files ignored. Commit only credential-free `.env.deploy.example`.
- Local deploy reads `.env.deploy` and app `.env`. Keep deployment credentials **only** in `.env.deploy` or process environment, never app `.env*` files.
- When `REPOSITORY_URL` and `GITHUB_TOKEN` are set, local deployment syncs settings to GitHub Actions repository secrets. CI uses those secrets; **no `.env` fallback**.
- Never expose credentials in output, logs, screenshots, or PR text. Do not add unrelated secrets.
- Keep Wrangler JSON tracked. Keep `.dev.vars` ignored; `.dev.vars.example` is the template.
- Earlier repository history included `.env`. Rotate old credentials; never restore old refs when publishing the repository.

Cloudflare deploy API token: scope permissions to the **NextMail Cloudflare account**.

- Required: `D1: Edit`, `Workers KV Storage: Edit`, `Workers Scripts: Edit`.
- If `CUSTOM_DOMAIN` is set: `Workers Routes: Edit`, scoped to that domain's zone.
- Email routing: `Zone: Read`, `Email Routing Rules: Edit`, scoped to the `EMAIL_DOMAIN` zone.
- Not required: `Cloudflare Pages: Edit`, `Zone Settings: Read/Edit`, `DNS: Edit`, `API Tokens: Edit`, `Email Routing Addresses: Edit`.
- Chinese deployment instructions: `docs/deploy.md`.

## Subagents and Tool Cost

- **Use subagents when many files are involved**, including repository exploration or large scoped changes, to control cost.

- **Not use subagents when reviewing source code**(this excludes low-intelligence automation tasks such as running tests or performing browser operations).

- Give subagents **requirements only**. Do not restate environment or send brief/full change details.

- When a tool/command produces high token cost and much irrelevant output, record it here. Next time, use a subagent to run it and ask  subagent for responsing with condense results .

  **Tool:** `exec_command`

  **Command:** `cat docs/review.md docs/develop.md docs/deploy.md docs/usage.md package.json .github/workflows/deploy.yml` — large combined output; delegate documentation inventory and request a concise summary, then read relevant sections directly.

- Codex: **Only GPT 6 Luna** may serve as a subagent. **Effort: Always max.**
