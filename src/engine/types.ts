export type DepType = 'FS' | 'SS' | 'FF' | 'SF'

export interface Calendar {
  /** Working weekdays, 0 = Sunday ... 6 = Saturday. */
  workingWeekdays: number[]
  /** Non-working dates as ISO strings (YYYY-MM-DD). */
  nonWorkingDates: string[]
  hoursPerDay: number
  /**
   * What a typed start date that falls on a non-working day does. 'shift' (the default when absent)
   * moves it to the next working day; 'keep' keeps it and counts the duration from it with that day
   * as day 1 (the observed behaviour of the reference product). Dates driven by dependencies are
   * always working days either way.
   */
  nonWorkingStart?: 'shift' | 'keep'
}
