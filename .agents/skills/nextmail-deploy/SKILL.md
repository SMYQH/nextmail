---
name: nextmail-deploy
description: Use when preparing or executing a deployment of this repository to Cloudflare Workers through the local deploy script or GitHub Actions; not for general Cloudflare development.
---

# NextMail deployment

Use this skill only from the NextMail repository root. Start with `git status --short`, then read `docs/deploy.md`, `docs/develop.md`, `.github/workflows/deploy.yml`, `.env.deploy.example`, and the deploy scripts named by those docs. Treat the repository docs and current scripts as authoritative; deployment behavior can change.

## Authorization and scope

- A clear request to deploy the configured target authorizes the documented deployment stages and their required diagnostics. Reuse that authorization throughout the session; do not ask again before normal preflight or deployment steps. A request to inspect or prepare deployment is not authorization to publish. Resolve only material ambiguity about target, revision, or required configuration.
- Explain that `npm run deploy` can create or migrate remote D1 data, deploy the application, Email, and Cleanup Workers, change Worker routes and the `EMAIL_DOMAIN` Catch All, update local Wrangler resource IDs, and, when configured, write Actions repository Secrets. These stages are not atomic. This summary does not require a second approval for a deployment the user already requested.
- For a requested deployment check, perform necessary deployment diagnostics and read-only public GET smoke checks without asking again. A request to deploy through Actions authorizes its workflow dispatch. Do not create or push a new tag unless requested.
- Deployment authorization never authorizes resource cleanup or sending email or other messages. Do not run the cleanup command or send messages as part of deployment.
- Preserve existing work. Check `git status --short` and use the revision the user asked to deploy. Ask only if it is genuinely unclear which local changes or revision they intend.

## Credentials and target

- Use `.env.deploy.example` to prepare the ignored `.env.deploy`. Put the least-privilege Cloudflare deployment token in `CLOUDFLARE_API_TOKEN`; never put it in `.env`, `.env.local`, other application `.env*` files, source, command arguments, logs, or chat because the Worker build can bundle application environment files. Do not print secret values while checking configuration; report missing or invalid variable names only.
- The deployment preflight checks user tokens with `GET /user/tokens/verify`. If that rejects the token, it tries the account-token endpoint `GET /accounts/{account_id}/tokens/verify`. The token must be active and currently valid; these endpoints report token status, while the following read-only resource checks verify account and Zone access.
- When creating an account deployment token, use a separate bootstrap token with `Account API Tokens: Edit`. Retrieve permission group IDs from `GET /accounts/{account_id}/tokens/permission_groups`; match the returned names and scopes instead of guessing IDs. Keep the bootstrap token outside the repository and `.env.deploy`. Set `CLOUDFLARE_API_TOKEN` in `.env.deploy` to the generated deployment token, never the bootstrap token; do not grant the deployment token `Account API Tokens: Edit` or other token-management permissions.
- Scope the Cloudflare API Token to the NextMail account and required Zone. The documented minimum is account `D1: Edit`, `Workers KV Storage: Edit`, and `Workers Scripts: Edit`; Zone `Zone: Read` and `Email Routing Rules: Edit`; add Zone `Workers Routes: Edit` only when a custom domain or configured Worker route needs it. Do not request unrelated permissions.
- If `REPOSITORY_URL` and `GITHUB_TOKEN` are configured, local deployment syncs Actions repository Secrets. Use a fine-grained personal access token limited to the destination repository and its Secrets read/write permission. For Actions, check whether production Environment Secrets override repository values.
- Verify that the account, `EMAIL_DOMAIN`, optional `CUSTOM_DOMAIN`, and any explicit D1/KV IDs point to the intended deployment. `EMAIL_DOMAIN` must match the Cloudflare Zone name exactly. Check that the required domain and email routing configuration belong to that account.

## Validate before release

- Build OpenNext on Linux or WSL with Node.js 24+ and a clean `npm ci`; do not reuse Windows `node_modules` for the Worker build.
- For a release, follow the repository validation sequence: `npm run lint`, `npx tsc --noEmit`, `npm test`, and `npm run build:worker`. GitHub Actions runs these checks before `npm run deploy`. The deploy script also performs Cloudflare read-only preflight checks and a Worker build/package dry run before its remote writes; passing preflight does not guarantee later write permissions.
- Read the migration cautions in `docs/deploy.md` before changing a production schema. A recorded successful application of `0007_careless_sentinel` is normal and is not by itself a reason to stop. If there is evidence that legacy credentials were lost or expected accounts were not migrated, pause and establish the recovery plan before publishing.
- Stop before remote writes if validation fails, the token/resource checks fail, the email domain resolves to a different Zone, an enabled Webhook would be blocked, or the configured target does not match the user's authorization. Diagnose the specific issue; do not broaden token permissions speculatively.

## Deploy and verify

- Once authorized and preconditions pass, use the repository's documented deployment path. `npm run deploy` is the full local deployment command. The GitHub Actions workflow deploys on `v*` tags or manual dispatch; do not trigger it as a convenience without authorization.
- Track each stage. If a remote migration, secret update, Worker publish, route change, or Catch All update fails after earlier stages succeeded, stop and inspect remote state before retrying. Do not blindly rerun a partially completed deployment.
- After success, check the workflow or command result and use read-only Cloudflare views/API checks to confirm the intended Worker deployments, routes, D1/KV bindings, and `EMAIL_DOMAIN` Catch All. When the user asked to deploy and check, make non-mutating GET requests to the configured public URL as a smoke check. Do not create accounts, send test email, change settings, or repair remote state without separate authorization.
- `GET /api/roles/init-emperor` changes the authenticated user's role. Keep claim regression checks in an isolated local Worker preview with fixture users. For HTTP preview, test an ordinary `authjs.session-token` cookie with no incoming `X-Forwarded-Proto`; middleware must forward the normalized protocol before the handler authenticates. An unauthenticated production GET should return 401, and HEAD must never claim ownership.
- A response with `cf-mitigated: challenge` is a Cloudflare challenge before the application. Record that limit separately from Worker errors. If useful, check the same artifact through an isolated remote preview without the custom-domain route; use only read-only requests against live bindings and stop the preview afterward. Preserve zone security settings, and do not claim that preview checks verify public-domain access or SMTP delivery.
- Report the target, completed stages, checks performed, partial failures, and any follow-up needed. Never include secret values.
