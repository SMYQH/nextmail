import "./load-env";
import { NotFoundError } from "cloudflare";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DATABASE_NAME,
  EMAIL_WORKER_NAME,
  getDatabase,
  getDatabaseById,
  getKVNamespace,
  getKVNamespaceList,
  getWorkerRoutes,
  getZoneByExactName,
  deleteDatabaseById,
  deleteKVNamespace,
  deleteWorkerRoute,
  deleteWorkerScript,
  disableEmailCatchAll,
  PROJECT_WORKER_NAMES,
  verifyCloudflareDeployAccess,
  WORKER_NAME,
  KV_NAMESPACE_NAME,
  type WorkerRoute,
} from "./cloudflare";

type WranglerConfig = { routes?: Array<{ pattern?: string; zone_name?: string }> };

function readConfiguredRoutes(): WorkerRoute[] {
  const configPath = resolve("wrangler.json");
  if (!existsSync(configPath)) return [];

  const config = JSON.parse(readFileSync(configPath, "utf8")) as WranglerConfig;
  return (config.routes ?? []).flatMap(route =>
    route.pattern && route.zone_name
      ? [{ pattern: route.pattern, zone_name: route.zone_name }]
      : [],
  );
}

function validateEnvironment() {
  const required = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "EMAIL_DOMAIN"];
  const missing = required.filter(name => !process.env[name]?.trim());
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
}

export async function deleteProjectResources() {
  validateEnvironment();

  const configuredRoutes = readConfiguredRoutes();
  const preflight = await verifyCloudflareDeployAccess({
    emailDomain: process.env.EMAIL_DOMAIN!,
    customDomain: process.env.CUSTOM_DOMAIN,
    workerRouteZoneNames: configuredRoutes.map(route => route.zone_name),
  });

  const routeSpecs = new Map<string, WorkerRoute>();
  for (const route of configuredRoutes) {
    routeSpecs.set(`${route.zone_name}:${route.pattern}`, route);
  }
  if (preflight.workerRoute) {
    routeSpecs.set(`${preflight.workerRoute.zone_name}:${preflight.workerRoute.pattern}`, preflight.workerRoute);
  }

  const workerRoutes = [];
  for (const route of routeSpecs.values()) {
    const zone = await getZoneByExactName(route.zone_name);
    const matchingRoutes = (await getWorkerRoutes(zone.id!)).filter(candidate =>
      candidate.script === WORKER_NAME && candidate.pattern === route.pattern,
    );
    workerRoutes.push(...matchingRoutes.map(candidate => ({ route: candidate, zoneId: zone.id! })));
  }

  const catchAll = preflight.emailCatchAllRule;

  let database: Awaited<ReturnType<typeof getDatabase>> | undefined;
  if (process.env.DATABASE_ID?.trim()) {
    try {
      database = await getDatabaseById(process.env.DATABASE_ID.trim());
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
    if (database && database.name !== DATABASE_NAME) {
      throw new Error(`DATABASE_ID does not point to the project database "${DATABASE_NAME}"; refusing to delete it.`);
    }
  } else {
    database = await getDatabase() ?? undefined;
  }
  if (database && database.name !== DATABASE_NAME) {
    throw new Error(`Resolved D1 database is not named "${DATABASE_NAME}"; refusing to delete it.`);
  }

  let namespace: Awaited<ReturnType<typeof getKVNamespace>> | undefined;
  if (process.env.KV_NAMESPACE_ID?.trim()) {
    try {
      namespace = await getKVNamespace(process.env.KV_NAMESPACE_ID.trim());
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
    if (namespace && namespace.title !== KV_NAMESPACE_NAME) {
      throw new Error(`KV_NAMESPACE_ID does not point to the project namespace "${KV_NAMESPACE_NAME}"; refusing to delete it.`);
    }
  } else {
    namespace = (await getKVNamespaceList()).find(candidate => candidate.title === KV_NAMESPACE_NAME);
  }

  const existingWorkers = PROJECT_WORKER_NAMES.filter(name => preflight.existingWorkerNames.has(name));
  const catchAllTargetsEmailWorker = Boolean(
    catchAll?.actions?.length === 1 &&
    catchAll.actions[0]?.type === "worker" &&
    catchAll.actions[0].value?.length === 1 &&
    catchAll.actions[0].value[0] === EMAIL_WORKER_NAME &&
    catchAll.enabled,
  );

  console.log("Cloudflare token and project resource access verified.");
  console.log(`Workers: ${existingWorkers.length ? existingWorkers.join(", ") : "none found"}`);
  console.log(`Custom routes: ${workerRoutes.length ? workerRoutes.map(item => item.route.pattern).join(", ") : "none found"}`);
  console.log(`Email Catch All: ${catchAllTargetsEmailWorker ? "will be disabled" : "not routed to this project"}`);
  console.log(`KV: ${namespace?.id ?? "none found"}`);
  console.log(`D1: ${database?.uuid ?? "none found"}`);

  if (catchAllTargetsEmailWorker) {
    await disableEmailCatchAll(preflight.emailCatchAllTarget.zone.id!, catchAll!);
    console.log("Disabled the NextMail Email Routing Catch All.");
  }

  for (const item of workerRoutes) {
    await deleteWorkerRoute(item.route.id, item.zoneId);
    console.log(`Deleted Worker route ${item.route.pattern}.`);
  }

  for (const workerName of existingWorkers) {
    await deleteWorkerScript(workerName);
    console.log(`Deleted Worker ${workerName}.`);
  }

  if (namespace?.id) {
    await deleteKVNamespace(namespace.id);
    console.log(`Deleted KV namespace ${KV_NAMESPACE_NAME}.`);
  }

  if (database?.uuid) {
    await deleteDatabaseById(database.uuid);
    console.log(`Deleted D1 database ${DATABASE_NAME}.`);
  }

  console.log("Cloudflare project cleanup completed. GitHub repositories and secrets were not changed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  deleteProjectResources().catch(error => {
    console.error("Cloudflare project cleanup failed:", error);
    process.exitCode = 1;
  });
}
