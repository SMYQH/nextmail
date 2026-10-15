import { useState, useEffect, useCallback, useRef } from 'react'

interface SendPermissionResponse {
  canSend: boolean
  error?: string
  remainingEmails?: number
  enabledDomains?: string[]
}

interface PermissionState extends Omit<SendPermissionResponse, 'error'> {
  address?: string
  addressVersion: number
  error?: string | null
}

export function useSendPermission(address?: string) {
  const [loading, setLoading] = useState(false)
  const [permission, setPermission] = useState<PermissionState>({ canSend: false, addressVersion: 0 })
  const latestRequest = useRef(0)
  const latestAddress = useRef(address)
  const addressVersion = useRef(0)
  if (latestAddress.current !== address) {
    latestAddress.current = address
    addressVersion.current += 1
  }

  const checkPermission = useCallback(async () => {
    const requestId = ++latestRequest.current
    const requestAddressVersion = addressVersion.current
    setLoading(true)
    const isCurrentRequest = () => (
      requestId === latestRequest.current
      && requestAddressVersion === addressVersion.current
      && latestAddress.current === address
    )

    try {
      const query = address ? `?address=${encodeURIComponent(address)}` : ''
      const response = await fetch(`/api/emails/send-permission${query}`)

      if (!response.ok) {
        throw new Error('权限检查失败')
      }

      const data = await response.json() as SendPermissionResponse
      if (!isCurrentRequest()) return
      setPermission({
        address,
        addressVersion: requestAddressVersion,
        canSend: data.canSend,
        error: data.canSend ? null : data.error ?? null,
        remainingEmails: data.remainingEmails,
        enabledDomains: data.enabledDomains ?? [],
      })
    } catch (err) {
      if (!isCurrentRequest()) return
      setPermission({
        address,
        addressVersion: requestAddressVersion,
        canSend: false,
        error: err instanceof Error ? err.message : '权限检查失败',
        enabledDomains: [],
      })
    } finally {
      if (isCurrentRequest()) setLoading(false)
    }
  }, [address])

  useEffect(() => {
    checkPermission()
  }, [checkPermission])

  const currentPermission = permission.address === address
    && permission.addressVersion === addressVersion.current
    ? permission
    : undefined

  return {
    canSend: currentPermission?.canSend ?? false,
    loading,
    error: currentPermission?.error ?? null,
    remainingEmails: currentPermission?.remainingEmails,
    enabledDomains: currentPermission?.enabledDomains ?? [],
    checkPermission
  }
}
