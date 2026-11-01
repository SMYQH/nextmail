export interface ExpiryOption {
  labelKey: "oneHour" | "oneDay" | "threeDays" | "permanent"
  value: number
}

export const EXPIRY_OPTIONS: ExpiryOption[] = [
  { labelKey: "oneHour", value: 1000 * 60 * 60 },
  { labelKey: "oneDay", value: 1000 * 60 * 60 * 24 },
  { labelKey: "threeDays", value: 1000 * 60 * 60 * 24 * 3 },
  { labelKey: "permanent", value: 0 }
]
