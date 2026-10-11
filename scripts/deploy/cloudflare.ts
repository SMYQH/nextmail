import Cloudflare from "cloudflare";
import "./load-env";

const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID!;
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const WORKER_NAME = "nextmail";
const DATABASE_NAME = "nextmail-d1";
const KV_NAMESPACE_NAME = "nextmail-kv";
const DATABASE_ID = process.env.DATABASE_ID;
const EMAIL_WORKER_NAME = "email-receiver-worker";

const client = new Cloudflare({
  apiToken: CF_API_TOKEN,
});

export const normalizeHostname = (value: string) => {
  const url = value.includes("://") ? value : `https://${value}`;
  const hostname = new URL(url).hostname.toLowerCase();
  if (!hostname || hostname.includes("/")) {
    throw new Error(`Invalid hostname: ${value}`);
  }
  return hostname;
};

export const getZoneForHostname = async (hostname: string) => {
  const zones = [];
  for await (const zone of client.zones.list({})) {
    zones.push(zone);
  }

  const matches = zones
    .filter(zone => hostname === zone.name || hostname.endsWith(`.${zone.name}`))
    .sort((left, right) => right.name.length - left.name.length);

  const zone = matches[0];
  if (!zone?.id) {
    throw new Error(`No Cloudflare Zone found for ${hostname}`);
  }
  return zone;
};

export const hasWorkerScript = async (scriptName: string) => {
  for await (const script of client.workers.scripts.list({ account_id: CF_ACCOUNT_ID })) {
    if (script.id === scriptName) return true;
  }
  return false;
};

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
