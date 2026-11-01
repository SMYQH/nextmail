import { config } from "dotenv"
import { resolve } from "node:path"
import { assertSafeBuildEnv } from "./validate-build-env"

// GitHub Actions receives settings only from explicit workflow environment
// mappings. An ignored local file must never act as a CI fallback.
if (process.env.GITHUB_ACTIONS !== "true") {
  config({ path: resolve(process.cwd(), ".env.deploy") })
}
assertSafeBuildEnv()
