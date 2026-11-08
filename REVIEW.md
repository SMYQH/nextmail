# Review Findings

Newest findings appear first. Each row records only the issue and current disposition.

| ID | Issue | Status / resolution |
| --- | --- | --- |
| 175 | Review ledger rows record implementation details and verification narratives. | Resolved locally. |
| 174 | Canonical and Open Graph links fall back to the request host. | Resolved locally; production deployment unverified. |
| 173 | The shared editor debug configuration used invalid schema keys and a misplaced compound. | Resolved locally. |
| 172 | Tracked Wrangler configs publish deployment resource IDs. | Resolved locally; the remote still needs a force-push. |
| 171 | The framework release deprecates the `middleware` file convention. | Resolved locally. |
| 170 | Cold sign-ins can fail with CSRF errors. | Resolved locally. |
| 169 | The framework release blocks supported OpenNext builds. | Resolved locally; live deployment remains unverified. |
| 168 | Turnstile browser tests erase existing local configuration. | Resolved locally. |
| 167 | Gate and snapshot timeouts leave descendant processes running. | Resolved locally. |
| 166 | API-key refreshes discard returned changes to already-loaded keys. | Resolved locally. |
| 165 | Scoped commits interpret bracketed filenames as Git patterns. | Resolved locally. |
| 164 | Failed environment preprocessing leaves earlier credential files stripped. | Resolved locally. |
| 163 | Role backfill reads an obsolete namespace when deployment overrides KV. | Resolved locally; remote deployment unverified. |
| 162 | API-key mutations discard loaded older pages and keyboard focus. | Resolved locally; the initial client startup error did not recur on rerun. |
| 161 | Message-IDs differing only by case collide and silently discard mail. | Resolved locally. |
| 160 | Migration journal entry 0026 has no SQL migration or snapshot. | Resolved locally. |
| 159 | Catch-all backups can restore a different zone's routing configuration. | Resolved locally; remote routing unverified. |
| 158 | Catch-all backups can save NextMail's own rule as its predecessor. | Resolved locally; remote routing unverified. |
| 157 | Repeated migrations re-grant intentionally revoked default roles. | Resolved locally. |
| 156 | Snapshot cleanup follows linked roots and can delete external files. | Resolved locally. |
| 155 | Dummy password initialization starts disallowed module-scope cryptography. | Resolved locally. |
| 154 | Concurrent mailbox creations can exceed the active mailbox cap. | Resolved locally. |
| 153 | Invalid MAX_EMAILS values can disable or block mailbox creation limits. | Resolved locally; production behavior unverified. |
| 151 | Isolated browser runs can lose client-session or refresh interactivity. | Resolved locally; production behavior unverified. |
| 150 | Committed loop regressions depend on unstaged user changes. | Resolved locally. |
| 149 | Cleanup runs an unbounded delete loop and can exceed the D1 query limit. | Resolved locally; production behavior unverified. |
| 148 | Inbound mail has no idempotency key, so a redelivery is stored twice. | Resolved locally; live delivery unverified. |
| 147 | The inbound email worker blocks on webhook delivery for up to about half a minute. | Resolved locally; production behaviour unverified. |
| 146 | Duplicate webhook rows per user are possible and are read without ordering. | Resolved locally; production migration unverified. |
| 145 | Share links and API keys are never pruned, and share listings are unbounded. | Resolved locally. |
| 144 | The Catch-all lookup scans the whole mailbox table on every unknown recipient. | Resolved locally. |
| 143 | Deleted accounts keep a valid session cookie until it expires. | Resolved locally. |
| 142 | Unknown usernames answer faster than known ones. | Resolved locally; production timing unverified. |
| 141 | The deploy overwrites the zone Catch-all without recording the previous rule. | Resolved locally; remote routing unverified. |
| 140 | The message retry action reloads the whole application. | Resolved locally. |
| 139 | Deleting a message moves keyboard focus to the document body. | Resolved locally. |
| 138 | The shared mailbox page keeps polling while the tab is hidden. | Resolved locally. |
| 137 | Application .env credentials ship in plaintext inside the deployed Worker bundle. | Resolved locally; live deployment remains unverified. |
| 136 | The deploy can bind the Worker to a foreign D1 database or KV namespace. | Resolved locally; deployment not re-verified. |
| 135 | Admin user lists accept an invalid page and fail with a server error. | Resolved locally. |
| 134 | Malformed request bodies produce server errors instead of invalid-input responses. | Resolved locally. |
| 133 | The webhook configuration endpoint returns the signing secret. | Resolved locally: the response omits the secret and is not cacheable. |
| 132 | Share expiry options and dialog errors show the wrong language or raw errors. | Resolved locally: expiry labels are localized, list and create failures differ, and icon buttons are named. |
| 131 | Icon-only controls in the profile and shared pages have no accessible name. | Resolved locally: named controls pass bilingual keyboard checks. |
| 130 | Retired Pages hostnames remain in the interface, canonical links, and documentation. | Resolved locally: hosts derive from the deployment and the README points at the Worker. |
| 129 | The session callback silently re-grants a default role to accounts without one. | Resolved locally: session lookups preserve role revocations and the one-time upgrade backfill passes local checks. |
| 128 | API-key load and toggle failures incorrectly report creation failures. | Resolved locally: operation-specific feedback passes bilingual browser checks; production behavior unverified. |
| 127 | API-key switches and delete controls have no accessible names. | Resolved locally: key-specific bilingual labels pass keyboard and browser checks. |
| 126 | Pending API-key row actions permit overlapping changes. | Resolved locally: per-key locking and failure recovery pass browser checks; production concurrency unverified. |
| 125 | Stale list refreshes visually undo API-key toggles and deletions. | Resolved locally: both races reproduce before the fix and pass afterward; production behavior unverified. |
| 124 | A delayed API-key list refresh can hide a newer creation. | Resolved locally: overlapping refresh checks retain new records; production behavior unverified. |
| 123 | API-key dialog dismissal retains sensitive state and allows obsolete requests to affect reopened forms. | Resolved locally: all close paths and delayed-response checks pass in both locales; production behavior unverified. |
| 122 | API-key creation error text has insufficient contrast in dark mode. | Resolved locally: error text passes light/dark contrast and browser checks. |
| 121 | API-key dialog actions touch when stacked on mobile. | Resolved locally: spacing passes bilingual desktop/mobile browser checks. |
| 120 | Duplicate API-key names return server errors and close the creation dialog. | Resolved locally: API and bilingual desktop/mobile retry checks pass; production behavior unverified. |
| 119 | Malformed page and polling cursors produce server errors or restart polling. | Resolved locally: validation and legacy polling regressions pass; remote behavior unverified. |
| 118 | Failed mailbox deletion can erase messages and message-share links while leaving the mailbox. | Resolved locally: atomic cascade and failure-preservation regressions pass; remote behavior unverified. |
| 117 | Shared mailbox summary queries load and discard full message bodies. | Resolved locally: body fields are excluded; summary and pagination regressions pass. |
| 116 | Public mailbox endpoints expose data at the exact share or mailbox expiry timestamp. | Resolved locally: all mailbox endpoints reject the expiry boundary; remote behavior unverified. |
| 115 | Malformed API-key mutation bodies can change key enablement or return server errors. | Resolved locally: strict input validation passes route regressions; remote behavior unverified. |
| 114 | Invalid share expiry values can create permanent links or fail as server errors. | Resolved locally: expiry validation passes route regressions; remote behavior unverified. |
| 113 | Deployment probes mistake Cloudflare detection scripts in successful HTML for a blocking challenge. | Resolved: corrected probes pass regression checks and the full production deployment. |
| 112 | Deployment does not configure project-scoped WAF exceptions for OpenAPI and browser verification. | Resolved: project rules are deployed; live API and front-end probes pass with rate limits preserved. |
| 111 | Catch-all configuration conflates collection and visibility after disabling it. | Resolved: separate collection and visibility controls pass local saved-flag checks and live bilingual desktop/mobile checks. |
| 110 | External profile avatars fail without a usable fallback. | Resolved: header/profile loading and blocked-image fallbacks pass live bilingual desktop/mobile checks. |
| 109 | HTML message body sometimes appears blank under the All mailbox filter. | Resolved: iframe hardening is deployed; the existing message renders in All and domain views in both locales on desktop/mobile. |
| 108 | Authenticated production requests intermittently fail with Worker resource-limit errors. | Partially resolved: duplicate middleware authentication is removed in production; current checks pass, but the earlier CPU-limit failures are not reproduced. |
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
| 18 | API keys are stored in plaintext. | Accepted by user: kept for development convenience; the user also accepts plaintext display in the owner's authorized management panel. |
| 17 | PWA cache retained private responses after logout. | Resolved. |
| 16 | Concurrent case variants could create conflicting email owners. | Resolved. |
| 15 | Risky OAuth account linking was enabled. | Resolved. |
| 14 | Dependency audit failed. | Partially resolved: production dependencies audit clean; deployment-tool dependencies retain advisories. |
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
