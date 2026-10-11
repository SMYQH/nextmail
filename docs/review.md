# Review Findings

Newest findings appear first. Each row records only the issue and current disposition.

| ID | Issue | Status / resolution |
| --- | --- | --- |
| 66 | The creation dialog's address copy control is inaccessible to keyboard users. | Resolved locally: a labeled button copies the normalized address with Enter and Space. |
| 65 | Duplicate mailbox creation displays Chinese feedback on English pages. | Resolved locally: duplicate-address feedback passes browser checks in both locales. |
| 64 | Copy notifications use Chinese text in both locales. | Resolved locally: shared copy notifications use translations verified in both locales. |
| 63 | Shared mailbox message rows cannot be opened with a keyboard. | Resolved locally: native buttons support Enter, Space, and visible keyboard focus. |
| 62 | Shared mailbox polling resets the selected message format. | Resolved locally: text format survives polling in browser checks. |
| 61 | Refreshing a paginated mailbox list duplicates previously loaded pages. | Resolved locally: refresh preserves pagination; browser checks retain 60 unique mailboxes. |
| 60 | Mailbox creation accepts malformed or untrimmed names. | Resolved locally: names are validated and normalized consistently; blank names still generate random addresses. |
| 59 | Default-role initialization can overwrite a concurrent administrator assignment. | Resolved locally: conditional initialization preserves administrator assignments in sign-in and session regression tests. |
| 58 | Tailwind 4 migration shifts animated dialogs and interrupts switch motion. | Resolved locally: dialog positioning and switch transitions pass focused browser checks. |
| 57 | Shared-page dates can differ between server and browser, causing hydration errors. | Resolved locally: shared mailbox and message pages hydrate consistently before displaying viewer-local dates. |
| 56 | Migration 0007 discards existing password credentials. | Resolved locally for pending upgrades; previously deleted credentials cannot be recovered. Remote migration state is unverified. |
| 55 | Deployment can migrate D1 before the candidate Worker builds successfully. | Resolved locally: build and packaging validation precede migration. Deployment remains non-atomic. |
| 54 | Subdomain email deployment changes the parent zone's apex catch-all. | Resolved locally: domains matching only a parent Zone are rejected before database changes or publishing. |
| 53 | Emperor claim URL returned 405; no claim UI existed. | Resolved locally: added a localized, confirmed claim flow. Not deployed. |
| 52 | HTTP Worker preview selected the wrong session cookie. | Resolved locally. |
| 51 | Deployment credentials entered the Worker from application environment files. | Resolved locally for documented build and deploy commands. |
| 50 | Checked-in screenshots contain personal data. | Accepted by user: screenshots remain unchanged. |
| 49 | Deployment example used a Pages hostname for custom and email domains. | Resolved. |
| 48 | Fresh installs advertised an unrouted fallback mail domain. | Resolved locally; remote mail delivery remains unverified. |
| 47 | Database failures can expose sensitive values in logs. | Resolved locally: application, Auth.js, and identity errors use safe metadata. |
| 46 | Inbound database write failures can silently drop messages. | Resolved locally: storage failures explicitly reject mail; no automatic retry is promised. Saved mail survives Webhook failures. |
| 45 | Catch-all deployment required unnecessary Email Routing Settings access. | Resolved. |
| 44 | OAuth controls appeared without configured credentials. | Resolved. |
| 43 | Shared-message API exposed content after mailbox expiry. | Resolved. |
| 42 | Refresh focus ring and switch geometry were incorrect. | Resolved. |
| 41 | Homepage clipped short screens and disabled browser zoom. | Resolved. |
| 40 | Toast close control was hidden on touch and lacked an accessible name. | Resolved. |
| 39 | Custom checkbox did not support keyboard activation. | Resolved. |
| 38 | Theme toggle ignored the resolved system theme on first press. | Resolved. |
| 37 | Shared motion ignored reduced-motion settings and animated keyboard navigation. | Resolved. |
| 36 | Brand and installation icons kept the old pixel design. | Resolved. |
| 35 | Mobile Send Email tooltip was clipped. | Resolved. |
| 34 | Message deletion dialog showed mailbox deletion text. | Resolved. |
| 33 | Webhook SSRF needs further hardening. | Deferred (user-requested): Webhooks are not currently used. |
| 32 | Dialogs clipped controls on short screens. | Resolved. |
| 31 | Email actions were inaccessible or difficult to find. | Resolved. |
| 30 | Long addresses hid mobile email controls. | Resolved. |
| 29 | HTML-only emails could appear blank. | Resolved. |
| 28 | Stale requests could display the wrong message. | Resolved locally: mailbox lists and shared-message requests ignore superseded responses. |
| 27 | Configuration failures could trigger an infinite retry loop. | Resolved. |
| 26 | Received email content can appear in error logs. | Resolved locally: inbound error logs omit email content and SQL parameters. |
| 25 | Deployment lookup treated the database name as its ID. | Resolved. |
| 24 | Turnstile prevented automatic login after registration. | Resolved. |
| 23 | Abuse controls were missing. | Partially resolved: tests were added; abuse controls remain deferred by user. |
| 22 | Timestamp and recipient data were incorrect. | Resolved. |
| 21 | UI permission condition was incorrect. | Resolved. |
| 20 | Cleanup throughput was limited to 100 emails per hour. | Resolved. |
| 19 | Untrusted email HTML was rendered without sanitization. | Resolved. |
| 18 | API keys are stored in plaintext. | Open; user requested keeping this for development convenience. |
| 17 | PWA cache retained private responses after logout. | Resolved. |
| 16 | Concurrent case variants could create conflicting email owners. | Resolved. |
| 15 | Risky OAuth account linking was enabled. | Resolved. |
| 14 | Dependency audit failed. | Partially resolved: production audit is clean after patches and Tailwind 4 migration; five lint-tool packages retain one unpatched braces advisory. |
| 13 | GitHub Actions deployment configuration was insecure. | Resolved. |
| 12 | Deployment could report success when a Worker failed. | Resolved. |
| 11 | Deleting sent messages reset daily send usage. | Resolved. |
| 10 | Daily send limit used a check-then-act pattern. | Resolved. |
| 9 | Sent-message details bypassed authorization. | Resolved. |
| 8 | Email expiration policy was enforced inconsistently. | Resolved. |
| 7 | Webhook had an SSRF vulnerability. | Resolved. |
| 6 | Emperor initialization had a race condition. | Resolved. |
| 5 | Password hashing strength was insufficient. | Resolved. |
| 4 | Registration endpoint exposed password hashes. | Resolved. |
| 3 | Existing API keys bypassed role revocation. | Resolved. |
| 2 | Client-supplied user ID enabled identity impersonation. | Resolved. |
| 1 | Secrets were tracked in Git. | Resolved. |
