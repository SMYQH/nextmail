# Review Findings

Newest findings appear first. Each row records only the issue and current disposition.

| ID | Issue | Status / resolution |
| --- | --- | --- |
| 112 | Deployment does not configure project-scoped WAF exceptions for OpenAPI and browser verification. | Resolved locally: scoped rules and deployment probes pass regression checks; remote behavior unverified. |
| 111 | Catch-all configuration conflates collection and visibility after disabling it. | Resolved locally: separate labels and explanations in both languages; browser checks preserve saved flags. |
| 110 | External profile avatars fail without a usable fallback. | Resolved locally: direct loading and generated fallback pass browser checks; production behavior unverified. |
| 109 | HTML message body sometimes appears blank under the All mailbox filter. | Open: not reproduced locally; production verification pending. |
| 108 | Authenticated production requests intermittently fail with Worker resource-limit errors. | Open: live verification confirms CPU-limit failures. |
| 107 | Redeployed custom hostname has no DNS records and cannot reach the Worker. | Resolved: domain and DNS verified; production UI reached through a temporary WAF exception; normal access remains challenged. |
| 106 | Configured GitHub token cannot synchronize Actions repository secrets. | Resolved: replacement token synchronized all configured Actions secrets. |
| 105 | Redeployment fails when generated Next.js route types are missing. | Resolved: production and Worker builds pass; Cloudflare redeployment completed. |
| 104 | Session revalidation discards loaded mailbox pages and scroll position. | Resolved: authenticated production browser checks retain loaded mailbox pages and scroll after session revalidation. |
| 103 | Catch-all sender checks reject renamed mailboxes and can authorize reused stale addresses. | Resolved locally: registered identities pass session and API-key regressions; live delivery unverified. |
| 102 | Concurrent first Catch-all saves replace the winning mailbox identity. | Resolved locally: overlapping saves retain one mailbox and its deliveries; remote concurrency unverified. |
| 101 | Sending setup still describes one global service switch and key. | Resolved locally: instructions match per-domain configuration. |
| 100 | Daily quota reset omits its timezone. | Resolved locally: documentation specifies UTC. |
| 99 | Webhook test instructions overstate logged message details. | Resolved locally: documentation matches subject-only logging. |
| 98 | Manual refresh documentation overstates synchronization of cached older pages. | Resolved locally: cache limits and page reload behavior are documented. |
| 97 | Deployment documentation obscures database ID override behavior. | Resolved locally: target verification and migration implications are documented. |
| 96 | Polling cursor instructions do not distinguish ordinary pagination snapshots. | Resolved locally: initialization and advancement rules match the client. |
| 95 | The task reference does not describe its adaptation scope. | Resolved locally: scope and verification limits are documented. |
| 94 | Development coverage omits new configuration and mailbox tests. | Resolved locally: coverage inventory and focused command are current. |
| 93 | Configuration inventory omits Catch-all and domain sending settings. | Resolved locally: current settings are documented. |
| 92 | Tunnel instructions rely on an undocumented package runner. | Resolved locally: instructions use the installed executable. |
| 91 | API and sharing examples use an obsolete Pages hostname. | Resolved locally: examples use a documented application-host placeholder. |
| 90 | Configuration response documentation omits domain access and Catch-all fields. | Resolved locally: response fields and privileges are documented. |
| 89 | Mailbox filtering is documented as a response field rather than a query parameter. | Resolved locally: parameter and response descriptions are corrected. |
| 88 | Mailbox creation requirements are ambiguous. | Resolved locally: expiry and domain requirements are explicit. |
| 87 | Deployment help links use missing anchors. | Resolved locally: stable anchors resolve existing help links. |
| 86 | Deployment permissions conflate website and email zones. | Resolved locally: permission scopes cover both configured zones. |
| 85 | Head refreshes advance polling past late arrivals outside the first page. | Resolved locally: late-arrival refresh and pagination browser checks pass; remote behavior unverified. |
| 84 | Delayed responses overwrite newer mailbox counts. | Resolved locally: snapshot ordering and targeted revalidation pass focused tests and browser checks. |
| 83 | Refresh retains Catch-all mailboxes after they become hidden. | Resolved locally: hidden rows disappear in both locales on desktop and mobile. |
| 82 | Stale Catch-all addresses expose registered mailboxes to destructive deletion. | Resolved locally: registered identities preserve mailboxes and messages in regression checks; remote behavior unverified. |
| 81 | Deleting a stale unread message subtracts unread counts twice. | Resolved locally: authoritative deletion counts pass browser checks in both locales on desktop and mobile. |
| 80 | Cross-session reads can subtract unread counts twice. | Resolved locally: authoritative counts pass browser checks in both locales on desktop and mobile. |
| 79 | Catch-all creation cannot recover after a configuration-store failure. | Resolved locally: retry regressions preserve the mailbox; remote behavior unverified. |
| 78 | Incremental cursors omit late commits behind delivery timestamps or IDs. | Resolved locally: late arrival, pagination, deletion, and migration checks pass; remote behavior unverified. |
| 77 | Catch-all renames can silently lose deliveries during configuration updates. | Resolved locally: concurrent delivery and save failure regressions pass; live Cloudflare delivery unverified. |
| 76 | Website configuration errors appear in the wrong language. | Resolved locally: validation and fallback messages pass browser checks in both locales. |
| 75 | Message polls double-count arrivals already included in mailbox statistics. | Resolved locally: refresh and poll ordering checks preserve exact counts. |
| 74 | Pinned Catch-all overlap can make ordinary mailbox pages unreachable. | Resolved locally: pagination regression and desktop/mobile browser checks pass. |
| 73 | Empty mailbox cursors can skip concurrent arrivals. | Resolved locally: concurrent-arrival regression checks pass. |
| 72 | Catch-all infrastructure lookup failures silently discard incoming mail. | Resolved locally: failure regression checks reject delivery; live Cloudflare delivery unverified. |
| 71 | GET emperor claims can be CSRF-triggered. | Accepted by user. |
| 70 | Deployment preflight rejects valid targets because of stale local Worker routes. | Resolved locally: effective deployment targets pass regression checks for fresh and existing Workers; remote deployment unverified. |
| 69 | Cleanup tests depend on deployment-specific Wrangler configuration. | Resolved locally: isolated Wrangler fixtures pass cleanup and configured-route regression checks. |
| 68 | GET emperor claims lose protocol headers in HTTP Worker preview. | Resolved: deployed; authenticated HTTP Worker preview and regression checks pass. |
| 67 | Deployment and cleanup preflight reject valid account-owned Cloudflare tokens. | Resolved: regression checks and a full deployment with a scoped account token pass. |
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
| 55 | Deployment can migrate D1 before the candidate Worker builds successfully. | Resolved: build and packaging checks preceded live migrations. Deployment remains non-atomic. |
| 54 | Subdomain email deployment changes the parent zone's apex catch-all. | Resolved locally: domains matching only a parent Zone are rejected before database changes or publishing. |
| 53 | Emperor claim URL returned 405; no claim UI existed. | Resolved: claim flow deployed; remote preview confirms authentication is required. |
| 52 | HTTP Worker preview selected the wrong session cookie. | Resolved: deployed; HTTP session authentication passes isolated Worker checks. |
| 51 | Deployment credentials entered the Worker from application environment files. | Resolved: documented deployment passed artifact checks without embedded deployment credentials. |
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
