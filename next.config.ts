import createNextIntlPlugin from 'next-intl/plugin'
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare'
import { resolve } from 'node:path'
import { createLocalWranglerConfig } from './scripts/deploy/local-wrangler-config'
import { assertSafeBuildEnv } from './scripts/deploy/validate-build-env'

assertSafeBuildEnv()

if (process.env.NODE_ENV === 'development') {
  const localWrangler = createLocalWranglerConfig(process.cwd())
  initOpenNextCloudflareForDev({
    configPath: localWrangler.configPath,
    envFiles: [],
    remoteBindings: false,
    persist: { path: localWrangler.proxyPersistPath },
  })
}

const withNextIntl = createNextIntlPlugin('./app/i18n/request.ts')

const nextConfig: import("next").NextConfig = {
  webpack(config, { dev }) {
    if (!dev) return config
    // Runtime output must not invalidate the compiler that produced it.
    // Keep test output out of the source watcher.
    const roots = ['.wrangler', '.test']
      .map(name => resolve(process.cwd(), name))
    const artifactPattern = roots.map(path => path.split(/[\\/]/)
      .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[\\\\/]')).join('|')
    const ignored = config.watchOptions?.ignored
    const runtimeIgnored = `^(?:${artifactPattern})(?:[\\\\/]|$)`
    config.watchOptions = {
      ...config.watchOptions,
      ignored: ignored instanceof RegExp
        ? new RegExp(`(?:${ignored.source})|(?:${runtimeIgnored})`, ignored.flags)
        : [
          ...(typeof ignored === 'string' ? [ignored] : ignored ?? []),
          ...roots.flatMap(path => {
            const normalized = path.replace(/\\/g, '/')
            return [normalized, `${normalized}/**`]
          }),
        ],
    }
    return config
  },
  async headers() {
    return [
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
      { source: "/:locale/(mailbox|moe|profile|shared)/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store" }, { key: "Service-Worker-Allowed", value: "/" }] },
    ]
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'avatars.githubusercontent.com',
      },
      {
        protocol: 'https',
        hostname: '*.googleusercontent.com',
      }
    ],
  },
};

export default withNextIntl(nextConfig)
