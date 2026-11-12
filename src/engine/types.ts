export type DepType = 'FS' | 'SS' | 'FF' | 'SF'

export interface Calendar {
  /** Working weekdays, 0 = Sunday ... 6 = Saturday. */
  workingWeekdays: number[]
  /** Non-working dates as ISO strings (YYYY-MM-DD). */
  nonWorkingDates: string[]
  hoursPerDay: number
}
