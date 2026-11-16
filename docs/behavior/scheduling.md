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
