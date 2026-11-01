#!/usr/bin/env node
/**
 * 本地环境一键恢复脚本。
 *
 * 用途：在 `git clean -fdx` 之后重建完整的本地开发环境。该脚本只使用 Node
 * 内置模块，因此不依赖 node_modules，可以在依赖安装之前运行。
 *
 * 步骤：
 *   1. 校验 Node 版本
 *   2. npm ci 安装依赖
 *   3. 将本地配置统一到忽略的 .env.deploy
 *   4. 应用本地 D1 迁移
 *   5. 安装项目自带的 Playwright Chromium
 *   6. 写入本地 KV 的 EMAIL_DOMAINS 与 DEFAULT_ROLE
 *   7. 冒烟验证浏览器可启动
 *
 * 用法：
 *   node scripts/bootstrap-local.mjs [选项]
 *     --skip-install     跳过 npm ci
 *     --skip-browser     跳过 Chromium 安装与冒烟
 *     --domain <域名>    写入 KV 的邮件域名，默认 test.example.com
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import net from 'node:net'

const ROOT = process.cwd()
const isWindows = process.platform === 'win32'

function parseArgs(argv) {
  const flags = {}
  const positionals = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      flags[key] = next
      i += 1
    } else {
      flags[key] = true
    }
  }
  return { flags, positionals }
}

const { flags } = parseArgs(process.argv.slice(2))

let stepIndex = 0
function step(title) {
  stepIndex += 1
  console.log(`\n[${stepIndex}/7] ${title}`)
}

function ok(message) {
  console.log(`      ✓ ${message}`)
}

function warn(message) {
  console.log(`      ! ${message}`)
}

function die(message) {
  console.error(`\n恢复失败：${message}`)
  process.exit(1)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf-8',
    // Never use a shell for executable paths: on Windows the Node binary lives in
    // "C:\Program Files\..." and a shell would split it on the space.
    shell: options.shell === true,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: options.capture ? 'pipe' : 'inherit'
  })
  if (result.error) {
    die(`${command} 启动失败：${result.error.message}`)
  }
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  }
}

function npm(args, options = {}) {
  // Prefer the npm CLI script directly: `npm.cmd` needs a shell on Windows, and
  // passing arguments through a shell triggers Node's DEP0190 warning.
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(npmCli)) {
    return run(process.execPath, [npmCli, ...args], options)
  }
  return run(isWindows ? 'npm.cmd' : 'npm', args, { ...options, shell: true })
}

/**
 * 本机常见情况：HTTP_PROXY 指向一个已退出的本地代理，导致 Playwright 下载
 * Chromium 时报 ECONNREFUSED。这里探测代理端口是否可达，不可达就在下载时
 * 临时摘掉代理变量，而不是修改用户的全局环境。
 */
function proxyIsReachable(env) {
  const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy
  if (!raw) return null
  let parsed
  try {
    parsed = new URL(raw.includes('://') ? raw : `http://${raw}`)
  } catch {
    return null
  }
  const host = parsed.hostname
  const port = Number(parsed.port || 8080)
  if (!host || Number.isNaN(port)) return null

  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(2000)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function main() {
  console.log('NextMail 本地环境恢复')
  console.log('=======================')

  if (flags['force-env']) die('--force-env 已移除；本地配置只通过 .env.deploy 维护。')

  step('校验 Node 版本')
  const major = Number(process.versions.node.split('.')[0])
  if (major < 24) die(`需要 Node.js 24 或更高版本，当前为 ${process.versions.node}`)
  ok(`Node.js ${process.versions.node}`)

  step('安装依赖')
  if (flags['skip-install']) {
    warn('按要求跳过 npm ci')
  } else {
    const result = npm(['ci'], { capture: true })
    if (result.code !== 0) {
      console.error(result.stdout.slice(-2000))
      console.error(result.stderr.slice(-2000))
      die('npm ci 失败')
    }
    ok('依赖安装完成')
  }

  step('统一本地配置')
  const config = npm(['run', 'config:migrate-local'], { capture: true })
  if (config.code !== 0) {
    console.error(config.stdout.slice(-2000))
    console.error(config.stderr.slice(-2000))
    die('本地配置迁移失败')
  }
  if (config.stdout) process.stdout.write(config.stdout)
  ok('本地配置已使用 .env.deploy')

  const domain = typeof flags.domain === 'string' ? flags.domain : 'test.example.com'

  step('应用本地 D1 迁移')
  const migrate = npm(['run', 'db:migrate-local'], { capture: true })
  if (migrate.code !== 0) {
    console.error(migrate.stdout.slice(-2000))
    console.error(migrate.stderr.slice(-2000))
    die('本地迁移失败')
  }
  ok('本地数据库结构已就绪')

  step('安装 Playwright Chromium')
  if (flags['skip-browser']) {
    warn('按要求跳过浏览器安装')
  } else {
    const cliPath = join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js')
    if (!existsSync(cliPath)) die('未找到 node_modules/@playwright/test/cli.js，请先完成 npm ci')

    const reachable = await proxyIsReachable(process.env)
    const env = {}
    if (reachable === false) {
      warn('检测到不可用的代理，已在本次下载中临时移除代理变量')
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) env[key] = ''
    }

    const install = run(process.execPath, [cliPath, 'install', 'chromium'], { capture: true, env })
    if (install.code !== 0) {
      console.error(install.stdout.slice(-2000))
      console.error(install.stderr.slice(-2000))
      die('Chromium 下载失败')
    }
    ok('项目自带 Chromium 已安装')
  }

  step('写入本地 KV 配置')
  const wranglerBin = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  if (!existsSync(wranglerBin)) die('未找到 node_modules/wrangler/bin/wrangler.js，请先完成 npm ci')

  const kvWrites = [
    ['EMAIL_DOMAINS', domain],
    // 新注册用户默认拿这个角色。civilian 没有任何权限，会看到"等待角色分配"；
    // duke 有 manage_email 与 manage_api_key，又不会触发皇帝认领流程。
    ['DEFAULT_ROLE', 'duke']
  ]

  for (const [key, value] of kvWrites) {
    const kv = run(
      process.execPath,
      [
        wranglerBin,
        'kv', 'key', 'put', key, value,
        '--binding', 'SITE_CONFIG',
        '--local',
        '--persist-to', join(ROOT, '.wrangler', 'state')
      ],
      { capture: true }
    )
    if (kv.code !== 0) {
      console.error(kv.stdout.slice(-2000))
      console.error(kv.stderr.slice(-2000))
      die(`写入本地 KV ${key} 失败`)
    }
    ok(`${key} = ${value}`)
  }

  step('冒烟验证浏览器')
  if (flags['skip-browser']) {
    warn('按要求跳过冒烟验证')
  } else {
    const { chromium } = await import('playwright')
    let browser
    try {
      browser = await chromium.launch()
      const version = browser.version()
      ok(`Chromium ${version} 启动成功`)
    } catch (error) {
      die(`Chromium 启动失败：${error.message}`)
    } finally {
      if (browser) await browser.close()
    }
  }

  console.log('\n=======================')
  console.log('本地环境已恢复，可以开始开发：')
  console.log('  npm run dev            启动开发服务器')
  console.log('  npm test               Node 单元与路由测试')
  console.log('  npm run test:browser   浏览器测试（需要 dev server）')
  console.log('  npm run agent:status   查看自我迭代队列状态')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
