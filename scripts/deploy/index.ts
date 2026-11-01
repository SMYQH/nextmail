import { NotFoundError } from "cloudflare";
import "./load-env";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createDatabase,
  createKVNamespace,
  getDatabase,
  getKVNamespace,
  getKVNamespaceList,
  getEnabledWebhookUrls,
  configureEmailCatchAll,
  configureOpenApiWaf,
  getEmailCatchAll,
  recordPreviousCatchAll,
  verifyCloudflareDeployAccess,
  getOptionalKVValue,
  putKVValue,
  queryDeploymentDatabase,
  WORKER_NAME,
  type WorkerRoute,
} from "./cloudflare";
import { assertWebhookDeployment } from "./webhook-config";
import { syncLocalGitHubSecrets } from "./github-secrets";
import { assertRequiredDeployEnv } from "./required-env";
import { buildAndPreflightBeforeMigration, buildWorkerCandidate } from "./worker-deployment-sequence";
import { readAdminDeploymentConfig, applyAdminSiteSettings, applyAdminCatchAllSettings, type AdminConfigStore } from "./admin-config";
import { readAdminUsers, applyAdminUsers } from "./admin-users";
import { assertOpenApiWafVerifySecret } from "./waf-config";
import { verifyOpenApiHttpBehavior } from "./waf-runtime-verification";

const DATABASE_NAME = "nextmail-d1";
const KV_NAMESPACE_NAME = "nextmail-kv";
const KV_NAMESPACE_ID = process.env.KV_NAMESPACE_ID?.trim();

/**
 * 验证必要的环境变量
 */
const validateEnvironment = () => {
  assertRequiredDeployEnv();

  if (process.env.CUSTOM_DOMAIN?.trim()) {
    assertOpenApiWafVerifySecret(process.env.OPENAPI_WAF_VERIFY_SECRET, process.env.AUTH_SECRET);
  }
};

/**
 * 处理JSON配置文件
 */
/**
 * 更新数据库ID到所有配置文件
 */
const updateDatabaseConfig = (dbId: string) => {
  console.log(`📝 Updating database ID (${dbId}) in configurations...`);

  // 更新所有配置文件
  const configFiles = [
    "wrangler.json",
    "wrangler.email.json",
    "wrangler.cleanup.json",
  ];

  for (const filename of configFiles) {
    const configPath = resolve(filename);
    if (!existsSync(configPath)) continue;

    try {
      const json = JSON.parse(readFileSync(configPath, "utf-8"));
      if (json.d1_databases && json.d1_databases.length > 0) {
        json.d1_databases[0].database_id = dbId;
      }
      writeFileSync(configPath, JSON.stringify(json, null, 2));
      console.log(`✅ Updated database ID in ${filename}`);
    } catch (error) {
      console.error(`❌ Failed to update ${filename}:`, error);
      throw error;
    }
  }
};

/**
 * 更新KV命名空间ID到所有配置文件
 */
const updateKVConfig = (namespaceId: string) => {
  console.log(`📝 Updating KV namespace ID (${namespaceId}) in configurations...`);

  // 主应用与邮件接收 Worker 共享网站配置。
  for (const filename of ["wrangler.json", "wrangler.email.json"]) {
    const wranglerPath = resolve(filename);
    if (!existsSync(wranglerPath)) continue;
    try {
      const json = JSON.parse(readFileSync(wranglerPath, "utf-8"));
      json.kv_namespaces ??= [];
      const binding = json.kv_namespaces.find((entry: { binding: string }) => entry.binding === "SITE_CONFIG");
      if (binding) binding.id = namespaceId;
      else json.kv_namespaces.push({ binding: "SITE_CONFIG", id: namespaceId });
      writeFileSync(wranglerPath, JSON.stringify(json, null, 2));
      console.log(`✅ Updated KV namespace ID in ${filename}`);
    } catch (error) {
      console.error(`❌ Failed to update ${filename}:`, error);
      throw error;
    }
  }
};

/**
 * 检查并创建数据库
 */
const checkAndCreateDatabase = async () => {
  console.log(`🔍 Checking if database "${DATABASE_NAME}" exists...`);

  try {
    const database = await getDatabase();

    if (!database || !database.uuid) {
      const created = await createDatabase();
      if (!created.uuid) throw new Error('Database object is missing a valid UUID');
      updateDatabaseConfig(created.uuid);
      return created.uuid;
    }

    // A configured DATABASE_ID must still point at this project's database.
    if (database.name !== DATABASE_NAME) {
      throw new Error(`Resolved D1 database is not named "${DATABASE_NAME}"; refusing to bind the Worker to it.`);
    }

    updateDatabaseConfig(database.uuid);
    console.log(`✅ Database "${DATABASE_NAME}" already exists (ID: ${database.uuid})`);
    return database.uuid;
  } catch (error) {
    if (error instanceof NotFoundError) {
      console.log(`⚠️ Database not found, creating new database...`);
      try {
        const database = await createDatabase();

        if (!database || !database.uuid) {
          throw new Error('Database object is missing a valid UUID');
        }

        updateDatabaseConfig(database.uuid);
        console.log(`✅ Database "${DATABASE_NAME}" created successfully (ID: ${database.uuid})`);
        return database.uuid;
      } catch (createError) {
        console.error(`❌ Failed to create database:`, createError);
        throw createError;
      }
    } else {
      console.error(`❌ An error occurred while checking the database:`, error);
      throw error;
    }
  }
};

/**
 * 迁移数据库
 */
const migrateDatabase = (appliedDefaultRole?: string) => {
  console.log("📝 Migrating remote database...");
  try {
    execSync("npm run db:migrate-remote", {
      stdio: "inherit",
      env: { ...process.env, NEXTMAIL_DEPLOY_DEFAULT_ROLE: appliedDefaultRole || "" },
    });
    console.log("✅ Database migration completed successfully");
  } catch (error) {
    console.error("❌ Database migration failed:", error);
    throw error;
  }
};

/**
 * 检查并创建KV命名空间
 */
const checkAndCreateKVNamespace = async () => {
  console.log(`🔍 Checking if KV namespace "${KV_NAMESPACE_NAME}" exists...`);

  if (KV_NAMESPACE_ID) {
    // A configured namespace ID must still point at this project's namespace.
    let configured: Awaited<ReturnType<typeof getKVNamespace>> | undefined;
    try {
      configured = await getKVNamespace(KV_NAMESPACE_ID);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
    if (!configured) {
      throw new Error(`KV_NAMESPACE_ID ${KV_NAMESPACE_ID} was not found in this account; refusing to bind the Worker to it.`);
    }
    if (configured.title !== KV_NAMESPACE_NAME) {
      throw new Error(`KV_NAMESPACE_ID does not point to the project namespace "${KV_NAMESPACE_NAME}"; refusing to bind the Worker to it.`);
    }
    updateKVConfig(KV_NAMESPACE_ID);
    console.log(`✅ User specified KV namespace (ID: ${KV_NAMESPACE_ID})`);
    return KV_NAMESPACE_ID;
  }

  try {
    let namespace;

    const namespaceList = await getKVNamespaceList();
    namespace = namespaceList.find(ns => ns.title === KV_NAMESPACE_NAME);

    if (namespace && namespace.id) {
      updateKVConfig(namespace.id);
      console.log(`✅ KV namespace "${KV_NAMESPACE_NAME}" found by name (ID: ${namespace.id})`);
    } else {
      console.log("⚠️ KV namespace not found by name, creating new KV namespace...");
      namespace = await createKVNamespace();
      updateKVConfig(namespace.id);
      console.log(`✅ KV namespace "${KV_NAMESPACE_NAME}" created successfully (ID: ${namespace.id})`);
    }
    return namespace.id;
  } catch (error) {
    console.error(`❌ An error occurred while checking the KV namespace:`, error);
    throw error;
  }
};

/**
 * Records the Catch-all rule that is in place before this project takes over
 * the zone, so the cleanup can restore it instead of leaving the zone disabled.
 */
const recordPreviousCatchAllBeforeOverwrite = async (zoneId: string) => {
  const namespaceId = KV_NAMESPACE_ID?.trim()
    || (await getKVNamespaceList()).find(namespace => namespace.title === KV_NAMESPACE_NAME)?.id;
  if (!namespaceId) {
    console.log("ℹ️ No project KV namespace is available; the previous Catch-all rule is not recorded");
    return;
  }
  const rule = await getEmailCatchAll(zoneId);
  const recorded = await recordPreviousCatchAll(namespaceId, zoneId, rule);
  console.log(recorded
    ? `✅ Recorded the previous Email Routing Catch-all rule in KV namespace ${namespaceId}`
    : `ℹ️ A previous Email Routing Catch-all rule is already recorded in KV namespace ${namespaceId}`);
};

const updateWorkerExposure = (route?: WorkerRoute, privateWorker = false) => {
  const wranglerPath = resolve("wrangler.json");
  const config = JSON.parse(readFileSync(wranglerPath, "utf8")) as Record<string, unknown>;
  config.workers_dev = privateWorker ? false : !route;
  if (route && !privateWorker) config.routes = [route];
  else delete config.routes;
  writeFileSync(wranglerPath, JSON.stringify(config, null, 2));
  console.log(privateWorker
    ? "Keeping the initial Worker private while its secrets are installed"
    : route
      ? "Configured Worker custom domain " + route.pattern
      : "Configured the Worker workers.dev endpoint");
};

const pushWorkerSecrets = () => {
  const names = ["AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET", "AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET", "AUTH_SECRET", "WEBHOOK_ALLOWED_HOSTS"];
  const secrets = Object.fromEntries(names.map(name => [name, process.env[name] || ""]));
  execSync("npx wrangler secret bulk --config wrangler.json", {
    input: JSON.stringify(secrets), stdio: ["pipe", "inherit", "inherit"],
  });
};

const deployOpenNextWorker = (route: WorkerRoute | undefined, exists: boolean) => {
  if (!exists) {
    execSync("npx wrangler deploy --config wrangler.json", { stdio: "inherit" });
    pushWorkerSecrets();
    updateWorkerExposure(route);
    execSync("npx wrangler deploy --config wrangler.json", { stdio: "inherit" });
  } else {
    pushWorkerSecrets();
    updateWorkerExposure(route);
    execSync("npx wrangler deploy --config wrangler.json", { stdio: "inherit" });
  }
  console.log("OpenNext Worker deployment completed successfully");
};

const deployEmailWorker = () => {
  console.log("🚧 Deploying Email Worker...");
  try {
    execSync("npx wrangler deploy --config wrangler.email.json", { stdio: "inherit" });
    execSync("npx wrangler secret bulk --config wrangler.email.json", {
      input: JSON.stringify({ WEBHOOK_ALLOWED_HOSTS: process.env.WEBHOOK_ALLOWED_HOSTS || '' }),
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    console.log("✅ Email Worker deployed successfully");
  } catch (error) {
    console.error("❌ Email Worker deployment failed:", error);
    throw error;
  }
};

/**
 * 部署Cleanup Worker
 */
const deployCleanupWorker = () => {
  console.log("🚧 Deploying Cleanup Worker...");
  try {
    execSync("npx wrangler deploy --config wrangler.cleanup.json", { stdio: "inherit" });
    console.log("✅ Cleanup Worker deployed successfully");
  } catch (error) {
    console.error("❌ Cleanup Worker deployment failed:", error);
    throw error;
  }
};

/**
 * 主函数
 */
export const main = async () => {
  try {
    console.log("🚀 Starting deployment process...");

    validateEnvironment();
    // Parse all explicit settings before a build or any remote changes.
    const adminConfig = readAdminDeploymentConfig(process.env);
    const adminUsers = readAdminUsers(process.env);
    let siteConfig: AdminConfigStore;
    let configuredDomains: string[] = [];
    const openApiWafVerifySecret = process.env.CUSTOM_DOMAIN?.trim()
      ? assertOpenApiWafVerifySecret(process.env.OPENAPI_WAF_VERIFY_SECRET, process.env.AUTH_SECRET)
      : undefined;
    // This secret is used only by this process for the ruleset expression and HTTP probes.
    // Removing it before any child command keeps build output and Worker deployment env clean.
    delete process.env.OPENAPI_WAF_VERIFY_SECRET;
    console.log("🔐 Checking Cloudflare API token and deployment access...");
    const cloudflareAccess = await verifyCloudflareDeployAccess({
      emailDomain: process.env.EMAIL_DOMAIN!,
      customDomain: process.env.CUSTOM_DOMAIN,
      manageOpenApiWaf: Boolean(process.env.CUSTOM_DOMAIN?.trim()),
    });
    const { emailCatchAllTarget, workerRoute, openApiWafTarget } = cloudflareAccess;
    const workerExists = cloudflareAccess.existingWorkerNames.has(WORKER_NAME);
    console.log("✅ Cloudflare token is active and required account/Zone API access is available");
    if (openApiWafTarget) {
      console.log("ℹ️ OpenAPI WAF rules will be scoped to the configured hostname. Bot Fight Mode is disabled for this Zone.");
    } else {
      console.log("ℹ️ OpenAPI WAF rules require CUSTOM_DOMAIN; workers.dev does not provide a customer-managed Zone.");
    }
    const databaseId = await buildAndPreflightBeforeMigration(
      () => {
        updateWorkerExposure(workerRoute, !workerExists);
        buildWorkerCandidate(command => execSync(command, { stdio: "inherit" }));
      },
      async () => {
        const id = await checkAndCreateDatabase();
        assertWebhookDeployment(await getEnabledWebhookUrls(id), process.env.WEBHOOK_ALLOWED_HOSTS || '');
        if (!process.env.WEBHOOK_ALLOWED_HOSTS?.trim()) console.log("ℹ️ Webhooks require WEBHOOK_ALLOWED_HOSTS; see docs/deploy.md#webhook-setup. No enabled webhooks are affected.");
        if (openApiWafTarget && openApiWafVerifySecret) {
          await configureOpenApiWaf(openApiWafTarget, openApiWafVerifySecret);
        }
        const namespaceId = await checkAndCreateKVNamespace();
        if (!namespaceId) throw new Error("Project KV namespace has no ID");
        siteConfig = {
          get: key => getOptionalKVValue(namespaceId, key),
          put: async (key, value) => {
            try { await putKVValue(namespaceId, key, value); }
            catch { throw new Error(`Could not save deployment setting ${key}`); }
          },
        };
        // Resolve the selected namespace and defaults before the one-time role backfill.
        configuredDomains = await applyAdminSiteSettings(adminConfig, siteConfig);
        return id;
      },
      () => migrateDatabase(adminConfig.values.DEFAULT_ROLE),
    );
    const query = (sql: string, params?: string[]) => queryDeploymentDatabase(databaseId, sql, params);
    await applyAdminUsers(adminUsers, query, configuredDomains, process.env.WEBHOOK_ALLOWED_HOSTS || "");
    await applyAdminCatchAllSettings(adminConfig, siteConfig!, query);
    await syncLocalGitHubSecrets();
    deployOpenNextWorker(workerRoute, workerExists);
    deployEmailWorker();
    deployCleanupWorker();
    await recordPreviousCatchAllBeforeOverwrite(emailCatchAllTarget.zone.id!);
    await configureEmailCatchAll(emailCatchAllTarget);

    if (openApiWafTarget && openApiWafVerifySecret) {
      await verifyOpenApiHttpBehavior(openApiWafTarget, openApiWafVerifySecret);
      console.log("✅ OpenAPI WAF rules and post-deployment HTTP behavior verified");
    }

    console.log("🎉 Deployment completed successfully");
  } catch (error) {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
