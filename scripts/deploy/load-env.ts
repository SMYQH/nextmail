import { config } from "dotenv"

// Process environment (including CI secrets) wins over local files.
config({ path: ".env.deploy" })
config({ path: ".env" })
