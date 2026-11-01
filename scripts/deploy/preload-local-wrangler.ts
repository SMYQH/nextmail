import { stripDeployEnvironment } from "./app-env"
import { assertSafeBuildEnv } from "./validate-build-env"

assertSafeBuildEnv()
stripDeployEnvironment()
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false"
