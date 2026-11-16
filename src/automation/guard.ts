/**
 * Run budget: how many times rules may run per minute. A runaway rule (for example one whose action
 * edits a cell that its own condition watches, through a chain of other rules) is cut off instead of
 * flooding the sheet. Pure apart from the injected clock.
 */
export interface RunGuard {
  /** Records a run and returns true, or returns false when the rule (or everyone together) is over budget. */
  tryRun(ruleId: string): boolean
}

export interface RunGuardOptions {
  now: () => number
  /** Default 30. */
  perRulePerMinute?: number
  /** Across all rules; default 120. */
  totalPerMinute?: number
}

const MINUTE = 60_000

export function createRunGuard(opts: RunGuardOptions): RunGuard {
  const perRule = opts.perRulePerMinute ?? 30
  const total = opts.totalPerMinute ?? 120
  const byRule = new Map<string, number[]>()
  let all: number[] = []
  return {
    tryRun(ruleId) {
      const t = opts.now()
      const recent = (byRule.get(ruleId) ?? []).filter((x) => x > t - MINUTE)
      all = all.filter((x) => x > t - MINUTE)
      if (recent.length >= perRule || all.length >= total) {
        byRule.set(ruleId, recent)
        return false
      }
      recent.push(t)
      all.push(t)
      byRule.set(ruleId, recent)
      return true
    },
  }
}
