import { defineConfig, devices } from "@playwright/test"

/**
 * Browser suite for the local Next.js dev server.
 *
 * `npm run dev` calls `initOpenNextCloudflareForDev()`, so the dev server serves
 * the real local D1 and KV bindings. This does not prove production Workers
 * compatibility. Only the Chromium download bundled with `@playwright/test` is
 * used; no system browser is involved.
 *
 * The port and the base URL can be set by the isolated browser runner:
 *
 *   - `PLAYWRIGHT_PORT` selects the port the dev server listens on.
 *     Default: 3000. The value is handed to `next dev` through the
 *     environment, so the spawned server and the suite always agree.
 *   - `PLAYWRIGHT_BASE_URL` overrides the base URL entirely. When it is given
 *     without `PLAYWRIGHT_PORT`, the server port is taken from its URL so the
 *     started server still matches the base URL.
 *
 * The two variables must agree: a base URL that points at another port than
 * the server this run starts would silently test a foreign server, so the
 * mismatch is rejected instead of being resolved silently.
 *
 * Whenever either variable is supplied, this run owns its server:
 * `reuseExistingServer` is false, so Playwright fails loudly instead of
 * attaching to whatever already listens on that port. A snapshot run on its own
 * port therefore can never silently talk to the working tree's dev server.
 * With neither variable set the behaviour is unchanged: port 3000 and reuse of
 * an already-running dev server.
 */

const DEFAULT_PORT = 3000

function readEnv(name: string): string | undefined {
  const value = process.env[name]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

function readPort(raw: string, source: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${source} must be a decimal TCP port, received "${raw}"`)
  }
  const port = Number(raw)
  if (port <= 0 || port > 65535) {
    throw new Error(`${source} must be a valid TCP port, received "${raw}"`)
  }
  return port
}

/**
 * Reads the base URL strictly. An unparseable URL is an error: falling back to
 * the default port would point the suite at a server nobody started.
 */
function readBaseUrl(raw: string): { baseURL: string; port: number } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`PLAYWRIGHT_BASE_URL is not a valid absolute URL: "${raw}"`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`PLAYWRIGHT_BASE_URL must use http or https, received "${raw}"`)
  }
  const port = url.port ? readPort(url.port, "PLAYWRIGHT_BASE_URL") : url.protocol === "https:" ? 443 : 80
  return { baseURL: raw, port }
}

const explicitPort = readEnv("PLAYWRIGHT_PORT")
const explicitBaseUrl = readEnv("PLAYWRIGHT_BASE_URL")

const parsedBaseUrl = explicitBaseUrl ? readBaseUrl(explicitBaseUrl) : undefined
const port = explicitPort
  ? readPort(explicitPort, "PLAYWRIGHT_PORT")
  : parsedBaseUrl
    ? parsedBaseUrl.port
    : DEFAULT_PORT

if (explicitPort && parsedBaseUrl && parsedBaseUrl.port !== port) {
  throw new Error(
    `PLAYWRIGHT_PORT (${port}) and PLAYWRIGHT_BASE_URL (${explicitBaseUrl}) disagree: ` +
      `the base URL uses port ${parsedBaseUrl.port}. Set both to the same port.`,
  )
}

const baseURL = parsedBaseUrl ? parsedBaseUrl.baseURL : `http://localhost:${port}`

// An explicit port or base URL means the caller wants a private server.
const ownsServer = Boolean(explicitPort || explicitBaseUrl)

export default defineConfig({
  testDir: "./tests/browser",
  outputDir: ".test/results/browser",
  // The dev server compiles routes on demand and the local D1 is a single shared
  // SQLite file, so the suite runs serially.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [
    ["list"],
    ["html", { outputFolder: ".test/playwright", open: "never" }],
    ["json", { outputFile: ".test/results/results.json" }],
  ],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
  },
  projects: [
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        browserName: "chromium",
      },
    },
    {
      name: "mobile-chromium",
      use: {
        ...devices["Pixel 5"],
        browserName: "chromium",
        viewport: { width: 390, height: 640 },
      },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: `${baseURL}/en/login`,
    // `next dev` reads the port from the environment.
    env: { PORT: String(port) },
    // Never attach to a foreign server once the caller asked for a private one.
    reuseExistingServer: !ownsServer,
    // The first request compiles the route, which is slow on a cold dev server.
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
})
