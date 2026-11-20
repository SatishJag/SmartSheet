/**
 * Phone numbers as the WhatsApp assistant stores them: digits only, with the country code, no '+'
 * (E.164 without the plus). WhatsApp Cloud API reports senders in exactly this form.
 */
export const PHONE_RE = /^[1-9][0-9]{7,14}$/

/** Digits of `input` when it is a plausible international number, else null. "00" prefixes count as "+". */
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim()
  if (!/^[+0-9\s().-]+$/.test(trimmed)) return null
  let digits = trimmed.replace(/[^0-9]/g, '')
  if (!trimmed.startsWith('+') && digits.startsWith('00')) digits = digits.slice(2)
  return PHONE_RE.test(digits) ? digits : null
}

/** "+971 ••• ••4567": enough to recognise a number in logs and the UI without showing all of it. */
export function maskPhone(phone: string): string {
  if (phone.length <= 4) return phone
  return `+${phone.slice(0, Math.min(3, phone.length - 4))} ••• ${phone.slice(-4)}`
}
