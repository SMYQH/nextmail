# NextMail 开发说明

## 本地运行

### 前置要求

- Node.js 24+
- Npm
- Wrangler CLI
- Cloudflare 账号

### 安装

1. 克隆仓库：
```bash
git clone https://github.com/SMYQH/nextmail.git
cd nextmail
```

2. 安装依赖：
```bash
npm ci
```

3. 检查绑定模板：
仓库已包含 `wrangler.example.json`、`wrangler.email.example.json` 和 `wrangler.cleanup.example.json` 三个模板。它们只描述固定 Worker、D1 和 KV 绑定结构，不含真实资源 ID。`wrangler.json`、`wrangler.email.json` 和 `wrangler.cleanup.json` 是被忽略的本地生成文件：`npm run config:wrangler` 按模板生成，`dev`、`build:worker`、`db:migrate-local`、`db:migrate-remote` 和各部署命令会自动执行该步骤。资源 ID 依次取自 `DATABASE_ID`、`KV_NAMESPACE_ID` 覆盖值，其次是上次生成的结果；完整部署按名称发现或创建资源，并自动回写 ID。操作员配置统一放在 `.env.deploy`，不要手工把凭据写进 JSON，也不要提交生成文件。本地迁移和开发使用独立本地状态。

4. 设置环境变量：
复制 `../.env.deploy.example`（仓库根目录的 `.env.deploy.example`）为被忽略的 `.env.deploy`。开发、构建和部署共用此文件，不创建 `.env`、`.env.local` 或 `.dev.vars`。本地开发设置随机 `AUTH_SECRET`，并将 `NEXT_PUBLIC_BASE_URL` 设为本地地址（留空时开发环境按请求地址生成 canonical 链接）；离线本地开发无需有效的 Cloudflare 部署令牌。生产部署的必填项和所有可选后台设置见 [部署说明](deploy.md#环境变量)。如需 OAuth 登录，同时填写该提供商的 ID 和 Secret；仅当两项均非空时才显示按钮。进程环境优先于文件；GitHub Actions 仅使用 Secrets。

5. 创建本地数据库表结构
```bash
npm run db:migrate-local
```

### 开发

1. 启动开发服务器：
```bash
npm run dev
```

生产检查和 OpenNext Worker 构建：

```bash
npm run lint # ESLint CLI，沿用 app 目录范围，警告阈值为 0
npx tsc --noEmit
npm test
npm run build
npm run build:worker
npm run preview:worker
```

`npm test` 运行 Node 单元测试和路由测试，无需外部服务。`npm run test:browser` 使用项目自带 Playwright Chromium，覆盖中英文、明暗主题、桌面及 390 × 640 移动视口，包括账号登录、邮箱管理、API Key 和分享分页；自动启动或复用本地开发服务器。首次运行或 `git clean -fdx` 后先执行 `npm run bootstrap`，恢复依赖、唯一的 `.env.deploy`、本地数据库和测试配置，并安装 Chromium。禁止使用 Edge 或系统浏览器。完整本地循环门禁为 `npm run agent:gate`；入口见 `../scripts/agent/loop.ts`、步骤与时限见 `../scripts/agent/gate.ts`。浏览器套件不代表生产 Cloudflare 验证。

上述检查应顺序执行。`npm run build` 的 `prebuild` 会删除旧 `.next` 产物及 `tsconfig.tsbuildinfo`，由本次构建重新生成路由类型和增量状态；OpenNext 构建也会通过该入口执行。构建前请停止本地 `npm run dev`，不要同时运行多个生产或 Worker 构建，以免共享的 `.next` 文件在类型检查期间被另一进程删除。

浏览器 HTML 报告保存在 `../.test/playwright/`，测试结果、截图和验证日志保存在 `../.test/results/`；整个 `.test/` 已加入 Git 忽略。不再创建 `playwright-report/`、`.playwright/`、`test-results/`，也不使用 `.agent` 存放验证产物。

`CUSTOM_DOMAIN` 使用 Cloudflare 托管的 Worker Custom Domain，主机名不含 `/*`，由 Cloudflare 配置 DNS 与证书。普通 Worker Route 只匹配已有代理 DNS 流量，不能替代独立应用的域名配置；仅发布 Route 可能构建和部署成功，但浏览器仍无法解析域名。

样式使用 Tailwind CSS 4 和 `@tailwindcss/postcss`，主题、暗色变体及动画插件在 `./app/globals.css` 中配置。升级后需检查两种语言、明暗主题、移动端和键盘操作；浏览器最低基线见 [Tailwind CSS 升级说明](https://tailwindcss.com/docs/upgrade-guide#browser-requirements)。

框架使用 Next.js 16 和 React 19；开发及生产构建显式使用 `--webpack`，保留本地数据库和测试产物的监听排除。Lint 使用 ESLint 9 的 `../eslint.config.mjs` 平面配置，保留原有 app 目录检查范围。Next 预设的 React/JSX 插件尚限制 ESLint 9，因此该工具自身有停止维护提示；不要通过强制忽略依赖约束切换 ESLint 10。DOMPurify 与 Zod 使用已修复当前生产依赖公告的版本。

收信 Worker 在解析或数据库写入失败时调用 `setReject`，向发件方返回永久 SMTP 拒绝，不承诺自动重试；发件方需在服务恢复后重新发送。已成功保存的邮件不会因后续 Webhook 查询或投递失败而被拒绝。服务端错误日志仅记录安全错误类型和必要的记录 ID，避免写入邮件正文、SQL 参数或凭据。参见 [Cloudflare 邮件 Worker API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)。

### 调试与编辑器配置

`../.vscode/launch.json` 与 `../.vscode/tasks.json` 是仓库共享的调试配置，面向 VS Code、VSCodium、Antigravity 等基于 VS Code 的编辑器，以及 Windows、macOS、Linux。配置只引用 `${workspaceFolder}`、仓库内脚本和 `package.json` 的 npm 脚本，不含任何本机绝对路径，因此在其他机器上开箱可用。

- 依赖：`node` 与 `chrome` 调试由编辑器内置的 js-debug 扩展提供；`chrome` 配置需要本机安装 Chrome 系浏览器（Chrome、Beta、Canary、Dev、Edge、Brave、Chromium）。
- 任务：`wrangler: config` 生成被忽略的 `wrangler*.json`；`dev: server` 启动开发服务器；`wait: dev server` 轮询端口，脚本为 `../.vscode/wait-for-dev-server.mjs`，参数为端口和超时毫秒数。
- 调试配置（名称与 `launch.json` 一致）：`Next.js: debug server + browser`、`Next.js: debug client-side (Chrome)`、`Node: debug current test file`、`Node: debug all tests`、`Node: debug current script`、`Playwright: debug browser tests`、`Worker: debug cleanup worker`；复合配置为 `Next.js: debug server + client`。
- 开发模式下应用代码运行在 workerd（OpenNext `getPlatformProxy`）内，Node 调试器无法在 `app/**` 与 `proxy.ts` 命中断点；浏览器端代码使用 Chrome 配置，Worker 代码通过 workerd 检查器 `http://127.0.0.1:9229/json/list` 查看。
- 各人编辑器、系统与仓库路径不同，修改配置时保持仓库内相对路径，不要写入本机路径，也不要提交仅对单一机器生效的任务或变量。

### 自动化测试约定

测试直接调用业务函数、路由处理器和清理 Worker；数据库测试应用 `drizzle/` 中的真实迁移到内存 SQLite。外部认证会话、KV 和邮件服务使用本地替身，不需要生产凭据。认证和路由套件会拦截未显式模拟的网络请求，并检查调用次数，避免业务层捕获异常后让测试误通过。Turnstile 浏览器测试保存并恢复原有本地 KV 值，包括缺失的键；不应修改开发者已有的验证配置。

| 测试文件 | 主要保障 |
| --- | --- |
| `tests/auth-errors.test.ts` | 已知认证错误的准确映射、未知错误的安全回退，以及 `app/i18n/config.ts` 声明语言的非空翻译 |
| `tests/auth.test.ts` | 真实认证回调、重复及并发注册、输入校验、密码哈希持久化及响应不泄漏密码 |
| `tests/cursor.test.ts` | 分页游标结构、日期范围、收件序号校验及有效旧版时间戳轮询兼容 |
| `tests/share-expiry.test.ts` | 分享有效期解析：缺省或 0 表示永久，正数生成到期时间，非法结构与数值一律拒绝 |
| `tests/routes.test.ts` | 会话/API Key 权限、无效游标状态码与权限优先级、密钥创建及启停输入校验、同名密钥冲突隔离、无会话 API Key 邮箱操作、Catch-all 发件身份、配额预占、并发发送、发送记录、拒绝退款与超时/5xx 不退款、分享有效期输入校验、公开邮箱及邮件分享的到期边界及撤销、分享列表数据库正文排除及分页、邮箱原子级联删除及失败保护、皇帝初始化 |
| `tests/database.test.ts` | 迁移约束及旧凭据迁移、用户及日期隔离的配额、删除邮箱不重置配额、无限配额记录 |
| `tests/cleanup.test.ts` | 0/1/99/100/101/251 个过期邮箱、单次批次预算、1000/1001/2001 个邮箱的跨轮清理、剩余任务提示、级联删除、到期边界、活跃记录保护及部分成功后的失败恢复 |
| `tests/shared-data.test.ts` | 分享数据访问失效、不同邮箱隔离、隐藏发件及列表正文、列表查询排除数据库正文字段、分页排序与游标 |
| `tests/config.test.ts`、`tests/private-cache.test.ts` | 配置失败恢复、请求去重、清理缓存失败时仍可退出登录 |
| `tests/config-env.test.ts` | 单一配置文件迁移、仓库外备份、CI 隔离、本地 Worker 绑定、构建凭据扫描和测试报告路径 |
| `tests/admin-deploy-config.test.ts`、`tests/admin-users-deploy.test.ts` | 后台设置初始化、账号重复部署、角色原子替换、域名/API Key/Webhook 权限及 Catch-all 邮箱保留 |
| `tests/browser/bulk-mailbox-delete.spec.ts`、`tests/browser/owner-pagination.spec.ts` | 批量删除的确认/失败恢复，以及 API Key 明文、所有者分页和交互状态 |
| `tests/email-receiver.test.ts`、`tests/safe-error.test.ts` | 收信持久化失败的显式拒绝、已保存邮件不受 Webhook 失败影响、日志脱敏 |
| `tests/catch-all-config.test.ts` | 域名配置校验、Catch-all 重命名期间收信、首次并发保存保留原邮箱及邮件、KV 保存失败后的重试及稳定邮箱关联 |
| `tests/mailbox-controls.test.ts`、`tests/mailbox-events.test.ts` | Catch-all 置顶及删除保护、已读及删除统计、增量游标及延迟响应的统计隔离 |
| `tests/latest-request-gate.test.ts`、`tests/message-list-refresh.test.ts` | 过期请求响应隔离、同一创建范围关闭重开后旧票据持续失效、刷新后保留已加载分页游标 |
| `tests/deploy-waf.test.ts` | 主机与 OpenAPI 路径范围、规则及 ID 保留、速率限制保留、验证密钥隔离与脱敏、API/前端探测及重试 |
| `tests/avatar.test.ts` | 空名称、Unicode 首字符及 SVG 文本转义 |
| `tests/shared-date.test.ts` | 分享页首屏日期一致、语言和时区格式及永久邮箱到期标记 |
| `tests/password.test.ts`、`tests/webhook.test.ts`、`tests/deploy.test.ts`、`tests/deploy-routing.test.ts`、`tests/deploy-delete.test.ts`、`tests/github-secrets.test.ts`、`tests/oauth-providers.test.ts` | 密码兼容、Webhook 主机策略及签名、部署构建/迁移顺序、Email Routing Zone 选择、Cloudflare 清理范围、Token 保护、构建产物不携带凭据及 GitHub Secret 同步、OAuth 提供方启用条件 |

只运行相关套件时，在项目根目录执行，例如：

```bash
node --import tsx --experimental-test-module-mocks --test tests/routes.test.ts tests/cleanup.test.ts
```

新增测试应断言可观察结果和副作用：响应、持久化数据、配额、外部调用次数。仅检查状态码或在会被业务代码捕获的模拟回调中抛出异常，不能证明没有副作用。测试需重置数据库及配置、恢复模拟并关闭数据库；语言清单使用运行时配置，避免继续检查已移除语言。

SQLite 同步语句包裹 `Promise.all` 不构成并发验证。路由发送测试会暂缓模拟服务的响应，让多个请求在投递完成前竞争配额；数据库套件仅验证 SQL 语义。清理测试调用真实 Worker，不在测试中复制其循环。现有 SQLite/D1 适配器不模拟多实例并发、Cloudflare CPU 配额或真实服务投递；这些仍需部署环境验证。已知问题及验证证据记录在 [审查记录](review.md)。

### 手动回归检查

域回归测试：在网站设置中保存 `EXAMPLE.com, example.org , EXAMPLE.com`，重新加载 Create Email，并使用第二个域名创建地址。API 配置和存储的邮箱都必须使用 `example.org`，不能包含周围空格。

Webhook 回归测试：请参阅 [Webhook 配置](deploy.md#webhook-setup)。如果没有白名单，个人面板和保存/测试错误必须说明需要管理员配置。如果有已批准的主机，保存必须成功；未批准的主机必须保持阻止状态。如果其主机不再被批准，现有 Webhook 必须仍然可以禁用。部署预检必须在更改远程 schema 之前拒绝任何会阻止已启用 Webhook 的升级。

配置恢复：运行 `npm run dev` 并应用本地 D1 迁移，然后以邮箱所有者身份登录。在浏览器开发者工具中阻止 `/api/config`，打开 Create Email，并等待三次有界尝试失败。对话框必须显示重试按钮并禁用创建。解除阻止请求并重试（或关闭并重新打开对话框）；域名必须加载且创建必须可用。离开并返回也必须从之前的失败加载中恢复。

注册反馈：在注册选项卡中尝试一个已存在的用户名。表单必须显示翻译后的用户名已占用消息，同时保留输入。尝试新用户名以验证注册和自动登录仍然成功。Cloudflare 密码认证需要 [部署指南中描述的付费运行时](deploy.md#runtime-requirements)。

邮箱创建与复制：在本地环境分别打开 `/en/mailbox` 和 `/zh-CN/mailbox`，输入带首尾空格的 ` Alice.Tag+news `。预览、键盘复制得到的内容和创建后的地址必须一致，前缀为 `alice.tag+news`。用 Tab 到达复制按钮，分别使用 Enter 和空格复制；反馈必须使用当前语言。再次创建同名地址应显示对应语言的已占用提示。`bad@name`、`bad..name` 应被拒绝；留空仍应创建随机地址。旧路径 `/en/moe` 和 `/zh-CN/moe` 应重定向到对应的 `/mailbox`。

API Key 创建反馈：分别在 `/en/profile` 和 `/zh-CN/profile` 用有权限的账户创建密钥，再输入同名名称并按 Enter。应保留对话框和输入，显示当前语言的占用提示并将焦点放回名称输入框；修改名称后提示应清除，按 Enter 可创建成功。模拟网络失败及 HTTP 500 时应保留输入并允许重试，不显示服务端原始错误。检查明暗主题、桌面和 390 × 640 移动视口，以及键盘和减少动态效果模式；成功后的复制和取消按钮不得触发表单再次提交。错误文字在两种主题下的对比度应至少为 4.5:1，窄屏操作按钮之间应保留明确间距。断网测试应确认请求确实未到达服务端，避免 PWA 转发绕过测试拦截而误判。动画结束后截图。

API Key 关闭与竞态：分别使用取消、右上角关闭、Escape 和遮罩关闭后再打开，对话框应恢复空白且可输入，旧错误和完整密钥不得重新出现。成功面板应提示关闭前复制；截图时必须遮盖完整密钥。借助本地请求拦截延迟第一次创建响应，关闭后重新打开并发起第二次创建；依次检查旧请求的 HTTP 200、409、500 和网络错误，均不得覆盖新输入、显示旧密钥或提前解除新请求的加载状态。旧请求若实际创建成功，列表仍应更新显示该记录；关闭界面并不等于撤销服务端创建。另将旧列表刷新响应延迟到第二次创建及其刷新完成后才返回，新创建记录不得从列表消失。

API Key 行操作：延迟创建成功后的列表刷新，关闭对话框后停用或删除已有密钥；操作及新刷新完成后才释放旧列表快照，停用状态不得回退，已删除记录不得重新出现。新刷新若返回 HTTP 500，应显示加载失败，但保留已成功操作的本地结果；随后释放旧快照也不得回退。延迟某一行的 PATCH 或 DELETE 时，该行开关与删除按钮均应禁用并标记忙碌，快速重复点击只发送一次请求；其他行仍可操作，其刷新不得提前解除忙碌行的锁定。模拟 HTTP 500 后应保留原记录和启用状态、解除锁定并允许用键盘重试。分别检查中英文的开关和删除按钮可访问名称包含密钥名称，列表加载与启停失败不得误报为创建失败。检查明暗主题、桌面与移动视口、长名称换行和减少动态效果，并在动画结束后截图。

分享对话框与可访问名称：在中英文的邮箱页打开分享对话框，有效期下拉必须显示当前语言（英文界面不得出现中文标签），列表加载失败与创建失败提示必须不同且不得显示原始服务端错误文本。复制与删除按钮应有包含动作说明的可访问名称；个人中心的语言切换、Webhook 测试与开关、Turnstile 密钥显示切换、API 文档复制按钮同样必须具备可访问名称。

邮箱分页刷新：使用至少 60 个本地邮箱，滚动加载前两页，再点击刷新并继续滚动。已有邮箱应保留，后续分页不应重复，每个邮箱只出现一次。切换到其他浏览器标签页再返回，等待同一用户的会话重新验证后，已加载的分页和滚动位置也必须保留；切换用户或域名筛选时则应清空旧列表并从第一页开始。

分享邮件：打开包含 HTML 和纯文本的本地分享邮箱，用 Tab、Enter 和空格选择消息。选择纯文本格式，等待超过 30 秒的自动刷新周期，格式和正文应保持不变。分别检查两种语言、明暗主题、移动端和较矮视口，以及减少动态效果设置；动画结束后截图。

邮件详情重试与删除焦点：在邮箱页打开一封邮件，用浏览器开发者工具让详情请求返回 HTTP 500，界面必须显示错误状态和重试按钮。解除拦截后点击重试，必须在当前页面重新请求并显示邮件，不得重新加载整个应用；邮箱列表、所选标签和滚动位置必须保留。用键盘删除一封邮件并确认后，焦点必须落在仍然列出的邮件上；列表变空时焦点应留在列表的刷新按钮，不得落到文档正文。分别检查中英文、桌面与 390 × 640 移动视口。

浏览器隔离检查：`npm run test:browser:isolated` 将当前索引导出到被忽略的 `.test/results/snapshots/` 子目录，为快照生成独立 `.env.deploy`，应用本地 D1 迁移并写入本地测试 KV。快照使用独立端口（默认 3111，可用 `--port` 覆盖），不复用工作树服务或凭据；输出列出与 HEAD 不同的已暂存文件，因此结果描述索引中的代码。分片检查应保持索引不变，依次运行 `--shard 1/4` 至 `--shard 4/4`，全部通过才可报告整套通过，不与其他浏览器套件或构建并行。开发编译器忽略当前项目的 `.wrangler/` 和 `.test/`，避免数据库与报告写入触发重新编译；源码热更新和生产编译保持有效。

2. 测试邮件 worker：
目前无法本地运行并测试，请使用 Wrangler 部署邮件 Worker 并测试；完整部署会在 OpenNext 应用 Worker 和两个独立 Worker 成功后，自动把 `EMAIL_DOMAIN` 的 Catch All 路由到 `email-receiver-worker`。
```bash
npm run deploy:email
```

3. 测试清理 worker：
```bash
npm run dev:cleanup
npm run test:cleanup
```

清理 Worker 每次最多处理 10 批，每批 100 个过期邮箱；较大的积压会保留，交由后续每小时任务继续处理。达到预算时日志会提示可能仍有任务，并非统计剩余邮箱总数。每批仍使用原有原子删除与级联约束；如果后续批次失败，错误继续抛出，但先前已成功的批次不会回滚。此改动不需要迁移，也不修改定时任务配置；本地测试不代表生产 D1 限额或 CPU 行为已验证。

4. 生成 Mock 数据（邮箱以及邮件消息）
```bash
npm run generate-test-data
```
这会启动一个持续运行的服务器，访问 URL `http://localhost:8787/?user=用户名或邮箱`，其中 `user` 必须对应已有用户的用户名或邮箱。

## 移动端对话框检查

运行 `npm run dev`，使用可以管理邮箱的账户，在 Chromium 中以 390 × 844 尺寸打开 `/en/mailbox`，点击 **Create Email**。确认前缀、可选域名选择器、四个有效期选项和两个操作按钮都能在对话框内显示，无需水平滚动。使用多个已配置域名重复验证；确认控件能够换行并保持可用。对话框动画结束后截图。

## 目录结构

- `app/[locale]/`：本地化页面
- `app/components/`、`app/hooks/`、`app/lib/`：共享组件、Hooks 和服务端工具
- `app/api/`：API 路由
- `app/i18n/`：国际化配置
- `workers/`：Cloudflare Workers
- `drizzle/`：数据库迁移
- `scripts/`：自动化和测试脚本
- `wrangler*.example.json`：被跟踪的 Worker 绑定模板；同名的 `wrangler*.json` 是被忽略的本地生成文件

所有本地配置均使用 `.env.deploy`，不要创建其他应用环境文件；构建会拒绝遗留配置文件。旧版可运行 `npm run config:migrate-local`，冲突项保留 `.env.deploy` 的值，原文件逐字节备份到仓库外后才移除；命令仅显示变量名和备份位置，不输出值。首次离线预览需运行 `npm run bootstrap` 初始化本地 KV；直接启动且缺少 `EMAIL_DOMAINS` 时创建邮箱返回 503。HTTP 预览支持普通会话 Cookie；Next.js 代理 `proxy.ts` 根据请求协议补充缺失的 `X-Forwarded-Proto`。

## 多域名功能回归

先运行 `npm run db:migrate-local`。迁移 `./drizzle/0020_user_email_domain_access.sql` 保存用户域名权限；`./drizzle/0021_message_read_tracking.sql` 新增邮件已读状态及统计索引；`./drizzle/0022_stable_mail_delivery.sql` 保存 Catch-all 的固定邮箱关联，并为现有及新邮件建立数据库写入序号。现有邮件默认未读，现有用户默认继承全部配置域名。写入序号由插入触发器生成，不依赖邮件时间或随机 ID；删除邮件会清理对应记录，但不会重用已提交的序号。

运行以下聚焦检查，再执行完整的 lint、TypeScript、单元测试和 Worker 构建：

```sh
node --import tsx --experimental-test-module-mocks --test tests/catch-all-config.test.ts tests/mailbox-controls.test.ts tests/email-receiver.test.ts tests/routes.test.ts tests/message-list-refresh.test.ts tests/mailbox-events.test.ts
```

浏览器中分别检查 `/en/mailbox`、`/zh-CN/mailbox` 和对应 profile 页面。使用两个接收域名，确认 Catch-all 开关、前缀、停用显示、域名筛选及每域 Resend 设置。为普通用户仅允许一个域名，再登录该用户验证创建选项和 API 拒绝行为。打开未读邮件后，标题应恢复普通字重且计数减少一次。

发送超过一页新邮件，等待至少 30 秒，确认增量轮询逐页获取全部新邮件，旧页分页仍可用。隐藏页面后确认没有轮询请求，恢复后确认继续更新。以键盘操作域名筛选及配置控件，检查明暗主题、390 × 640 短移动视口和减少动态效果模式；动画结束后截图。单元测试及本地模拟不能证明生产 Cloudflare 收件、Resend 投递或 Webhook 服务可用。


邮箱统计竞态：打开只有一封未读邮件的邮箱，再加入第二封未读邮件。先刷新左侧邮箱列表，确认统计为 `2 / 2`，再等待邮件轮询；统计必须仍为 `2 / 2`。重新开始并交换刷新与轮询顺序，再连续等待空增量轮询，确认不会重复累计。

置顶邮箱分页：先只加载 Catch-all 邮箱，在另一会话中新增 21 个普通邮箱，再刷新并滚动到底。全部 22 个邮箱应可见且没有重复；已有普通邮箱分页重叠时，仍需保留原有分页末尾。

配置错误语言：分别在 `/en/profile` 和 `/zh-CN/profile` 保存无效 Catch-all 前缀、已占用地址和空的已启用邮箱名，确认提示使用当前语言。模拟未知服务端错误或请求失败时，应显示当前语言的通用保存失败提示，不显示服务端原始文本。

Catch-all 保存恢复：在重命名的数据库写入成功、KV 尚未保存时投递未知地址邮件，必须进入原邮箱。模拟首次保存或重命名时的 KV 写入失败，再提交相同配置，必须复用原邮箱并成功保存；原邮件保留。失败的旧配置仍启用时，收件也必须能通过固定关联进入原邮箱。

Catch-all 并发与发件：让两个首次保存请求使用不同前缀，并在两个请求读取旧配置后交错完成；最终只能保留同一个注册邮箱，先完成请求后的收件不能丢失。重命名后保留旧 KV 地址，分别通过皇帝会话及 API Key 发送原前缀和自定义前缀邮件，应成功并保存正确发件地址；复用旧地址的普通邮箱及非皇帝角色都不能修改发件前缀。

延迟收件：首次快照后插入时间相同但 ID 更小、或时间更早的邮件；增量轮询必须收到它们，列表仍按邮件时间显示。超过一页时逐页排空，插入新邮件及删除全部旧邮件后继续检查，不能遗漏或重复显示。

跨会话已读：从两封未读邮件开始，在另一会话读取其中一封。等待当前页面轮询显示 `1 / 2`，再打开本页仍加粗的同一行，计数必须保持 `1 / 2`；打开另一封才变为 `0 / 2`。分别检查英文、中文及桌面、移动视口。

邮件正文与头像：清空缓存后，分别在“全部”和域名筛选下打开 HTML-only 邮件，并反复切换筛选、邮件及主题。正文必须显示且 iframe 不得折叠；保留 iframe 沙箱，不允许邮件脚本执行。两种语言、明暗主题、桌面与短屏移动端分别检查，包含鼠标、键盘和减少动态效果模式。阻止外部头像请求，页头与个人中心应显示本地首字母头像；恢复请求并切换用户图片后应能重新显示远程头像。

Catch-all 配置说明：检查每个域名的收集开关、汇总地址和停用后的显示开关都有独立标签及说明，移动端完整显示域名后缀，键盘可以操作。保存时分别核对 `enabled` 和 `showAlways`，确认显示设置不改变收集状态，也不删除历史邮件。
