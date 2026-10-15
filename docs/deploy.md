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

### 本地部署脚本

1. 复制 `.env.deploy.example` 为 `.env.deploy` 并填写[环境变量](#环境变量)。`.env.deploy` 已被 Git 忽略，本地部署从此文件读取部署配置，也兼容读取 `.env` 中的应用配置。OpenNext 会把应用 `.env*` 编译进 Worker，因此部署令牌只能放在 `.env.deploy` 或进程环境中；构建会拒绝应用环境文件中的部署令牌。旧配置请将部署参数移入 `.env.deploy`。
2. `.env.deploy` 中的 Cloudflare API Token 需要具备下文列出的[最小部署权限](#cloudflare-api-token-权限)。`npm run deploy` 会在构建前验证 Token 状态，并对所需账户和 Zone API 执行只读访问检查；检查失败时不会开始构建或更改远程资源。
3. 如需同时配置 GitHub Actions，在 `.env.deploy` 中填写 `REPOSITORY_URL` 和 `GITHUB_TOKEN`；留空任意一项则跳过同步。
4. 运行部署脚本：
```bash
npm run deploy
```

脚本首先调用 Cloudflare Token 验证接口，并只读检查 D1、KV、Workers Scripts、Zone、Email Routing Rules；设置 `CUSTOM_DOMAIN` 时，也会检查该域名对应 Zone 的 Worker Routes。部署预检仅按本次环境配置确定目标 Zone，不要求访问 `wrangler.json` 中将被替换或移除的旧路由所属 Zone；留空 `CUSTOM_DOMAIN` 时使用 `workers.dev`。若 Token 无效或资源访问检查失败，流程会在构建、迁移及任何 Cloudflare 写操作之前停止。随后脚本验证 `EMAIL_DOMAIN` 是同名 Zone 的顶级域，读取主 Worker 是否已存在，更新本地 Worker 暴露配置，运行 `npm run build:worker`，再运行 `npx wrangler deploy --dry-run --config wrangler.json` 检查 Worker 打包，而不发布到 Cloudflare。构建、产物检查和 Wrangler 打包成功后，脚本才会解析 `DATABASE_ID` 指定的数据库（未指定时检查或创建 `nextmail-d1`）、检查已启用的 Webhook，并执行远程数据库迁移。迁移后，脚本会解析 KV、同步可选的 GitHub Secrets，并部署主 Worker；远程迁移与后续 KV、Secrets、Worker 发布并非原子操作，Cloudflare API 或发布失败仍可能需要运维恢复。首次部署会先创建没有公开路由的 Worker，再安装认证密钥和 Webhook 白名单，然后设置 `workers.dev` 或 `CUSTOM_DOMAIN` 路由并发布同一份构建产物。之后部署 Email Worker 和 Cleanup Worker；全部成功后，脚本会使用已验证的 `EMAIL_DOMAIN` Zone 配置 Catch All，将邮件转发到 `email-receiver-worker`。脚本会修改三个 Wrangler 配置中的 `database_id`，以及主应用与邮件接收 Worker 的 `SITE_CONFIG` KV ID 和主应用路由；请在执行前确认这些文件可以被写入。

预检同时支持用户令牌和账户令牌：先调用用户验证接口；若该接口拒绝令牌，再调用目标账户的 [Token 验证接口](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/verify/)。两种令牌都必须处于有效期内且状态为 `active`。

Cloudflare 的 Token 验证接口只返回 Token 状态，不会返回已分配的权限策略。因此部署前的资源权限检查使用只读 API 请求确认相应账户和 Zone 范围可访问；它不会创建临时资源来试写权限。后续写操作仍需具备本节列出的 `Edit` 权限，Cloudflare 若拒绝写操作，部署可能在已经完成的远程步骤之后中止。

迁移 `0007_careless_sentinel` 会把旧 `credential` 表中的用户名和密码哈希复制到 `user` 表后再删除旧表。这个保护适用于尚未应用迁移 0007 的数据库；如果远程数据库已记录 0007 为已完成，部署脚本无法从已删除的表中恢复凭据，发布前需单独确认该数据库的用户登录恢复方案。

同时配置了 GitHub 仓库 URL 和令牌时，本地部署会把 `.env.deploy` 的配置加密写入该仓库的 **Actions 仓库级 Secrets**。`GITHUB_TOKEN` 和 `REPOSITORY_URL` 仅用于本地同步，不会上传。空值也会同步，以覆盖过期配置；删除 `.env.deploy` 中的某项不会自动删除远程同名 Secret。同步失败会停止部署，不会把明文写入日志。支持 `https://github.com/OWNER/REPO`、其 `.git` 形式和 `git@github.com:OWNER/REPO.git`。请使用仅限目标仓库、具有仓库 `Secrets: Read and write` 权限的 fine-grained personal access token；classic token 需 `repo` scope。令牌只保存在被忽略的本地 `.env.deploy` 中。

如果 `production` 环境中已有同名 Environment Secrets，工作流会优先使用这些值；请同步更新或删除冲突的环境级配置。

### Cloudflare API Token 权限

将令牌的账户资源限定为 NextMail 使用的 Cloudflare 账户。邮件路由权限限定为 `EMAIL_DOMAIN` 对应的 Zone；设置 `CUSTOM_DOMAIN` 时，网站路由权限限定为该主机所属的 Zone。两者可能不同。部署所需权限如下：

| 范围 | 权限 |
| --- | --- |
| 账户 | `D1: Edit`、`Workers KV Storage: Edit`、`Workers Scripts: Edit` |
| `EMAIL_DOMAIN` 所属区域 | `Zone: Read`、`Email Routing Rules: Edit` |
| `CUSTOM_DOMAIN` 所属区域（设置时） | `Zone: Read`、`Workers Routes: Edit` |

当前项目不需要 `Cloudflare Pages: Edit`、`Zone Settings: Read/Edit`、`DNS: Edit`、`API Tokens: Edit` 或 `Email Routing Addresses: Edit`。

若通过 API 创建账户部署令牌，使用单独具备 `Account API Tokens: Edit` 权限的引导令牌，按上述权限创建部署令牌后，将新令牌保存到被忽略的 `.env.deploy`。部署令牌本身不需要令牌管理权限。API 权限组名称中的 `Write` 对应控制台的 `Edit`；请从目标账户的权限组接口获取 ID，不要根据名称猜测或复用其他权限组 ID。

### 清理 Cloudflare 部署

在确认要删除 NextMail 的 Cloudflare 资源及 D1 数据后，在仓库根目录运行：

```bash
npm run delete
```

命令从 `.env.deploy` 和进程环境读取 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`、`EMAIL_DOMAIN`；如果自定义域名路由曾部署过，保留对应的 `CUSTOM_DOMAIN` 或 `wrangler.json` 中的路由配置。脚本会先验证 Token，并在进行任何删除前列出将处理的资源。D1/KV 的显式 ID 若仍存在，必须分别指向名称为 `nextmail-d1` 和 `nextmail-kv` 的项目资源，否则会停止；已不存在的 ID 会按已清理资源跳过。

清理范围仅限 `nextmail`、`email-receiver-worker`、`cleanup-worker` 三个 Worker，项目配置中指向 `nextmail` 的精确路由、名称为 `nextmail-kv` 的 KV namespace、名称为 `nextmail-d1` 的 D1 数据库，以及仍将邮件转发到 `email-receiver-worker` 的 `EMAIL_DOMAIN` Catch All。D1 数据库删除会移除其中的应用数据；执行前请先备份。Catch All API 没有删除该规则的操作，脚本会在它仍指向 NextMail Worker 时将其禁用。原有 Catch All 若曾被部署覆盖，项目没有保存其旧配置，清理时无法恢复。

脚本不会删除 Cloudflare Zone 或 DNS 记录，也不会修改 GitHub 仓库、Actions Secrets、OAuth 应用、本地 `.env.deploy` 或 Wrangler 配置。清理后，`wrangler.json` 仍保留上次部署的资源 ID 和路由；再次部署时若显式设置的 `DATABASE_ID` 或 `KV_NAMESPACE_ID` 指向已删除资源，需要先清除或更新这些覆盖值。该流程不是原子操作；若 Cloudflare API 在部分删除后失败，可以再次运行，已不存在的 Worker、路由或资源会被跳过。

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
- CI 不需要 `.env.deploy`。在首次触发 Actions 前，请确认仓库 Secrets 已配置，至少包括 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`、`AUTH_SECRET` 和 `EMAIL_DOMAIN`。
- `DATABASE_ID`、`KV_NAMESPACE_ID`、`CUSTOM_DOMAIN`、`EMAIL_DOMAIN`、`WEBHOOK_ALLOWED_HOSTS` 和 `NEXT_PUBLIC_BASE_URL` 也从 Actions Secrets 读取；此前只配置在 Actions Variables 中的值需要迁移。
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
- `NEXT_PUBLIC_BASE_URL`: 可选，应用公开基础 URL；请设置为实际 Worker 地址或 `CUSTOM_DOMAIN`，以生成正确的 canonical 和 OAuth 回调地址

### Cloudflare 配置
- `CLOUDFLARE_API_TOKEN`：Cloudflare API Token；按[最小部署权限](#cloudflare-api-token-权限)配置，自动设置 Catch All 需要目标 Zone 的 `Email Routing Rules: Edit` 权限。
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare Account ID
- 自动发现或新建 D1 时使用名称 `nextmail-d1`。
- `DATABASE_ID`: 可选，手动指定账户中 `nextmail-d1` 的数据库 ID；未设置时按名称查找或创建。脚本使用指定 ID，不校验该数据库的名称，迁移会直接写入此 ID 对应的数据库，运行前必须核对目标。
- Cloudflare KV namespace 名称固定为 `nextmail-kv`，用于存储网站配置。
- `KV_NAMESPACE_ID`: Cloudflare KV namespace ID，用于存储网站配置 （可选， 如果不填, 则会自动通过 Cloudflare API 获取）
- `CUSTOM_DOMAIN`: 网站自定义主机名，例如 `app.example.com`（可选）；必须属于此 Cloudflare 账号管理的 Zone 且 DNS 已代理。部署脚本将其路由到 Worker；留空时启用 `workers.dev` 地址。`pages.dev` 不属于你的 Zone，不能作为此项。
- `EMAIL_DOMAIN`: 收件邮箱域名，例如 `example.com`；必须与此 Cloudflare 账号中匹配到的 Zone 名称完全一致。部署脚本会配置该 Zone 的 Catch All；若填写的子域名只匹配到父 Zone，脚本会在数据库修改和发布前停止，避免更改父域的 Catch All。使用子域名收信时，先完成 [Email Routing 子域名配置](https://developers.cloudflare.com/email-service/configuration/subdomains/)，并确认该子域名能匹配到独立的同名 Zone。

### GitHub 同步配置

- `REPOSITORY_URL`：目标 GitHub 仓库 URL（可选；必须与 `GITHUB_TOKEN` 同时填写）。
- `GITHUB_TOKEN`：具有目标仓库 `Secrets: Read and write` 权限的 GitHub 令牌（可选；仅用于本地同步，不发送到 Actions Secrets）。

<a id="webhook-setup"></a>

## Webhook 配置

`WEBHOOK_ALLOWED_HOSTS` 是启用 Webhook 投递的必要条件。设置一个逗号分隔的精确、受信任运营方批准的公开主机名列表，不包含协议、路径、端口或通配符。例如：

```dotenv
WEBHOOK_ALLOWED_HOSTS="hooks.example.com,notifications.example.com"
```

在根目录 `.env.deploy` 中设置此变量用于本地部署，或在 GitHub Actions 中以同名 Secret 设置。`npm run deploy` 会将此值同时写入 OpenNext 应用 Worker 和 Email Worker。如果分别部署这两个组件，请使用 `wrangler secret put WEBHOOK_ALLOWED_HOSTS --config wrangler.json` 和 `wrangler secret put WEBHOOK_ALLOWED_HOSTS --config wrangler.email.json` 在两个运行时中分别配置，然后再启用 Webhook。本地 `npm run dev` 和 `npm run preview:worker` 使用 `.dev.vars`（参见 `.dev.vars.example`）。

升级前，请复核已启用的 Webhook 目标，并只批准受信任运营方控制的主机。部署会在迁移或发布前检查这些目标，如果任何目标会被阻止则停止。它永远不会自动批准已保存的用户 URL。如果没有启用任何 Webhook，允许为空；个人页面会说明站点管理员必须先完成设置，然后才能启用 Webhook。在设置未完成时，仍然可以禁用现有 Webhook。

部署完成后，在已批准的主机上保存一个 HTTPS Webhook URL，并在个人页面中使用 **Test**。未批准的主机、重定向、非 HTTPS URL、凭据、片段和非标准端口都会被阻止。已认证的 `GET /api/webhook` 响应包含签名密钥。请验证 `X-Webhook-Signature` 为 `sha256=` 后接 `X-Webhook-Timestamp + "." + raw request body` 的十六进制 HMAC-SHA256 值，并拒绝过期时间戳以防止重放攻击。

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

首次部署后，皇帝必须在系统配置中保存已启用 Email Routing 的接收域名（与 `EMAIL_DOMAIN` 对应）。未设置 `EMAIL_DOMAINS` 时，配置接口返回空域名列表，创建邮箱返回 503；网站域名不能作为默认接收域名。

### 多域名 Catch-all 配置

主应用与邮件接收 Worker 必须绑定同一个 `SITE_CONFIG` KV namespace。完整部署脚本会同步两个配置文件中的绑定；手动部署时请同时检查 `./wrangler.json` 和 `./wrangler.email.json`。每个接收域名均需在 Cloudflare Email Routing 中将邮件交给邮件接收 Worker；完整部署只自动配置 `EMAIL_DOMAIN` 对应的 Zone，其余域名需单独配置。

升级前先备份 D1。新增迁移 `./drizzle/0020_user_email_domain_access.sql`、`./drizzle/0021_message_read_tracking.sql` 和 `./drizzle/0022_stable_mail_delivery.sql`，分别保存用户域名权限、邮件已读状态，以及 Catch-all 固定邮箱关联与邮件写入序号。0022 为现有邮件回填序号，并用触发器记录所有后续插入，因此升级耗时与已有邮件数量有关。它不删除邮件或修改邮件时间。部署新版应用前必须应用迁移，再同步发布邮件接收 Worker。旧时间游标在新版接口上会重放一次元数据，客户端按 ID 去重。

手动升级时，先应用迁移，再发布新版邮件接收 Worker，最后发布主应用。完整部署脚本会先发布主应用、再发布邮件接收 Worker；使用完整脚本时，须等待两个 Worker 都更新成功后再修改 Catch-all 前缀。
