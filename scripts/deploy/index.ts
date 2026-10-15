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
  getKVNamespaceList,
  getEnabledWebhookUrls,
  configureEmailCatchAll,
  verifyCloudflareDeployAccess,
  WORKER_NAME,
  type WorkerRoute,
} from "./cloudflare";
import { assertWebhookDeployment } from "./webhook-config";
import { syncLocalGitHubSecrets } from "./github-secrets";
import { assertSafeBuildEnv } from "./validate-build-env";
import { buildAndPreflightBeforeMigration, buildWorkerCandidate } from "./worker-deployment-sequence";

const DATABASE_NAME = "nextmail-d1";
const KV_NAMESPACE_NAME = "nextmail-kv";
const KV_NAMESPACE_ID = process.env.KV_NAMESPACE_ID;

/**
 * 验证必要的环境变量
 */
const validateEnvironment = () => {
  assertSafeBuildEnv();
  const requiredEnvVars = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "AUTH_SECRET", "EMAIL_DOMAIN"];
  const missing = requiredEnvVars.filter((varName) => !process.env[varName]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
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
const migrateDatabase = () => {
  console.log("📝 Migrating remote database...");
  try {
    execSync("npm run db:migrate-remote", { stdio: "inherit" });
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
    updateKVConfig(KV_NAMESPACE_ID);
    console.log(`✅ User specified KV namespace (ID: ${KV_NAMESPACE_ID})`);
    return;
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
  } catch (error) {
    console.error(`❌ An error occurred while checking the KV namespace:`, error);
    throw error;
  }
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
      ? "Configured Worker route " + route.pattern
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
    console.log("🔐 Checking Cloudflare API token and deployment access...");
    const cloudflareAccess = await verifyCloudflareDeployAccess({
      emailDomain: process.env.EMAIL_DOMAIN!,
      customDomain: process.env.CUSTOM_DOMAIN,
    });
    const { emailCatchAllTarget, workerRoute } = cloudflareAccess;
    const workerExists = cloudflareAccess.existingWorkerNames.has(WORKER_NAME);
    console.log("✅ Cloudflare token is active and required account/Zone API access is available");
    await buildAndPreflightBeforeMigration(
      () => {
        updateWorkerExposure(workerRoute, !workerExists);
        buildWorkerCandidate(command => execSync(command, { stdio: "inherit" }));
      },
      async () => {
        const id = await checkAndCreateDatabase();
        assertWebhookDeployment(await getEnabledWebhookUrls(id), process.env.WEBHOOK_ALLOWED_HOSTS || '');
        if (!process.env.WEBHOOK_ALLOWED_HOSTS?.trim()) console.log("ℹ️ Webhooks require WEBHOOK_ALLOWED_HOSTS; see docs/deploy.md#webhook-setup. No enabled webhooks are affected.");
        return id;
      },
      migrateDatabase,
    );
    await checkAndCreateKVNamespace();
    await syncLocalGitHubSecrets();
    deployOpenNextWorker(workerRoute, workerExists);
    deployEmailWorker();
    deployCleanupWorker();
    await configureEmailCatchAll(emailCatchAllTarget);

    console.log("🎉 Deployment completed successfully");
  } catch (error) {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
