# Project scheduling: observed behaviour

Source: `vectors/scheduling-dependencies.json` (24 scenarios) and a read-only conformance run over 1,244 rows of
real project sheets (summary only). Calendar of the scenarios: Mon-Fri, 8 h/day, holiday Thu 2026-03-12.
Base task A: start Mon 2026-03-02, 3 days → ends Wed 03-04.

## Dates and durations
- Duration is in working days (`5d`, `0d` milestone); end = the working day that is (duration-1) working days after the start.
  A 5-day task starting Mon 03-09 with the Thu 03-12 holiday ends **Mon 03-16** (Mon, Tue, Wed, Fri, Mon).
- A task starting Fri 03-06 with 2 days ends Mon 03-09.
- **A typed start on a non-working day is kept**, and the duration is counted from it with that day as day 1:
  start Sat 03-14, 2 days → ends Mon 03-16; start Sun 03-15, 1 day → ends Sun 03-15. (Our engine currently moves
  such a start to the next working day. Of 1,244 real rows, 243 differ for exactly this reason; the other 1,000 matched.)
- Summary (parent) rows take the earliest child start and latest child end; their duration is the number of working
  days between them inclusive (Parent 03-02→03-11 = 8d).

## Dependencies (predecessor A ends Wed 03-04, starts Mon 03-02; successor duration 2d unless stated)
| Link | Lag | Result (start → end) | Rule |
| --- | --- | --- | --- |
| FS | 0 | 03-05 → 03-06 | start = next working day after the predecessor's end |
| FS | +1d | 03-06 → 03-09 | lag counts working days after that |
| FS | -1d (lead) | 03-04 → 03-05 | lead moves one working day earlier |
| FS | +3d | 03-10 → 03-11 | |
| SS | 0 / +2d | 03-02 → 03-03 / 03-04 → 03-05 | start = predecessor's start (+ lag working days) |
| FF | 0 / +1d | 03-03 → 03-04 / 03-04 → 03-05 | end = predecessor's end (+ lag) |
| **SF** | 0 | **02-26 → 02-27** | end = the working day **before** the predecessor's start |
| SF | +2d | 03-02 → 03-03 | end = (predecessor start + lag) − 1 working day |
| FS, duration 0 (milestone) | 0 | **03-04 → 03-04** | a milestone lands on the predecessor's **end date**, not the next day |
| FS, duration 1 | 0 | 03-05 → 03-05 | |
| FS after B (ends Mon 03-09) | 0 | 03-10 → 03-11 | crossing a weekend |
| FS after C (ends Mon 03-16, holiday inside) | 0 | 03-17 → 03-18 | |
| FS A **and** SS C+3d | | 03-13 → 03-16 | several predecessors: the **latest** constraint wins; C starts 03-09, +3 working days skipping the 03-12 holiday = 03-13 |
| FS B and FS C | | 03-17 → 03-18 | |

## Where we differ today (to change, with the engine's inverse/backward pass kept consistent)
1. Non-working typed start: keep it and count from it (option; default decision in the build notes).
2. SF link: end = predecessor start − 1 working day (+ lag).
3. Zero-duration FS successor: lands on the predecessor's finish date.
Everything else listed above already matches our engine.

## Implementation notes (engine conformance, added)
`src/engine/referenceConformance.test.ts` runs all 24 scenarios above through `schedule()`; all pass with
`Calendar.nonWorkingStart = 'keep'`, and every scenario except the two weekend-typed ones passes with the default.

- **SF** (observed lag 0 and +2d): successor end = `addWorkingDays(anchor(pred start), lag - 1)`, successor start counted back from
  that end. So lag +1d puts the successor's end ON the predecessor's start day; lag -1d is two working days before it.
- **FS onto a zero-duration successor** (observed lag 0 only). Derived rule for other lags: the milestone date is
  `addWorkingDays(anchor(pred end), lag)`, i.e. the predecessor's end date shifted by `lag` working days (lag +1d = the next
  working day, -1d = the previous one). This is the same as "the day before the date a task would start", which is also how
  the SF rule is stated, so both observations follow one principle: a zero-length or end-anchored element is placed at the end
  of the working day before the day a task would have started. Not observed, so chosen for consistency: SS, FF and SF onto a
  milestone keep their task rules unchanged (SS: pred start + lag; FF: pred end + lag; SF: the end formula above, which for a
  milestone is its date). Zero duration is detected from the typed duration (0 minutes), never from a start/end comparison.
- **anchor(date)** = the first working day on or after `date`. A predecessor's start/end can be a non-working day (an elapsed
  duration, or a kept weekend start); lags always count working days from the anchor, so SS/SF/FS-milestone are monotone in the
  lag. The older elapsed-end FF rule (`addWorkingDays` strictly after the date, so lag 0 and +1 both give the next working day)
  is unchanged and pinned in `schedule.test.ts`; it is the one place where one more day of lag can move nothing.
- **`nonWorkingStart: 'keep'`** (calendar JSON, absent = `'shift'`): a typed Start on a non-working day stays, day 1 is that day
  and working days are counted strictly after it (end = start when duration <= 1). Only typed starts are kept; every date a
  dependency produces is still a working day. A summary row spanning only non-working days reports a duration of 0 days
  (working days between its start and end). Not observed: how the reference rolls such a summary up.
- **Float** (`criticalPath.ts`): the backward pass inverts the new SF and milestone rules exactly; with `'keep'` a project end
  (or a row end) on a non-working day bounds working-day rows by the working day before it, and a row with zero float reports its
  early dates as its late dates. The randomized property test (delay by float keeps the finish, one day more moves it) runs for
  both options, both calendars, with SF links, milestones and weekend-typed starts.
