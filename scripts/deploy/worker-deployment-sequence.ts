export function buildWorkerCandidate(runCommand: (command: string) => void) {
  runCommand("npm run build:worker")
  runCommand("npx wrangler deploy --dry-run --config wrangler.json")
}

export async function buildAndPreflightBeforeMigration<T>(
  buildWorker: () => void,
  preflight: () => Promise<T>,
  migrateDatabase: () => void,
): Promise<T> {
  buildWorker()
  const preflightResult = await preflight()
  migrateDatabase()
  return preflightResult
}
