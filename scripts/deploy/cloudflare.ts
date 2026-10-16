import Cloudflare, { NotFoundError } from "cloudflare";
import "./load-env";
import {
  configureOpenApiWaf as configureOpenApiWafRules,
  OPENAPI_WAF_PHASE,
  type OpenApiWafTarget,
  type WafEntryPointApi,
  verifyOpenApiWaf as verifyOpenApiWafRules,
} from "./waf-config";

const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID!;
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
export const WORKER_NAME = "nextmail";
export const DATABASE_NAME = "nextmail-d1";
export const KV_NAMESPACE_NAME = "nextmail-kv";
const DATABASE_ID = process.env.DATABASE_ID;
export const EMAIL_WORKER_NAME = "email-receiver-worker";
const CLEANUP_WORKER_NAME = "cleanup-worker";
export const PROJECT_WORKER_NAMES = [WORKER_NAME, EMAIL_WORKER_NAME, CLEANUP_WORKER_NAME];

const client = new Cloudflare({
  apiToken: CF_API_TOKEN,
});

export type WorkerRoute = { pattern: string; zone_name: string; custom_domain?: true };
type CloudflarePreflightOptions = {
  emailDomain: string;
  customDomain?: string;
  workerRouteZoneNames?: string[];
  manageOpenApiWaf?: boolean;
};

const apiErrorStatus = (error: unknown) => {
  if (!error || typeof error !== "object" || !("status" in error)) return "";
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? ` (HTTP ${status})` : "";
};

const checkCloudflareAccess = async <T>(permission: string, action: () => Promise<T>) => {
  try {
    return await action();
  } catch (error) {
    throw new Error(
      `Cloudflare API token preflight failed for ${permission}${apiErrorStatus(error)}. Check the token's account and Zone scope and required permission.`,
    );
  }
};

export const assertOpenApiWafCompatible = async (zoneId: string, hostname: string) => {
  const botConfig = await checkCloudflareAccess("Bot Management: Read", async () =>
    client.botManagement.get({ zone_id: zoneId }),
  ) as { fight_mode?: boolean; stale_zone_configuration?: { fight_mode?: boolean } };
  if (botConfig.fight_mode === true || botConfig.stale_zone_configuration?.fight_mode === true) {
    throw new Error(
      `Cloudflare Bot Fight Mode is enabled for ${hostname}'s Zone. Bot Fight Mode cannot be skipped for OpenAPI requests; disable it or configure Super Bot Fight Mode before deploying NextMail's WAF bypass.`,
    );
  }
};

const listZones = async () => {
  const zones = [];
  for await (const zone of client.zones.list({})) zones.push(zone);
  return zones;
};

const findZoneForHostname = (hostname: string, zones: Awaited<ReturnType<typeof listZones>>) => {
  return zones
    .filter(zone => hostname === zone.name || hostname.endsWith(`.${zone.name}`))
    .sort((left, right) => right.name.length - left.name.length)[0];
};

export const verifyCloudflareDeployAccess = async ({
  emailDomain,
  customDomain,
  workerRouteZoneNames = [],
  manageOpenApiWaf = false,
}: CloudflarePreflightOptions) => {
  let tokenStatus;
  try {
    tokenStatus = await client.user.tokens.verify();
  } catch {
    // Account-owned tokens cannot be verified by the user-token endpoint.
    try {
      tokenStatus = await client.accounts.tokens.verify({ account_id: CF_ACCOUNT_ID });
    } catch (error) {
      throw new Error(`Cloudflare API token is invalid or unavailable${apiErrorStatus(error)}.`);
    }
  }

  const now = Date.now();
  if (
    tokenStatus.status !== "active" ||
    (tokenStatus.expires_on && Date.parse(tokenStatus.expires_on) <= now) ||
    (tokenStatus.not_before && Date.parse(tokenStatus.not_before) > now)
  ) {
    throw new Error(`Cloudflare API token is not currently usable (status: ${tokenStatus.status}).`);
  }

  await checkCloudflareAccess("D1: Edit", async () => {
    await client.d1.database.list({ account_id: CF_ACCOUNT_ID, name: DATABASE_NAME });
  });
  await checkCloudflareAccess("Workers KV Storage: Edit", async () => {
    await client.kv.namespaces.list({ account_id: CF_ACCOUNT_ID });
  });

  const workerScripts = await checkCloudflareAccess("Workers Scripts: Edit", async () => {
    const scripts = [];
    for await (const script of client.workers.scripts.list({ account_id: CF_ACCOUNT_ID })) {
      scripts.push(script);
    }
    return scripts;
  });

  const zones = await checkCloudflareAccess("Zone: Read", listZones);
  const normalizedEmailDomain = normalizeHostname(emailDomain);
  const emailZone = findZoneForHostname(normalizedEmailDomain, zones);
  assertEmailCatchAllZone(normalizedEmailDomain, emailZone?.name);
  if (!emailZone?.id) throw new Error(`No Cloudflare Zone found for ${normalizedEmailDomain}`);

  const emailCatchAllRule = await checkCloudflareAccess("Email Routing Rules: Edit", async () => {
    try {
      return await client.emailRouting.rules.catchAlls.get({ zone_id: emailZone.id! });
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  });

  let workerRoute: WorkerRoute | undefined;
  let openApiWafTarget: OpenApiWafTarget | undefined;
  const routeZones = new Map<string, (typeof zones)[number]>();
  if (customDomain?.trim()) {
    const hostname = normalizeHostname(customDomain);
    const zone = findZoneForHostname(hostname, zones);
    if (!zone?.id || !zone.name) throw new Error(`No Cloudflare Zone found for ${hostname}`);
    workerRoute = { pattern: hostname, zone_name: zone.name, custom_domain: true };
    routeZones.set(zone.name, zone);

    if (manageOpenApiWaf) {
      openApiWafTarget = { hostname, zoneId: zone.id };
      await assertOpenApiWafCompatible(zone.id, hostname);

      await checkCloudflareAccess("WAF: Read", async () => {
        try {
          await client.rulesets.phases.get(OPENAPI_WAF_PHASE, { zone_id: zone.id! });
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
        }
      });
    }
  }

  for (const zoneName of workerRouteZoneNames) {
    const zone = zones.find(candidate => candidate.name.toLowerCase() === zoneName.toLowerCase());
    if (!zone?.id) throw new Error(`No Cloudflare Zone found for configured Worker route zone ${zoneName}`);
    routeZones.set(zone.name, zone);
  }

  for (const zone of routeZones.values()) {
    await checkCloudflareAccess("Workers Routes: Edit", async () => {
      for await (const _route of client.workers.routes.list({ zone_id: zone.id! })) {
        // Consume the page to make the scoped API request.
        break;
      }
    });
  }

  return {
    emailCatchAllTarget: { domain: normalizedEmailDomain, zone: emailZone },
    emailCatchAllRule,
    workerRoute,
    openApiWafTarget,
    existingWorkerNames: new Set(workerScripts.map(script => script.id)),
    routeZones: [...routeZones.values()],
  };
};

export const normalizeHostname = (value: string) => {
  const url = value.includes("://") ? value : `https://${value}`;
  const hostname = new URL(url).hostname.toLowerCase();
  if (!hostname || hostname.includes("/")) {
    throw new Error(`Invalid hostname: ${value}`);
  }
  return hostname;
};

export const getZoneForHostname = async (hostname: string) => {
  const zone = findZoneForHostname(hostname, await listZones());
  if (!zone?.id) {
    throw new Error(`No Cloudflare Zone found for ${hostname}`);
  }
  return zone;
};

export const getZoneByExactName = async (zoneName: string) => {
  const zones = await listZones();
  const zone = zones.find(candidate => candidate.name.toLowerCase() === zoneName.toLowerCase());
  if (!zone?.id) throw new Error(`No Cloudflare Zone found for ${zoneName}`);
  return zone;
};

export const hasWorkerScript = async (scriptName: string) => {
  for await (const script of client.workers.scripts.list({ account_id: CF_ACCOUNT_ID })) {
    if (script.id === scriptName) return true;
  }
  return false;
};

export const getWorkerRoutes = async (zoneId: string) => {
  const routes = [];
  for await (const route of client.workers.routes.list({ zone_id: zoneId })) routes.push(route);
  return routes;
};

export const getKVNamespace = (namespaceId: string) =>
  client.kv.namespaces.get(namespaceId, { account_id: CF_ACCOUNT_ID });

export const getDatabaseById = (databaseId: string) =>
  client.d1.database.get(databaseId, { account_id: CF_ACCOUNT_ID });

export const getEmailCatchAll = (zoneId: string) =>
  client.emailRouting.rules.catchAlls.get({ zone_id: zoneId });

export const disableEmailCatchAll = (zoneId: string, rule: Awaited<ReturnType<typeof getEmailCatchAll>>) => {
  const ownerWorkerTag = "owner_worker_tag" in rule && typeof rule.owner_worker_tag === "string"
    ? rule.owner_worker_tag
    : undefined;

  return client.emailRouting.rules.catchAlls.update({
    zone_id: zoneId,
    actions: rule.actions ?? [],
    matchers: rule.matchers ?? [{ type: "all" }],
    enabled: false,
    ...(rule.name ? { name: rule.name } : {}),
    ...(ownerWorkerTag ? { owner_worker_tag: ownerWorkerTag } : {}),
  });
};

export const deleteWorkerRoute = (routeId: string, zoneId: string) =>
  client.workers.routes.delete(routeId, { zone_id: zoneId });

export const deleteWorkerScript = (scriptName: string) =>
  client.workers.scripts.delete(scriptName, { account_id: CF_ACCOUNT_ID });

export const deleteDatabaseById = (databaseId: string) =>
  client.d1.database.delete(databaseId, { account_id: CF_ACCOUNT_ID });

export const deleteKVNamespace = (namespaceId: string) =>
  client.kv.namespaces.delete(namespaceId, { account_id: CF_ACCOUNT_ID });

const assertEmailCatchAllZone = (domain: string, zoneName?: string) => {
  if (!zoneName) {
    throw new Error(`No Cloudflare Zone name found for ${domain}`);
  }
  if (domain !== zoneName.toLowerCase()) {
    throw new Error(`EMAIL_DOMAIN ${domain} is a subdomain of Cloudflare Zone ${zoneName}; Email Routing catch-all can only target a Zone apex. Configure ${domain} as its own Cloudflare Zone before deployment.`);
  }
};

export const getEmailCatchAllZone = async () => {
  const emailDomain = process.env.EMAIL_DOMAIN;
  if (!emailDomain) {
    throw new Error("EMAIL_DOMAIN is required to configure Email Routing");
  }

  const domain = normalizeHostname(emailDomain);
  const zone = await getZoneForHostname(domain);
  assertEmailCatchAllZone(domain, zone.name);

  return { domain, zone };
};

export const configureEmailCatchAll = async (target?: Awaited<ReturnType<typeof getEmailCatchAllZone>>) => {
  const { domain, zone } = target ?? await getEmailCatchAllZone();
  assertEmailCatchAllZone(domain, zone.name);
  const actions = [{ type: "worker" as const, value: [EMAIL_WORKER_NAME] }];
  const matchers = [{ type: "all" as const }];

  const updated = await client.emailRouting.rules.catchAlls.update({
    zone_id: zone.id,
    actions,
    matchers,
    enabled: true,
    name: `NextMail Catch All -> ${EMAIL_WORKER_NAME}`,
  });
  console.log(`✅ Catch All for ${domain} now targets ${EMAIL_WORKER_NAME}`);
  return updated;
};

const openApiWafApi: WafEntryPointApi = {
  async getEntryPoint(zoneId) {
    try {
      return await client.rulesets.phases.get(OPENAPI_WAF_PHASE, { zone_id: zoneId });
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  },
  async updateEntryPoint(zoneId, input) {
    await client.rulesets.phases.update(OPENAPI_WAF_PHASE, {
      zone_id: zoneId,
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      rules: input.rules,
    });
  },
};

export const configureOpenApiWaf = (target: OpenApiWafTarget, verificationSecret: string) =>
  configureOpenApiWafRules(openApiWafApi, target, verificationSecret);

export const verifyOpenApiWaf = (target: OpenApiWafTarget, verificationSecret: string) =>
  verifyOpenApiWafRules(openApiWafApi, target, verificationSecret);

export const getDatabase = async () => {
  if (DATABASE_ID) {
    return client.d1.database.get(DATABASE_ID, { account_id: CF_ACCOUNT_ID });
  }
  for await (const database of client.d1.database.list({ account_id: CF_ACCOUNT_ID, name: DATABASE_NAME })) {
    if (database.name === DATABASE_NAME && database.uuid) {
      return client.d1.database.get(database.uuid, { account_id: CF_ACCOUNT_ID });
    }
  }
  return null;
};

export const createDatabase = async () => {
  console.log(`🆕 Creating new D1 database: "${DATABASE_NAME}"`);

  const database = await client.d1.database.create({
    account_id: CF_ACCOUNT_ID,
    name: DATABASE_NAME,
  });

  console.log("✅ Database created successfully");

  return database;
};

export const getEnabledWebhookUrls = async (databaseId: string): Promise<string[]> => {
  const tables = await client.d1.database.query(databaseId, {
    account_id: CF_ACCOUNT_ID, sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'webhook'",
  });
  if (!tables.result.some(result => result.results?.length)) return [];
  const queries = await client.d1.database.query(databaseId, {
    account_id: CF_ACCOUNT_ID, sql: "SELECT DISTINCT url FROM webhook WHERE enabled = 1",
  });
  return queries.result.flatMap(query => (query.results || []).map(row => (row as { url: string }).url));
};

export const getKVNamespaceList = async () => {
  const kvNamespaces = [];

  for await (const namespace of client.kv.namespaces.list({
    account_id: CF_ACCOUNT_ID,
  })) {
    kvNamespaces.push(namespace);
  }

  return kvNamespaces;
};

export const createKVNamespace = async () => {
  console.log(`🆕 Creating new KV namespace: "${KV_NAMESPACE_NAME}"`);

  const kvNamespace = await client.kv.namespaces.create({
    account_id: CF_ACCOUNT_ID,
    title: KV_NAMESPACE_NAME,
  });

  console.log("✅ KV namespace created successfully");

  return kvNamespace;
};
