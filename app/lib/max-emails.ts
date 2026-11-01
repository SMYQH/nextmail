const NUMBER_INPUT_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i

export function parsePositiveSafeInteger(value: unknown): number | null {
  if (typeof value !== 'string') return null

  const normalized = value.trim()
  if (!normalized || !NUMBER_INPUT_PATTERN.test(normalized)) return null

  const parsed = Number(normalized)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null

  // Number() can round a fractional string into an integer. Check the exact
  // decimal digits, including scientific notation, before accepting that value.
  const [coefficient, exponent = '0'] = normalized.toLowerCase().split('e')
  const fractionalLength = coefficient.split('.')[1]?.length ?? 0
  const discardedDigits = fractionalLength - Number(exponent)
  if (discardedDigits > 0) {
    const digits = coefficient.replace(/[+.]/g, '')
    if (/[1-9]/.test(digits.slice(-discardedDigits))) return null
  }

  return parsed
}
