import "./load-env";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertOpenApiWafCompatible,
  getZoneForHostname,
  normalizeHostname,
  verifyOpenApiWaf,
} from "./cloudflare";
import { assertOpenApiWafVerifySecret } from "./waf-config";
import { verifyOpenApiHttpBehavior } from "./waf-runtime-verification";

export async function verifyDeployedOpenApiWaf() {
  const hostname = process.env.CUSTOM_DOMAIN?.trim();
  if (!hostname) throw new Error("CUSTOM_DOMAIN is required; workers.dev has no customer-managed Zone WAF rules.");
  if (!process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || !process.env.CLOUDFLARE_API_TOKEN?.trim()) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required to verify the deployed WAF rules.");
  }

  const verificationSecret = assertOpenApiWafVerifySecret(process.env.OPENAPI_WAF_VERIFY_SECRET, process.env.AUTH_SECRET);
  const normalizedHostname = normalizeHostname(hostname);
  const zone = await getZoneForHostname(normalizedHostname);
  const target = { hostname: normalizedHostname, zoneId: zone.id! };

  await assertOpenApiWafCompatible(target.zoneId, target.hostname);
  await verifyOpenApiWaf(target, verificationSecret);
  await verifyOpenApiHttpBehavior(target, verificationSecret);
  console.log(`✅ OpenAPI WAF configuration and HTTP behavior verified for ${target.hostname}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  verifyDeployedOpenApiWaf().catch(error => {
    console.error("❌ OpenAPI WAF verification failed:", error);
    process.exitCode = 1;
  });
}
