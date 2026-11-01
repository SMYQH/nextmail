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
  status: 'loading' | 'resolved'
  error?: string | null
}

export function useSendPermission(address?: string) {
  const [permission, setPermission] = useState<PermissionState>({
    canSend: false,
    addressVersion: -1,
    status: 'resolved',
  })
  const latestRequest = useRef(0)
  const [addressState, setAddressState] = useState(() => ({ address, version: 0 }))

  // Keep a generation for each prop transition, including A -> B -> A, so an
  // old response for A cannot become current again after switching back.
  if (addressState.address !== address) {
    setAddressState({ address, version: addressState.version + 1 })
  }

  const runPermissionCheck = useCallback(async (
    requestAddress: string | undefined,
    requestAddressVersion: number,
    isCurrentRequest: () => boolean
  ) => {
    try {
      const query = requestAddress ? `?address=${encodeURIComponent(requestAddress)}` : ''
      const response = await fetch(`/api/emails/send-permission${query}`)

      if (!response.ok) {
        throw new Error('权限检查失败')
      }

      const data = await response.json() as SendPermissionResponse
      if (!isCurrentRequest()) return
      setPermission({
        address: requestAddress,
        addressVersion: requestAddressVersion,
        status: 'resolved',
        canSend: data.canSend,
        error: data.canSend ? null : data.error ?? null,
        remainingEmails: data.remainingEmails,
        enabledDomains: data.enabledDomains ?? [],
      })
    } catch (err) {
      if (!isCurrentRequest()) return
      setPermission({
        address: requestAddress,
        addressVersion: requestAddressVersion,
        status: 'resolved',
        canSend: false,
        error: err instanceof Error ? err.message : '权限检查失败',
        enabledDomains: [],
      })
    }
  }, [])

  const checkPermission = useCallback(async () => {
    const requestId = ++latestRequest.current
    const requestAddressVersion = addressState.version
    setPermission({
      address,
      addressVersion: requestAddressVersion,
      status: 'loading',
      canSend: false,
    })
    await runPermissionCheck(
      address,
      requestAddressVersion,
      () => requestId === latestRequest.current
    )
  }, [address, addressState.version, runPermissionCheck])

  useEffect(() => {
    const requestId = ++latestRequest.current
    let active = true
    void runPermissionCheck(
      address,
      addressState.version,
      () => active && requestId === latestRequest.current
    )

    return () => {
      active = false
    }
  }, [address, addressState.version, runPermissionCheck])

  const currentPermission = permission.address === address
    && permission.addressVersion === addressState.version
    ? permission
    : undefined
  const loading = !currentPermission || currentPermission.status === 'loading'

  return {
    canSend: currentPermission?.canSend ?? false,
    loading,
    error: currentPermission?.error ?? null,
    remainingEmails: currentPermission?.remainingEmails,
    enabledDomains: currentPermission?.enabledDomains ?? [],
    checkPermission
  }
}
