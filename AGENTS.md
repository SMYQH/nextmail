# Repository Guidelines

## Everyday Workflow

- Start with `git status --short` and inspect the diff for files relevant to the task. Preserve existing user changes and keep edits scoped to the request.
- Use `rg --files` to find files and `rg -n` to locate symbols and callers. Read nearby implementations and applicable `AGENTS.md` files before editing.
- Trace behavior through the affected page or component, API handler, shared logic, and tests. Reuse existing helpers and UI primitives before adding abstractions or dependencies.
- Make reasonable, reversible implementation choices and complete the authorized work. Ask for clarification when missing information materially changes the required behavior or scope.
- Before handing off, inspect `git diff --check`, the final diff, and `git status --short`. Summarize changed behavior, validation results, and any remaining blockers; leave unrelated files and generated artifacts out of the change.

## Communication and Documentation

- Always communicate with the user in English, even when the request is in Chinese.
- Write `docs/*.md` files in Chinese, except `docs/review.md`, which must be in English; keep product UI translations in both English and Simplified Chinese in `./app/i18n/messages`.
- Use relative paths, such as `./package.json`, instead of absolute paths when writing documents.
- Use Chinese for commit subjects and pull request titles/descriptions, with conventional prefixes such as `fix: 修复邮箱权限检查`.
- Read `docs/develop.md` for local development, `docs/deploy.md` for deployment, and `docs/usage.md` for product behavior. Verify commands against `package.json` and CI against `.github/workflows/deploy.yml`.
- Before reviewing or fixing bugs, read `docs/review.md` and follow its recorded user decisions and deferred items. Do not restore material removed from that document, remove or weaken user annotations, or mark unverified behavior as fixed.
- Maintain `docs/review.md` in English as the single authoritative ledger, with one table and one row per finding. Sort rows by ID descending so newest findings come first. Assign new IDs in increasing order; never renumber or reuse IDs.
- Keep each row to a brief issue description and its current status or resolution. Do not include code, reproduction steps, root-cause analysis, implementation detail, commands, test logs, or separate history sections. Preserve user decisions, deferred work, and important verification limits in short notes.
- Use these status labels consistently: `Open`, `Deferred (user-requested)`, `Partially resolved`, `Resolved locally`, `Resolved`, or `Accepted by user`. Use `Partially resolved` when only part of a finding is fixed. `Accepted by user` records a decision, not a technical fix. `Resolved locally` must not imply remote verification or deployment.
- Update the existing row when status changes. Keep one current note per finding; do not add duplicate findings tables, dated update logs, or release-status summaries.

## Current Library Documentation

Use Context7 MCP for library, framework, SDK, API, CLI, or cloud-service questions, including syntax, configuration, migrations, setup, and library-specific debugging. This is unnecessary for repository inventory, code review, business-logic debugging, general programming concepts, or refactoring that does not require library documentation.

1. Start with `resolve-library-id`, including the library name and documentation question, unless an exact `/org/project` ID was supplied.
2. Select the most relevant match using name, description, source reputation, snippet coverage, and benchmark score. Use a version-specific ID when available for a requested version; retry ambiguous searches.
3. Call `query-docs` with a focused question for each distinct concept. Combine concepts only when their interaction is the question.
4. Base library-specific guidance on fetched documentation. If Context7 is unavailable, say so and use official documentation.

## Project Structure

NextMail uses Next.js 15 App Router, React 19, TypeScript, and OpenNext on Cloudflare Workers with D1, KV, and separate email/cleanup Workers.

- `app/[locale]/`: localized home, login, mailbox, profile, and shared-message pages.
- `app/api/`: route handlers; `app/lib/`: authentication, permissions, database schema/access, validation, and other shared logic.
- `app/components/`: feature components and shared Radix-based UI primitives in `ui/`; `app/hooks/`: reusable hooks.
- `app/i18n/`: locale configuration and request setup; `app/i18n/messages/{en,zh-CN}/`: translations.
- `app/config/`, `app/types/`: configuration helpers and shared types; `app/globals.css`: shared styling and motion.
- `workers/email-receiver.ts`, `workers/cleanup.ts`: inbound email and scheduled cleanup.
- `drizzle/`: SQL migrations; `scripts/`: migration, deployment, fixture, webhook, and icon tooling.
- `tests/`: Node unit and route tests; `tests/helpers/database.ts`: in-memory SQLite/D1 test adapter.
- `public/`: static assets, icons, and service worker; `docs/`: project documentation.

## Setup and Commands

Use Node.js 24+ and npm. Run `npm ci` for a clean lockfile-based install; use `npm install` when intentionally changing dependencies. Copy `.env.example` to the ignored `.env`, configure it and the three tracked Wrangler JSON files as described in the deployment guide, then apply local migrations as needed.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Next.js development server |
| `npm run lint` | Run Next.js ESLint checks |
| `npx tsc --noEmit` | Check TypeScript |
| `npm test` | Run `tests/*.test.ts` using Node's test runner, `tsx`, and experimental module mocks |
| `npm run build` | Build the production Next.js application |
| `npm run build:worker` | Build OpenNext output and validate the Worker artifact and bindings |
| `npm run preview:worker` | Build and preview the app in the local Workers runtime |
| `npm run db:migrate-local` | Apply local D1 migrations |
| `npm run dev:cleanup` | Start the cleanup Worker with scheduled testing enabled |
| `npm run test:cleanup` | Invoke the local scheduled endpoint; requires the cleanup Worker to be running |
| `npm run webhook-test-server` | Start a local webhook receiver |
| `npm run generate-test-data` | Start the fixture Worker; see `docs/develop.md` for its invocation URL |
| `npm run generate:icons` | Regenerate application icons |

Remote actions include `npm run db:migrate-remote`, `npm run deploy`, `npm run deploy:worker`, `npm run deploy:email`, and `npm run deploy:cleanup`. Run them only within the user's authorized deployment scope; inspect migrations before applying them remotely.

On Windows, prefer `pwsh`, falling back to `powershell` if unavailable. Use UTF-8 `.ps1` or `.py` files for long or quoting-sensitive scripts. OpenNext warns that its build is not fully supported on Windows; use Linux/WSL/CI for Worker builds and report that environment limitation separately from application failures.

For PowerShell paths containing brackets, such as `app/[locale]/`, use `-LiteralPath` with file cmdlets to avoid wildcard expansion.

## Implementation Conventions

Follow existing TypeScript patterns, two-space indentation, predominantly semicolon-free formatting, and surrounding quote style. The `@/*` alias resolves to `app/*`. Use PascalCase for components/types, `use-*.ts` for hook filenames, and Next.js route conventions (`page.tsx`, `layout.tsx`, `route.ts`).

Keep user-facing strings in `next-intl` translations and update both English and Simplified Chinese. Reuse shared UI primitives and follow the existing web design. Maintain keyboard operation, visible focus, responsive layouts, and reduced-motion behavior when changing controls or animation.

## Validation and Pull Requests

For code changes, run lint, TypeScript checks, relevant tests, and a production build. Include OpenNext Worker build validation when deployment or runtime compatibility changes. Node tests use local fixtures and require no external services; they do not establish production Cloudflare compatibility.

During development, run focused suites from the repository root, for example:

```sh
node --import tsx --experimental-test-module-mocks --test tests/routes.test.ts tests/cleanup.test.ts
```

Reuse `tests/helpers/database.ts` for database-backed tests and the existing mocks for external services. Assert observable behavior and side effects, including persisted data and external call counts; restore mocks and close test databases after use. See `docs/develop.md` for suite coverage and concurrency-testing limitations.

Add focused regression tests or reproducible manual steps for changed behavior, especially authentication, permissions, API routes, database operations, and Workers. Playwright is installed but no automated browser suite is configured. Check affected UI manually in both locales, themes, mobile/short viewports, and keyboard/reduced-motion modes as applicable.

For UI changes, open the affected page, capture and inspect screenshots after transitions settle, and include relevant screenshots with the handoff. A successful build or running browser process alone does not verify appearance or interaction.

For documentation-only changes, verify paths, commands, and the diff; application builds are unnecessary. Report exact validation commands, failures, and skipped checks. Pull requests should describe behavior changes, migrations or environment changes, relevant issues, and UI screenshots when applicable. Do not include generated build/test artifacts or unrelated edits.

## Configuration Policy

Keep `.env` and other local environment files ignored. Commit only `.env.example` and `.env.deploy.example` without credentials. Local deployment reads `.env.deploy` and application `.env`; deployment credentials must stay in `.env.deploy` or process environment, never application `.env*` files; when `REPOSITORY_URL` and `GITHUB_TOKEN` are configured, it synchronizes its settings to GitHub Actions repository secrets. CI reads those secrets and has no `.env` fallback. Avoid exposing credential values in tool output, logs, screenshots, or pull request text, and do not add unrelated secrets. Wrangler JSON configuration remains tracked; `.dev.vars` stays ignored and `.dev.vars.example` is available as a template. Earlier repository history contained `.env`; rotate the old credentials and never reintroduce the old refs when making the repository public.

For the deployment API token, scope account permissions to the NextMail Cloudflare account: `D1: Edit`, `Workers KV Storage: Edit`, and `Workers Scripts: Edit`. If `CUSTOM_DOMAIN` is set, also grant `Workers Routes: Edit` and scope it to that domain's zone. Email routing needs `Zone: Read` and `Email Routing Rules: Edit` for the `EMAIL_DOMAIN` zone. The app deployment does not require `Cloudflare Pages: Edit`, `Zone Settings: Read/Edit`, `DNS: Edit`, `API Tokens: Edit`, or `Email Routing Addresses: Edit`. See `docs/deploy.md` for the Chinese deployment instructions.

## SubAgent Rule

To control costs, **you must use subagents only when a large number of files is involved**. Examples: exploring a code repository and returning the requested content as needed; making a large number of file changes with a clear objective. When instructing a subagent, **state only the requirements; do not also describe the environment or send the brief/full change details to the subagent**.
Codex: Only GPT 6 Luna may be used as a subagent.`Effort`: Always max.
