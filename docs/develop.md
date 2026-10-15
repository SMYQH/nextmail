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

3. 设置 wrangler：
仓库已直接包含三个 Wrangler 配置文件：`wrangler.json`、`wrangler.email.json` 和 `wrangler.cleanup.json`。
Cloudflare D1 数据库名固定为 `nextmail-d1`；设置数据库 ID。

4. 设置环境变量：
复制 `.env.example` 为本地 `.env`。设置 `AUTH_SECRET`；如需启用 GitHub 或 Google 登录，分别同时设置对应的 `AUTH_GITHUB_ID` 和 `AUTH_GITHUB_SECRET`，或 `AUTH_GOOGLE_ID` 和 `AUTH_GOOGLE_SECRET`。只有一组中的两个值都非空时，登录页才会显示该 OAuth 登录按钮。部署时，`CUSTOM_DOMAIN` 可设为 Cloudflare Zone 中由你控制的站点主机名，例如 `app.example.com`；留空时使用 Workers 的 `workers.dev` 地址。`EMAIL_DOMAIN` 必须与 Cloudflare API 匹配到的 Zone 名称完全一致，例如 `example.com`；若子域名只匹配到父 Zone，部署会拒绝配置 Catch All，以免修改父域邮件路由。收信子域名还需要按 [Cloudflare Email Routing 子域名说明](https://developers.cloudflare.com/email-service/configuration/subdomains/) 配置，并确认它能匹配到独立的同名 Zone。

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
npm run lint
npx tsc --noEmit
npm test
npm run build
npm run build:worker
npm run preview:worker
```

`npm test` 运行 Node 单元测试和路由测试，无需外部服务。目前没有配置 Playwright 套件；浏览器检查为手动操作。

样式使用 Tailwind CSS 4 和 `@tailwindcss/postcss`，主题、暗色变体及动画插件在 `./app/globals.css` 中配置。升级后需检查两种语言、明暗主题、移动端和键盘操作；浏览器最低基线见 [Tailwind CSS 升级说明](https://tailwindcss.com/docs/upgrade-guide#browser-requirements)。

收信 Worker 在解析或数据库写入失败时调用 `setReject`，向发件方返回永久 SMTP 拒绝，不承诺自动重试；发件方需在服务恢复后重新发送。已成功保存的邮件不会因后续 Webhook 查询或投递失败而被拒绝。服务端错误日志仅记录安全错误类型和必要的记录 ID，避免写入邮件正文、SQL 参数或凭据。参见 [Cloudflare 邮件 Worker API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)。

### 自动化测试约定

测试直接调用业务函数、路由处理器和清理 Worker；数据库测试应用 `drizzle/` 中的真实迁移到内存 SQLite。外部认证会话、KV 和邮件服务使用本地替身，不需要 `.env` 中的生产凭据。认证和路由套件会拦截未显式模拟的网络请求，并检查调用次数，避免业务层捕获异常后让测试误通过。

| 测试文件 | 主要保障 |
| --- | --- |
| `tests/auth-errors.test.ts` | 已知认证错误的准确映射、未知错误的安全回退，以及 `app/i18n/config.ts` 声明语言的非空翻译 |
| `tests/auth.test.ts` | 真实认证回调、重复及并发注册、输入校验、密码哈希持久化及响应不泄漏密码 |
| `tests/routes.test.ts` | 会话/API Key 权限、配额预占、并发发送、发送记录、拒绝退款与超时/5xx 不退款、公开邮件分享的到期边界及撤销、皇帝初始化 |
| `tests/database.test.ts` | 迁移约束及旧凭据迁移、用户及日期隔离的配额、删除邮箱不重置配额、无限配额记录 |
| `tests/cleanup.test.ts` | 0/1/99/100/101/251 个过期邮箱、级联删除、到期边界、活跃记录保护及数据库失败传播 |
| `tests/shared-data.test.ts` | 分享数据访问失效、不同邮箱隔离、隐藏发件及列表正文、分页排序与游标 |
| `tests/config.test.ts`、`tests/private-cache.test.ts` | 配置失败恢复、请求去重、清理缓存失败时仍可退出登录 |
| `tests/email-receiver.test.ts`、`tests/safe-error.test.ts` | 收信持久化失败的显式拒绝、已保存邮件不受 Webhook 失败影响、日志脱敏 |
| `tests/latest-request-gate.test.ts`、`tests/message-list-refresh.test.ts` | 过期请求响应隔离及刷新后保留已加载分页游标 |
| `tests/shared-date.test.ts` | 分享页首屏日期一致、语言和时区格式及永久邮箱到期标记 |
| `tests/password.test.ts`、`tests/webhook.test.ts`、`tests/deploy.test.ts`、`tests/deploy-routing.test.ts`、`tests/deploy-delete.test.ts` | 密码兼容、Webhook 主机策略及签名、部署构建/迁移顺序、Email Routing Zone 选择、Cloudflare 清理范围及 Token 保护 |

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

邮箱创建与复制：在本地环境分别打开 `/en/moe` 和 `/zh-CN/moe`，输入带首尾空格的 ` Alice.Tag+news `。预览、键盘复制得到的内容和创建后的地址必须一致，前缀为 `alice.tag+news`。用 Tab 到达复制按钮，分别使用 Enter 和空格复制；反馈必须使用当前语言。再次创建同名地址应显示对应语言的已占用提示。`bad@name`、`bad..name` 应被拒绝；留空仍应创建随机地址。

邮箱分页刷新：使用至少 60 个本地邮箱，滚动加载前两页，再点击刷新并继续滚动。已有邮箱应保留，后续分页不应重复，每个邮箱只出现一次。

分享邮件：打开包含 HTML 和纯文本的本地分享邮箱，用 Tab、Enter 和空格选择消息。选择纯文本格式，等待超过 10 秒的自动刷新周期，格式和正文应保持不变。分别检查两种语言、明暗主题、移动端和较矮视口，以及减少动态效果设置；动画结束后截图。

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

4. 生成 Mock 数据（邮箱以及邮件消息）
```bash
npm run generate-test-data
```
这会启动一个持续运行的服务器，访问 URL `http://localhost:8787/?user=用户名或邮箱`，其中 `user` 必须对应已有用户的用户名或邮箱。

## 移动端对话框检查

运行 `npm run dev`，使用可以管理邮箱的账户，在 Chromium 中以 390 × 844 尺寸打开 `/en/moe`，点击 **Create Email**。确认前缀、可选域名选择器、四个有效期选项和两个操作按钮都能在对话框内显示，无需水平滚动。使用多个已配置域名重复验证；确认控件能够换行并保持可用。对话框动画结束后截图。

## 目录结构

- `app/[locale]/`：本地化页面
- `app/components/`、`app/hooks/`、`app/lib/`：共享组件、Hooks 和服务端工具
- `app/api/`：API 路由
- `app/i18n/`：国际化配置
- `workers/`：Cloudflare Workers
- `drizzle/`：数据库迁移
- `scripts/`：自动化和测试脚本

部署凭据请使用 `.env.deploy.example` 创建 `.env.deploy`，不要写入 `.env`、`.env.local` 或任何应用模式环境文件。Worker 构建会拒绝这些文件中的部署令牌。首次预览需在本地 KV 设置 `EMAIL_DOMAINS`，未设置时创建邮箱返回 503。HTTP 预览支持普通会话 Cookie；中间件根据请求协议补充缺失的 `X-Forwarded-Proto`。
