import { safeErrorMetadata } from "@/lib/safe-error"
import { PERMISSIONS } from "@/lib/permissions"
import { NextResponse } from "next/server"
import { getUserId } from "@/lib/apiKey"
import { createDb } from "@/lib/db"
import { emails, messages } from "@/lib/schema"
import { eq } from "drizzle-orm"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { reserveSend, releaseSend } from "@/lib/send-permissions"


class SendRejectedError extends Error {}

interface SendEmailRequest {
  to: string
  subject: string
  content: string
}

async function sendWithResend(
  to: string,
  subject: string,
  content: string,
  fromEmail: string,
  config: { apiKey: string }
) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [to],
      subject: subject,
      html: content,
    }),
  })

  if (!response.ok) {
    const errorData = await response.json() as { message?: string }
    console.error('Resend API error:', { status: response.status })
    const ErrorType = response.status >= 400 && response.status < 500 ? SendRejectedError : Error
    throw new ErrorType(errorData.message || "Resend发送失败，请稍后重试")
  }

  return { success: true }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getUserId(PERMISSIONS.MANAGE_EMAIL)
    if (!userId) {
      return NextResponse.json(
        { error: "未授权" },
        { status: 401 }
      )
    }

    const { id } = await params
    const db = createDb()

    const { to, subject, content } = await request.json() as SendEmailRequest

    if (!to || !subject || !content) {
      return NextResponse.json(
        { error: "收件人、主题和内容都是必填项" },
        { status: 400 }
      )
    }

    const email = await db.query.emails.findFirst({
      where: eq(emails.id, id)
    })

    if (!email || email.expiresAt.getTime() <= Date.now()) {
      return NextResponse.json(
        { error: "邮箱不存在" },
        { status: 404 }
      )
    }

    if (email.userId !== userId) {
      return NextResponse.json(
        { error: "无权访问此邮箱" },
        { status: 403 }
      )
    }

    const env = getCloudflareContext().env
    const apiKey = await env.SITE_CONFIG.get("RESEND_API_KEY")

    if (!apiKey) {
      return NextResponse.json(
        { error: "Resend 发件服务未配置，请联系管理员" },
        { status: 500 }
      )
    }

    const reservation = await reserveSend(userId)
    if (!reservation.canSend) return NextResponse.json({ error: reservation.error }, { status: 403 })
    try {
      await sendWithResend(to, subject, content, email.address, { apiKey })
    } catch (error) {
      // A rejected request is safe to refund. Timeouts/5xx may have been delivered.
      if (error instanceof SendRejectedError && reservation.day) await releaseSend(userId, reservation.day)
      throw error
    }

    await db.insert(messages).values({
      emailId: email.id,
      fromAddress: email.address,
      toAddress: to,
      subject,
      content: '',
      type: "sent",
      html: content
    })

    return NextResponse.json({ 
      success: true,
      message: "邮件发送成功",
      remainingEmails: reservation.remainingEmails
    })
  } catch (error) {
    console.error('Failed to send email:', safeErrorMetadata(error))
    return NextResponse.json(
      { error: error instanceof SendRejectedError ? error.message : "发送邮件失败" },
      { status: 500 }
    )
  }
}
