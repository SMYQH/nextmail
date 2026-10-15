`https://github.com/beilunyang/moemail/pull/136/changes/4ef83bb01a9b96acb1c2c176a333be844eb18369`

## 适配范围

将上述原项目 PR 适配到当前 NextMail 的认证、权限、多语言及 Cloudflare Workers 架构。本地实现包括：

- 按接收域名配置 Catch-all 邮箱，保留重命名前的邮箱 ID 与邮件，并支持配置保存失败后重试。
- 按域名配置 Resend 发件服务，为用户设置可创建邮箱的域名范围。
- 在邮箱列表按域名筛选、置顶 Catch-all，并保护其不被直接删除。
- 显示收件总数和未读数，打开邮件后标为已读，并使用增量游标轮询新邮件。

产品行为见 [使用说明](./usage.md#多域名邮箱管理)，开发验证见 [开发说明](./develop.md)，审查状态以 [审查记录](./review.md) 为准。远程迁移、部署与实际邮件投递仍需独立验证。
