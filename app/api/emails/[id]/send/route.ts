import { safeErrorMetadata } from "@/lib/safe-error"
import { PERMISSIONS, ROLES } from "@/lib/permissions"
import { NextResponse } from "next/server"
import { getUserId } from "@/lib/apiKey"
import { createDb } from "@/lib/db"
import { emails, messages } from "@/lib/schema"
import { eq } from "drizzle-orm"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { getUserRole } from "@/lib/auth"
import { isValidMailboxName } from "@/lib/mailbox-name"
import {
  CATCHALL_EMAIL_KEY,
  getEmailDomain,
  normalizeEmailAddress,
  normalizeMailboxName,
  parseCatchAllEmailConfig,
} from "@/lib/catch-all"
import { getResendConfigForAddress, loadResendConfig } from "@/lib/resend"
import { reserveSend, releaseSend } from "@/lib/send-permissions"

class SendRejectedError extends Error {}

interface SendEmailRequest {
  to: unknown
  subject: unknown
  content: unknown
  fromLocalPart?: unknown
}

async function sendWithResend(
  to: string,
  subject: string,
  content: string,
  fromEmail: string,
  config: { apiKey: string },
) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [to],
      subject,
      html: content,
    }),
  })

  if (!response.ok) {
    console.error("Resend API error:", { status: response.status })
    if (response.status >= 400 && response.status < 500) throw new SendRejectedError()
    throw new Error("Resend API request failed")
  }

  return { success: true }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const userId = await getUserId(PERMISSIONS.MANAGE_EMAIL)
    if (!userId) {
      return NextResponse.json({ error: "未授权" }, { status: 401 })
    }

    const body = await request.json().catch(() => null) as SendEmailRequest | null
    const to = typeof body?.to === "string" ? body.to.trim() : ""
    const subject = typeof body?.subject === "string" ? body.subject.trim() : ""
    const content = typeof body?.content === "string" ? body.content : ""
    const fromLocalPart = body?.fromLocalPart

    if (!to || !subject || !content.trim()) {
      return NextResponse.json(
        { error: "收件人、主题和内容都是必填项" },
        { status: 400 },
      )
    }
    if (fromLocalPart !== undefined && typeof fromLocalPart !== "string") {
      return NextResponse.json({ error: "发件邮箱前缀格式无效" }, { status: 400 })
    }

    const { id } = await params
    const db = createDb()
    const email = await db.query.emails.findFirst({ where: eq(emails.id, id) })

    if (!email || email.expiresAt.getTime() <= Date.now()) {
      return NextResponse.json({ error: "邮箱不存在" }, { status: 404 })
    }

    if (email.userId !== userId) {
      return NextResponse.json({ error: "无权访问此邮箱" }, { status: 403 })
    }

    const env = getCloudflareContext().env
    const [{ config: resendConfig }, catchAllConfigValue] = await Promise.all([
      loadResendConfig(env.SITE_CONFIG),
      env.SITE_CONFIG.get(CATCHALL_EMAIL_KEY),
    ])
    const domainResendConfig = getResendConfigForAddress(resendConfig, email.address)

    if (!domainResendConfig?.enabled || !domainResendConfig.apiKey.trim()) {
      return NextResponse.json(
        { error: "该邮箱域名未启用 Resend 发件服务" },
        { status: 403 },
      )
    }

    let fromAddress = normalizeEmailAddress(email.address)
    if (fromLocalPart !== undefined) {
      const catchAllConfig = parseCatchAllEmailConfig(catchAllConfigValue)
      const isConfiguredCatchAll = Object.values(catchAllConfig).some(({ address }) => (
        normalizeEmailAddress(address) === fromAddress
      ))
      const userRole = await getUserRole(userId)

      if (!isConfiguredCatchAll || userRole !== ROLES.EMPEROR) {
        return NextResponse.json(
          { error: "只有皇帝可以修改 Catch-all 发件邮箱前缀" },
          { status: 403 },
        )
      }

      const normalizedLocalPart = normalizeMailboxName(fromLocalPart)
      const domain = getEmailDomain(fromAddress)
      if (!domain || !isValidMailboxName(normalizedLocalPart)) {
        return NextResponse.json({ error: "发件邮箱前缀格式无效" }, { status: 400 })
      }

      fromAddress = `${normalizedLocalPart}@${domain}`
    }

    const reservation = await reserveSend(userId, email.address)
    if (!reservation.canSend) {
      return NextResponse.json({ error: reservation.error }, { status: 403 })
    }

    try {
      await sendWithResend(to, subject, content, fromAddress, { apiKey: domainResendConfig.apiKey })
    } catch (error) {
      // A definite provider rejection is safe to refund. A timeout or server
      // error may have been delivered, so keep that reservation.
      if (error instanceof SendRejectedError && reservation.day) {
        await releaseSend(userId, reservation.day)
      }
      throw error
    }

    await db.insert(messages).values({
      emailId: email.id,
      fromAddress,
      toAddress: to,
      subject,
      content: "",
      type: "sent",
      html: content,
      isRead: true,
    })

    return NextResponse.json({
      success: true,
      message: "邮件发送成功",
      remainingEmails: reservation.remainingEmails,
    })
  } catch (error) {
    console.error("Failed to send email:", safeErrorMetadata(error))
    return NextResponse.json(
      { error: error instanceof SendRejectedError ? "Resend 拒绝了发件请求，请检查邮件内容" : "发送邮件失败" },
      { status: 500 },
    )
  }
}
