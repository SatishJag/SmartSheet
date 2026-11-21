/**
 * Procore cost codes as the planner offers them (see supabase/migrations/0019_cost_codes.sql and
 * docs/superpowers/specs/2026-11-21-cost-code-link-design.md). Pure.
 */
import type { CostCode } from './types'

/** The dropdown text for a code, e.g. "GEN — Generator" (the sheet stores this text). */
export const costCodeOption = (c: CostCode): string => `${c.code} — ${c.description}`

/** The code filled in for an equipment type (exact match), or '' when it has none. */
export function codeForType(codes: readonly CostCode[], equipmentType: string): string {
  if (!equipmentType) return ''
  return codes.find((c) => c.equipmentType === equipmentType)?.code ?? ''
}

/** The dropdown text for a code, or undefined when the code is not on offer. */
export function optionForCode(codes: readonly CostCode[], code: string): string | undefined {
  const found = code ? codes.find((c) => c.code === code) : undefined
  return found ? costCodeOption(found) : undefined
}
