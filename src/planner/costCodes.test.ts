import { describe, expect, it } from 'vitest'
import { codeForType, costCodeOption, optionForCode } from './costCodes'
import type { CostCode } from './types'

const CODES: CostCode[] = [
  { code: 'CHL', description: 'Chiller', equipmentType: 'Chiller' },
  { code: 'HVS', description: 'HV SiwtchGear', equipmentType: 'HV switchgear' },
  { code: 'X', description: 'Unmapped', equipmentType: null },
]

describe('cost codes', () => {
  it('formats an option as code, em dash, description', () => {
    expect(costCodeOption(CODES[1])).toBe('HVS — HV SiwtchGear')
  })

  it('finds the code for an exact equipment type, else empty', () => {
    expect(codeForType(CODES, 'HV switchgear')).toBe('HVS')
    expect(codeForType(CODES, 'hv switchgear')).toBe('')
    expect(codeForType(CODES, 'Crane')).toBe('')
    expect(codeForType(CODES, '')).toBe('')
  })

  it('finds the option text for a code, undefined when not offered', () => {
    expect(optionForCode(CODES, 'CHL')).toBe('CHL — Chiller')
    expect(optionForCode(CODES, 'UPS')).toBeUndefined()
    expect(optionForCode(CODES, '')).toBeUndefined()
  })
})
