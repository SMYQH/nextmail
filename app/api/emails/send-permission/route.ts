import { safeErrorMetadata } from "@/lib/safe-error"
import { NextResponse } from "next/server"
import { getUserId } from "@/lib/apiKey"
import { PERMISSIONS } from "@/lib/permissions"
import { checkSendPermission } from "@/lib/send-permissions"


export async function GET() {
  try {
    const userId = await getUserId(PERMISSIONS.MANAGE_EMAIL)
    if (!userId) {
      return NextResponse.json({
        canSend: false,
        error: "未授权"
      })
    }
    const result = await checkSendPermission(userId)
    
    return NextResponse.json(result)
  } catch (error) {
    console.error('Failed to check send permission:', safeErrorMetadata(error))
    return NextResponse.json(
      { 
        canSend: false, 
        error: "权限检查失败" 
      },
      { status: 500 }
    )
  }
} 