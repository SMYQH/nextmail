# NextMail 部署说明

<a id="runtime-requirements"></a>

## 运行时要求

OpenNext 应用运行在 Cloudflare Workers。主 Worker 使用 `nodejs_compat`、`nodejs_compat_populate_process_env` 和 `global_fetch_strictly_public` 兼容性标志，兼容性日期为 `2025-04-01` 或更新日期。`process.env` 中的认证密钥和 OAuth 配置依赖前两个标志。请勿在应用路由中添加 Next.js `runtime = "edge"`；OpenNext 使用 Node.js 兼容运行时。请参阅 [Cloudflare Node.js 兼容性文档](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)。

**此版本建议应用 Worker 使用 Cloudflare Workers 付费方案。** 在运行本地部署脚本或 GitHub Actions 之前，建议在部署账户上启用该方案。仅购买付费域名或网站套餐无法满足此要求；部署脚本不会自动购买或升级方案。

- 原因：注册、密码登录以及旧版密码升级流程均使用 bcrypt 算法。异步 bcrypt 操作仍会消耗 CPU 资源，并可能超过 Workers 免费版每请求 10 毫秒的限制；但请勿为了适应免费版限制而降低 bcrypt 的计算强度。请参阅 [Workers CPU 限制](https://developers.cloudflare.com/workers/platform/limits/#cpu-time) 和 [Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)。
- 本项目不会执行 Cloudflare 的 CPU 限制检查。请自行配置。
- 当然，如果您仅个人使用，或只使用 OAuth 登录，则可忽略上述内容。

## 部署

在 Linux（包括 GitHub Actions）或 WSL 内部使用 Linux Node.js 24 和全新的 `npm ci` 构建 OpenNext Worker。不要复用 Windows 的 `node_modules`。OpenNext 目前会警告 Windows 构建不受完整支持；`npm run build:worker` 会生成 Worker 并检查 `.open-next/worker.js`、静态资源目录、D1/KV 绑定和运行时标志。在 Windows 上，Next.js 开发、lint 和单元测试仍然可用。

当前使用 Next.js `16.4.3` 和 OpenNext `1.20.6`，属于[适配器支持范围](https://opennext.js.org/cloudflare#supported-nextjs-versions)。Next.js 14 已不在[官方支持范围](https://nextjs.org/support-policy)内，不通过降级到 14 或跳过支持检查来解决版本问题。`npm run build` 成功仍不能代替 Worker 构建和运行时验证。

每次生产构建会先通过 `prebuild` 删除旧 `.next` 产物及 `tsconfig.tsbuildinfo`，再重新生成 Next.js 路由类型，避免复用不完整的类型和增量缓存。部署前请停止本地开发服务器，顺序运行验证命令，不要并行执行 `npm run build`、`npm run build:worker` 或多个部署进程；它们共享 `.next` 目录。出现 `.next/types/... not found` 时无需创建占位类型文件或关闭类型检查，先确认没有其他构建或开发进程，再重新运行构建。

### 本地部署脚本

1. 复制 `../.env.deploy.example` 为仓库根目录被忽略的 `.env.deploy` 并填写[环境变量](#环境变量)。开发、构建、本地预览及部署只使用此文件和进程环境；不要创建 `.env`、`.env.local` 或 `.dev.vars`。旧配置先合并到 `.env.deploy`，核对冲突后移除旧文件。示例的必填项在前，所有可选项在后；不填写可选后台设置时保留已有值。Worker 绑定配置来自仓库中的 `wrangler.example.json`、`wrangler.email.example.json` 和 `wrangler.cleanup.example.json` 模板；`wrangler.json`、`wrangler.email.json` 和 `wrangler.cleanup.json` 是被忽略的本地生成文件，部署、构建和迁移命令会自动重新生成，不要提交它们。
2. `.env.deploy` 中的 Cloudflare API Token 需要具备下文列出的[最小部署权限](#cloudflare-api-token-权限)。设置 `CUSTOM_DOMAIN` 时，还必须设置独立的 `OPENAPI_WAF_VERIFY_SECRET`。`npm run deploy` 会在构建前验证 Token 状态、WAF 和 Bot Management 读取权限，并检查标准 Bot Fight Mode；检查失败时不会开始构建或更改远程资源。
3. 如需同时配置 GitHub Actions，在 `.env.deploy` 中填写 `REPOSITORY_URL` 和 `GITHUB_TOKEN`；留空任意一项则跳过同步。
4. 运行部署脚本：
```bash
npm run deploy
```

脚本先校验显式配置、验证 Cloudflare Token，并只读检查 D1、KV、Workers Scripts、Zone 与 Email Routing Rules。设置 `CUSTOM_DOMAIN` 时，还检查当前目标 Zone 的 Worker Routes、WAF Rulesets 和 Bot Management；标准 Bot Fight Mode 已启用时在构建前停止。预检不要求访问将被替换的旧路由 Zone；留空自定义域名则使用 `workers.dev`，不配置 Zone WAF。Token 或读取权限失败时，不开始构建或远程写入。

确认 `EMAIL_DOMAIN` 与目标 Zone 同名后，脚本更新本地 Worker 暴露配置（写入被忽略的生成文件 `wrangler.json`），执行 `npm run build:worker` 和 `npx wrangler deploy --dry-run --config wrangler.json`。构建与打包成功后，解析或创建项目 D1、检查已有启用的 Webhook、配置项目 WAF，然后解析或创建项目 KV，在选定 namespace 应用显式网站设置并初始化缺失的接收域名。接着执行远程迁移及一次性角色回填，应用可选账号和 Catch-all 邮箱设置，再同步 GitHub Secrets。

首次主 Worker 发布先保持私有，安装认证和 Webhook Secrets 后再开放 `workers.dev` 或 Custom Domain；升级先更新 Secrets 再发布。随后发布 Email Worker 和 Cleanup Worker，按 Zone 记录旧 Catch All 后将其指向邮件接收 Worker。自定义域名最后检查 `/api/config`、`/api/emails` 和 `/en`，确认没有 Cloudflare 挑战、未认证 API 返回预期 JSON 401、前端返回 HTML。`npm run verify:waf` 可重复只读检查。迁移、KV、账号、WAF、Secrets 和各 Worker 发布不是整体事务；任何阶段失败都可能留下先前已完成的更改，应检查状态后再重试。

常规 OpenAPI Skip 规则只匹配 `CUSTOM_DOMAIN` 主机，以及 `/api/config` 和 `/api/emails` 路径。单独的部署验证规则匹配该主机上带有验证请求头的所有路径，以便自动化前端检查加载页面及其资源。部署会把两条自有规则放到 Zone 自定义规则入口最前方，并保留其他规则的 ID 和相对顺序；命中 Skip 规则的请求会停止执行后续 Zone 自定义规则，并跳过 Cloudflare 托管 WAF、Super Bot Fight Mode，以及 Browser Integrity Check、Security Level、User Agent Blocking、Zone Lockdown、Hotlink Protection 和旧版 Managed Rules。规则不会跳过 Cloudflare Rate Limiting 阶段或旧版 Rate Limiting；因此已有速率限制仍会执行，超过限制时其配置的 block 或 challenge 动作仍可能生效。应用 API Key、会话和权限检查也继续执行，部署验证会确认无凭据请求得到 NextMail 的 JSON `401`。

标准 Bot Fight Mode 无法通过自定义规则绕过，检测到启用时部署会失败。Zone IP Access Rules 中的 Block、Cloudflare Access、先于 Zone 规则执行的账户级动作等其他策略也不由此配置修改或绕过。真实 HTTP 验证覆盖当前部署执行者到 `/api/config`、`/api/emails` 和 `/en` 的请求路径，不保证其他来源或策略下的所有请求都可访问；若检查遇到挑战、重定向或非预期响应会失败。若只使用 `workers.dev`，该主机不属于用户管理的 Zone，项目无法自动安装 Zone WAF 规则，也无法执行此 HTTP 验证。

为自定义域名部署生成一个仅用于部署和自动化前端验证的随机值，例如 `openssl rand -hex 32`，并保存到 `.env.deploy` 的 `OPENAPI_WAF_VERIFY_SECRET` 或 GitHub Actions Secret。同名 Cloudflare Skip 规则会在该项目主机上匹配验证请求头；自动化浏览器测试可为页面及资源请求设置 `x-nextmail-waf-verify` 请求头。该变量不会传给 Worker，也不会进入 OpenNext 应用环境文件、构建产物或子进程环境。拥有目标 Zone WAF 读取权限的人员可查看规则表达式并取得此值，因此它不能代替应用身份验证。请使用与 `AUTH_SECRET` 不同的值。部署结束后可运行：

```bash
npm run verify:waf
```

预检同时支持用户令牌和账户令牌：先调用用户验证接口；若该接口拒绝令牌，再调用目标账户的 [Token 验证接口](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/verify/)。两种令牌都必须处于有效期内且状态为 `active`。

Cloudflare 的 Token 验证接口只返回 Token 状态，不会返回已分配的权限策略。因此部署前的资源权限检查使用只读 API 请求确认相应账户和 Zone 范围可访问；它不会创建临时资源来试写权限。后续写操作仍需具备本节列出的 `Edit` 权限，Cloudflare 若拒绝写操作，部署可能在已经完成的远程步骤之后中止。

迁移 `0007_careless_sentinel` 会把旧 `credential` 表中的用户名和密码哈希复制到 `user` 表后再删除旧表。这个保护适用于尚未应用迁移 0007 的数据库；如果远程数据库已记录 0007 为已完成，部署脚本无法从已删除的表中恢复凭据，发布前需单独确认该数据库的用户登录恢复方案。

迁移脚本为升级时没有角色的账号执行一次默认角色回填，并在数据库中记录完成状态。远程迁移设置 `KV_NAMESPACE_ID` 时先验证其属于项目 `nextmail-kv`，不使用过时绑定；验证失败会停止回填。完整部署若刚写入显式 `DEFAULT_ROLE`，回填使用本次已应用的值，避免 KV 传播延迟读到旧角色；否则从选定 namespace 读取。独立本地迁移仅使用本地绑定。后续部署不会重新授予已撤销的角色；配置缺失、无法读取或无效时跳过且不记录完成。

同时配置了 GitHub 仓库 URL 和令牌时，本地部署会把 `.env.deploy` 的配置加密写入该仓库的 **Actions 仓库级 Secrets**。`GITHUB_TOKEN` 和 `REPOSITORY_URL` 仅用于本地同步，不会上传。空值也会同步，以覆盖过期配置；删除 `.env.deploy` 中的某项不会自动删除远程同名 Secret。同步失败会停止部署，不会把明文写入日志。支持 `https://github.com/OWNER/REPO`、其 `.git` 形式和 `git@github.com:OWNER/REPO.git`。请使用仅限目标仓库、具有仓库 `Secrets: Read and write` 权限的 fine-grained personal access token；classic token 需 `repo` scope。令牌只保存在被忽略的本地 `.env.deploy` 中。

如果 `production` 环境中已有同名 Environment Secrets，工作流会优先使用这些值；请同步更新或删除冲突的环境级配置。

### Cloudflare API Token 权限

将令牌的账户资源限定为 NextMail 使用的 Cloudflare 账户。邮件路由权限限定为 `EMAIL_DOMAIN` 对应的 Zone；设置 `CUSTOM_DOMAIN` 时，网站路由权限限定为该主机所属的 Zone。两者可能不同。部署所需权限如下：

| 范围 | 权限 |
| --- | --- |
| 账户 | `D1: Edit`、`Workers KV Storage: Edit`、`Workers Scripts: Edit` |
| `EMAIL_DOMAIN` 所属区域 | `Zone: Read`、`Email Routing Rules: Edit` |
| `CUSTOM_DOMAIN` 所属区域（设置时） | `Zone: Read`、`Workers Routes: Edit`、`WAF: Edit`、`Bot Management: Read` |

当前项目不需要 `Cloudflare Pages: Edit`、`Zone Settings: Read/Edit`、`DNS: Edit`、`API Tokens: Edit` 或 `Email Routing Addresses: Edit`。WAF 和 Bot Management API 的只读预检会在构建前检查对应 Zone 的可访问性；Cloudflare Token 验证接口不会返回权限策略，因此无法单独证明 `WAF: Edit`。部署会在构建完成并检查数据库与 Webhook 后、数据库迁移前，通过实际更新项目规则确认该写权限。

若通过 API 创建账户部署令牌，使用单独具备 `Account API Tokens: Edit` 权限的引导令牌，按上述权限创建部署令牌后，将新令牌保存到被忽略的 `.env.deploy`。部署令牌本身不需要令牌管理权限。API 权限组名称中的 `Write` 对应控制台的 `Edit`；请从目标账户的权限组接口获取 ID，不要根据名称猜测或复用其他权限组 ID。

### 清理 Cloudflare 部署

在确认要删除 NextMail 的 Cloudflare 资源及 D1 数据后，在仓库根目录运行：

```bash
npm run delete
```

命令从 `.env.deploy` 和进程环境读取 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`、`EMAIL_DOMAIN`；如果自定义域名路由曾部署过，保留对应的 `CUSTOM_DOMAIN` 或生成的 `wrangler.json` 中的路由配置。脚本会先验证 Token，并在进行任何删除前列出将处理的资源。D1/KV 的显式 ID 若仍存在，必须分别指向名称为 `nextmail-d1` 和 `nextmail-kv` 的项目资源，否则会停止；已不存在的 ID 会按已清理资源跳过。

清理范围仅限 `nextmail`、`email-receiver-worker`、`cleanup-worker` 三个 Worker，项目配置中指向 `nextmail` 的精确路由、名称为 `nextmail-kv` 的 KV namespace、名称为 `nextmail-d1` 的 D1 数据库，以及仍将邮件转发到 `email-receiver-worker` 的 `EMAIL_DOMAIN` Catch All。D1 数据库删除会移除其中的应用数据；执行前请先备份。部署覆盖 Catch All 前会在项目 KV 中按 Zone 保存原规则，原先不存在规则时也会记录该状态；后续部署保留首次记录，不把 NextMail 自身的收件规则作为原规则。清理时仅在当前 Catch All 仍指向 NextMail Worker 时恢复同一 Zone 的原规则；原先不存在规则、升级前未备份或备份无法确认所属 Zone 时，将当前规则禁用。旧版不含 Zone 信息的备份不会跨 Zone 恢复，已覆盖且未保存的旧配置无法找回。

脚本不会删除 Cloudflare Zone 或直接调用 DNS API，也不会修改 GitHub 仓库、Actions Secrets、OAuth 应用、本地 `.env.deploy` 或 Wrangler 配置。Worker Custom Domain 的 DNS 和证书由 Cloudflare 托管；再次部署会按 `CUSTOM_DOMAIN` 建立关联。清理后，被忽略的生成文件 `wrangler.json` 仍保留上次部署的资源 ID 和路由；仓库中只保留不含资源 ID 的 `wrangler.example.json` 模板；再次部署时若显式设置的 `DATABASE_ID` 或 `KV_NAMESPACE_ID` 指向已删除资源，需要先清除或更新这些覆盖值。该流程不是原子操作；若 Cloudflare API 在部分删除后失败，可以再次运行，已不存在的 Worker、路由或资源会被跳过。

### Github Actions 部署

本项目可使用 GitHub Actions 调用同一部署命令。支持以下触发方式：

1. **自动触发**：推送新的 tag 时自动触发部署流程
2. **手动触发**：在 GitHub Actions 页面手动触发

#### 部署步骤

1. 通过上述本地部署自动同步，或手动在 GitHub Actions 仓库级 Secrets 中配置认证、Cloudflare 凭据及部署参数。工作流仅从 Secrets 读取这些值；CI 不需要也不会读取 `.env.deploy`。workflow 执行检查后运行 `npm run deploy`。

2. 选择触发方式：

   **方式一：推送 tag 触发**
   ```bash
   # 创建新的 tag
   git tag v1.0.0

   # 推送 tag 到远程仓库
   git push origin v1.0.0
   ```

   **方式二：手动触发**
   - 进入仓库的 Actions 页面
   - 选择 "Deploy" workflow
   - 点击 "Run workflow"

3. 部署进度可以在仓库的 Actions 标签页查看

#### 注意事项
- CI 不需要 `.env.deploy`。在首次触发 Actions 前，请确认仓库 Secrets 已配置，至少包括 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`、`AUTH_SECRET`、`EMAIL_DOMAIN` 和 `NEXT_PUBLIC_BASE_URL`。
- `DATABASE_ID`、`KV_NAMESPACE_ID`、`CUSTOM_DOMAIN`、`OPENAPI_WAF_VERIFY_SECRET`、`EMAIL_DOMAIN`、`WEBHOOK_ALLOWED_HOSTS` 和 `NEXT_PUBLIC_BASE_URL` 也从 Actions Secrets 读取；此前只配置在 Actions Variables 中的值需要迁移。
- 本文列出的可选后台设置及 `ADMIN_USERS` 同样通过同名 Actions Secrets 传入；只更新本地文件不会改变尚未同步的 CI 配置。
- 使用 tag 触发时，tag 必须以 `v` 开头（例如：v1.0.0）。


## 环境变量

本项目使用以下环境变量：

### 认证相关
- `AUTH_GITHUB_ID`: GitHub OAuth App ID
- `AUTH_GITHUB_SECRET`: GitHub OAuth App Secret
- `AUTH_GOOGLE_ID`: Google OAuth App ID
- `AUTH_GOOGLE_SECRET`: Google OAuth App Secret
- `AUTH_SECRET`: NextAuth Secret，用来加密 session，请设置一个随机字符串

GitHub 和 Google 登录均为可选项。每个登录方式只有在其 ID 和 Secret 都已填写且非空时才会启用，并在登录页显示。
- `NEXT_PUBLIC_BASE_URL`: 必填，应用公开基础 URL；请设置为实际 Worker 地址或 `CUSTOM_DOMAIN`，用于生成正确的 canonical 与 hreflang 链接。该值在构建时写入应用，缺失时部署脚本会在构建前终止；OAuth 回调地址由请求地址推导，不使用该变量

### Cloudflare 配置
- `CLOUDFLARE_API_TOKEN`：Cloudflare API Token；按[最小部署权限](#cloudflare-api-token-权限)配置，自动设置 Catch All 需要目标 Zone 的 `Email Routing Rules: Edit` 权限。
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare Account ID
- 自动发现或新建 D1 时使用名称 `nextmail-d1`。
- `DATABASE_ID`: 可选，手动指定账户中 `nextmail-d1` 的数据库 ID；未设置时按名称查找或创建。脚本会校验该 ID 对应数据库的名称必须是 `nextmail-d1`，否则在写入 Wrangler 配置前停止。
- Cloudflare KV namespace 名称固定为 `nextmail-kv`，用于存储网站配置。
- `KV_NAMESPACE_ID`: Cloudflare KV namespace ID，用于存储网站配置 （可选， 如果不填, 则会自动通过 Cloudflare API 获取）。脚本会校验该 ID 对应命名空间的标题必须是 `nextmail-kv`，否则在写入 Wrangler 配置前停止。
- `CUSTOM_DOMAIN`: 网站自定义主机名，例如 `app.example.com`（可选）；必须属于此 Cloudflare 账号管理的 Zone。部署脚本使用 Worker Custom Domain，由 Cloudflare 自动配置 DNS 和证书，无需预先创建代理 DNS 记录；留空时启用 `workers.dev` 地址。此主机名应专供当前应用使用，部署会将它绑定到 NextMail；`pages.dev` 不属于你的 Zone，不能作为此项。
- `OPENAPI_WAF_VERIFY_SECRET`: 设置 `CUSTOM_DOMAIN` 时必填，32–128 位 URL-safe 随机值，供部署脚本和自动化浏览器通过验证请求头访问项目页面、资源和 API；存放在 `.env.deploy` 或 GitHub Actions Secret 中。它不会进入 Worker 环境或应用构建文件，但会出现在 Cloudflare WAF 规则表达式中。

`.env.deploy` 仅由配置入口读取到进程环境；不会生成应用 `.env` 或 `.dev.vars`。构建拒绝旧的应用环境文件，并只公开允许的 `NEXT_PUBLIC_` 配置。认证和 OAuth 值通过 Worker Secrets 单独安装，Cloudflare 部署令牌、账号初始化 JSON、Resend Key 及 Turnstile Secret 不应进入可下载的 Worker 构建文件。构建并不自动发布或应用远程配置。
- `EMAIL_DOMAIN`: 收件邮箱域名，例如 `example.com`；必须与此 Cloudflare 账号中匹配到的 Zone 名称完全一致。部署脚本会配置该 Zone 的 Catch All；若填写的子域名只匹配到父 Zone，脚本会在数据库修改和发布前停止，避免更改父域的 Catch All。使用子域名收信时，先完成 [Email Routing 子域名配置](https://developers.cloudflare.com/email-service/configuration/subdomains/)，并确认该子域名能匹配到独立的同名 Zone。

从旧版普通 Worker Route 升级时，确认 Custom Domain 绑定成功后，在 Cloudflare 中移除同一主机名、指向 `nextmail` 的旧 `HOST/*` Route。Wrangler 发布 Custom Domain 后可能仍保留旧 Route；其他主机或其他 Worker 的路由应保留。

### GitHub 同步配置

- `REPOSITORY_URL`：目标 GitHub 仓库 URL（可选；必须与 `GITHUB_TOKEN` 同时填写）。
- `GITHUB_TOKEN`：具有目标仓库 `Secrets: Read and write` 权限的 GitHub 令牌（可选；仅用于本地同步，不发送到 Actions Secrets）。

## 部署时初始化后台设置

以下变量均位于 `../.env.deploy.example` 的可选项部分。本地完整部署读取 `.env.deploy`；GitHub Actions 使用同名 Secrets。未设置或空字符串保留已有后台值；填写的值在每次完整部署时应用，因此需要保留浏览器后续修改时，应清空对应部署覆盖项。仅执行构建或单独发布 Worker 不会应用这些配置。

| 变量 | 对应后台功能 / 格式 |
| --- | --- |
| `DEFAULT_ROLE` | 注册默认角色，`civilian`、`knight` 或 `duke`，不能设为皇帝 |
| `EMAIL_DOMAINS` | 接收域名，逗号分隔；首次未填写时从必填 `EMAIL_DOMAIN` 初始化 |
| `ADMIN_CONTACT` | 管理员联系方式 |
| `MAX_EMAILS` | 非皇帝账号的活跃邮箱上限，正安全整数 |
| `TURNSTILE_ENABLED` | `true` 或 `false`；启用时需有效的下述两个 Key |
| `TURNSTILE_SITE_KEY`、`TURNSTILE_SECRET_KEY` | 人机验证公开 Key 和服务端 Secret；空值保留已有 Key |
| `RESEND_CONFIG` | JSON：按接收域名配置 `{ "enabled": true, "apiKey": "..." }`；启用必须提供 Key |
| `EMAIL_ROLE_LIMITS` | JSON：`{"duke":5,"knight":2}`；`-1` 禁止、`0` 不限、正整数限制每天封数 |
| `CATCHALL_EMAIL` | JSON：每个接收域名配置 `{ "address": "catch@example.com", "enabled": true, "showAlways": true }`；包含全部域名，`{}` 可清空配置 |
| `CATCHALL_OWNER_USERNAME` | 可选校验 Catch-all 所有者用户名；所有者必须是站点唯一皇帝 |
| `ADMIN_USERS` | 可选账号初始化/更新 JSON 数组，见下文 |

Catch-all 需要已有皇帝账号，或在同次部署通过 `ADMIN_USERS` 创建皇帝。重新部署、改名和 KV 写入失败后重试会保留邮箱身份及邮件；与其他邮箱地址冲突时停止。后台邮箱设置、账号写入、KV、迁移和发布并非整体事务；若中途失败，应先检查已完成的阶段。

### 可选账号初始化

示例仅说明格式，替换所有密码和 Key；不要将实际值提交到 Git：

```dotenv
ADMIN_USERS='[{"username":"admin","password":"replace-with-a-strong-password","name":"Administrator","role":"emperor"},{"username":"automation","password":"replace-with-another-password","role":"duke","allowedDomains":["example.com"],"apiKeys":[{"name":"automation","key":"replace-with-a-long-random-key","enabled":true}],"webhook":{"url":"https://hooks.example.org/mail","secret":"replace-with-signing-secret","enabled":false}}]'
```

- 最多配置 100 个账号和合计 500 个 API Key。新账号必须有符合注册规则的用户名和至少 8 位密码；密码使用应用同一算法保存。新账号未指定角色时为平民。已有 OAuth 身份不能用此选项改成密码账号。
- 用户名定位已有密码账号；仅更新明确提供的字段，省略或空字符串保留原值，不删除未列出的账号或 Key。配置仍保留密码或角色时，后续部署会继续应用这些覆盖值。
- `role` 可为 `emperor`、`duke`、`knight`、`civilian`。站点仍只能有一个皇帝，不能降级现有皇帝；需要创建皇帝时请明确指定。
- `allowedDomains` 省略保留原值，`null` 表示无单独限制，`[]` 禁止全部域名；非空数组只能使用站点接收域名，不能限制皇帝。
- `apiKeys` 按当前用户的名称更新；新增必须提供 `key`，仅有 API Key 管理权限的角色可配置。`expiresAt` 为 ISO 时间，省略保留已有有效期；新 Key 默认有效一年，不能填 `null`。完整 Key 可在该账号后台明文查看，用户已接受此行为。
- `webhook` 支持 `url`、`secret`、`enabled`。启用或设置目标时必须满足 `WEBHOOK_ALLOWED_HOSTS` 和角色权限；部署不会发送测试 Webhook 或邮件。

除上述覆盖设置外，分享链接、收发邮件等用户业务数据仍通过应用管理，不在部署时伪造历史记录。

<a id="webhook-setup"></a>

## Webhook 配置

`WEBHOOK_ALLOWED_HOSTS` 是启用 Webhook 投递的必要条件。设置一个逗号分隔的精确、受信任运营方批准的公开主机名列表，不包含协议、路径、端口或通配符。例如：

```dotenv
WEBHOOK_ALLOWED_HOSTS="hooks.example.com,notifications.example.com"
```

在根目录 `.env.deploy` 中设置此变量，或在 GitHub Actions 中以同名 Secret 设置。`npm run deploy` 将白名单分别安装到主应用 Worker 和 Email Worker；本地开发及预览同样使用 `.env.deploy`，无需 `.dev.vars`。单独运行某个组件的发布命令不会执行完整部署的设置同步；请先使用完整部署安装 Secrets 和后台设置。

升级前，请复核已启用的 Webhook 目标，并只批准受信任运营方控制的主机。部署会在迁移或发布前检查这些目标，如果任何目标会被阻止则停止。它永远不会自动批准已保存的用户 URL。如果没有启用任何 Webhook，允许为空；个人页面会说明站点管理员必须先完成设置，然后才能启用 Webhook。在设置未完成时，仍然可以禁用现有 Webhook。

部署完成后，在已批准的主机上保存一个 HTTPS Webhook URL，并在个人页面中使用 **Test**。未批准的主机、重定向、非 HTTPS URL、凭据、片段和非标准端口都会被阻止。`GET /api/webhook` 只返回是否配置了签名密钥，不返回密钥本身；请在部署配置或保存时自行保管。验证 `X-Webhook-Signature` 为 `sha256=` 后接 `X-Webhook-Timestamp + "." + raw request body` 的十六进制 HMAC-SHA256 值，并拒绝过期时间戳以防止重放攻击。

## Github OAuth App 配置

1. 登录 [Github Developer](https://github.com/settings/developers) 创建一个新的 OAuth App
2. 生成一个新的 `Client ID` 和 `Client Secret`
3. 配置参数：
   - `Application name`: `<your-app-name>`
   - `Homepage URL`: `https://<your-app-host>`
   - `Authorization callback URL`: `https://<your-app-host>/api/auth/callback/github`

## Google OAuth App 配置

1. 访问 [Google Cloud Console](https://console.cloud.google.com/) 创建项目
2. 配置 OAuth 同意屏幕
3. 创建 OAuth 客户端 ID
   - 应用类型：Web 应用
   - 已获授权的 Javascript 来源：`https://<your-app-host>`
   - 已获授权的重定向 URI：`https://<your-app-host>/api/auth/callback/google`
4. 获取 `Client ID` 和 `Client Secret`
5. 配置环境变量 `AUTH_GOOGLE_ID` 和 `AUTH_GOOGLE_SECRET`

首次完整部署会从 `EMAIL_DOMAIN` 初始化缺失的 `EMAIL_DOMAINS`，也可用可选变量显式设置多个域名。升级时未填写覆盖值则保留后台设置。仅手动发布组件、未初始化 KV 时，域名列表仍可能为空并使创建邮箱返回 503；网站域名不能作为默认接收域名。

### 多域名 Catch-all 配置

主应用与邮件接收 Worker 必须绑定同一个 `SITE_CONFIG` KV namespace。完整部署脚本会同步两个生成文件中的绑定；手动部署前先运行 `npm run config:wrangler` 生成本地配置，再同时检查 `./wrangler.json` 和 `./wrangler.email.json`。每个接收域名均需在 Cloudflare Email Routing 中将邮件交给邮件接收 Worker；完整部署只自动配置 `EMAIL_DOMAIN` 对应的 Zone，其余域名需单独配置。

升级前先备份 D1。新增迁移 `./drizzle/0020_user_email_domain_access.sql`、`./drizzle/0021_message_read_tracking.sql` 和 `./drizzle/0022_stable_mail_delivery.sql`，分别保存用户域名权限、邮件已读状态，以及 Catch-all 固定邮箱关联与邮件写入序号。0022 为现有邮件回填序号，并用触发器记录所有后续插入，因此升级耗时与已有邮件数量有关。它不删除邮件或修改邮件时间。部署新版应用前必须应用迁移，再同步发布邮件接收 Worker。旧时间游标在新版接口上会重放一次元数据，客户端按 ID 去重。

后续迁移 `../drizzle/0023_webhook_user_unique.sql` 约束每个用户只有一个 Webhook，`../drizzle/0024_message_delivery_key.sql` 添加收信去重键，`../drizzle/0025_expiry_cleanup_indexes.sql` 和 `../drizzle/0026_mailbox_created_at_index.sql` 添加清理及邮箱分页索引。升级前应检查实际待执行 SQL；Node 测试通过不能代替远程 D1 迁移或真实 SMTP 验证。

手动升级时，先应用迁移，再发布新版邮件接收 Worker，最后发布主应用。完整部署脚本会先发布主应用、再发布邮件接收 Worker；使用完整脚本时，须等待两个 Worker 都更新成功后再修改 Catch-all 前缀。
