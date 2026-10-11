// SMTP dot-atom local parts are limited to 64 ASCII characters.
export function isValidMailboxName(value: string): boolean {
  return value.length > 0 && value.length <= 64 &&
    /^[a-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[a-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/i.test(value)
}
