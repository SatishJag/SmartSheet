// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readWorkbook, toIsoDate } from './workbook'

const FIXTURE = resolve(__dirname, '__fixtures__/plan-template.xlsx')
const fixtureFile = () => new File([readFileSync(FIXTURE)], 'Plan template.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })

describe('readWorkbook', () => {
  it('reads every sheet of an .xlsx file, cells as text', async () => {
    const wb = await readWorkbook(fixtureFile())
    expect(wb.fileName).toBe('Plan template.xlsx')
    expect(wb.sheets.map((s) => s.name)).toEqual(['Schedule Template', 'Basis of Plan'])
    const rows = wb.sheets[0].rows
    expect(rows[6][0]).toBe('Activity ID')
    expect(rows[7].slice(0, 3)).toEqual(['P010', '01 Feasibility', 'Define development brief and feasibility'])
    expect(rows[7][5]).toBe('40')
  })

  it('turns date cells into ISO dates and keeps serial numbers as text', async () => {
    const rows = (await readWorkbook(fixtureFile())).sheets[0].rows
    expect(rows[9][6]).toBe('2027-01-04') // P030 baseline start, a date cell
    expect(rows[9][7]).toBe('2027-01-29')
    expect(rows[11][7]).toBe('46000') // P040 baseline finish, a plain number
  })

  it('reads a .csv file as one sheet named after the file', async () => {
    const wb = await readWorkbook(new File(['Activity,Duration\nDig,5\n'], 'My plan.csv', { type: 'text/csv' }))
    expect(wb.sheets).toEqual([{ name: 'My plan', rows: [['Activity', 'Duration'], ['Dig', '5']] }])
  })

  it('refuses other file types', async () => {
    await expect(readWorkbook(new File(['x'], 'plan.pdf'))).rejects.toThrow('Choose an .xlsx or .csv file')
  })

  it('refuses a file over 10 MB', async () => {
    const big = new File(['x'], 'big.xlsx')
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 })
    await expect(readWorkbook(big)).rejects.toThrow('"big.xlsx" is larger than 10 MB')
  })
})

describe('toIsoDate', () => {
  it('accepts ISO dates, day/month/year and Excel serial numbers', () => {
    expect(toIsoDate('2028-06-30')).toBe('2028-06-30')
    expect(toIsoDate('30/06/2028')).toBe('2028-06-30')
    expect(toIsoDate('46000')).toBe('2025-12-09')
    expect(toIsoDate(' 2028-06-30 ')).toBe('2028-06-30')
  })

  it('rejects anything else', () => {
    expect(toIsoDate('')).toBeNull()
    expect(toIsoDate('soon')).toBeNull()
    expect(toIsoDate('31/02/2028')).toBeNull()
    expect(toIsoDate('12')).toBeNull() // too small to be a plausible serial date
  })
})
