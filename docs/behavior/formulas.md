# Formula language: observed behaviour

Source: `vectors/formulas-*.json`. "Cell result" means the value written into a cell of the stated column type.

## Types and where a result may go
- A formula's result type is fixed by the *destination column*. A boolean can only be stored in a
  **checkbox** column (`TRUE`/`FALSE`); in a text/number column it shows `#INVALID COLUMN VALUE`.
  A date can only be stored in a **date** column; in a checkbox column it shows `#BOOLEAN EXPECTED`,
  and a boolean in a date column `#DATE EXPECTED`. (Date minus date is a *number* and goes to a text/number column.)
- Concatenation is `+` and always yields text: `"a"+1` → `a1`, `1+"a"` → `1a`, `1+"2"` → `12`, `"1"+"2"` → `12`.
  There is **no `&` operator** (`#UNPARSEABLE`). `%` after a number is unparseable.
- Division by zero → `#DIVIDE BY ZERO`. Unknown function or bad syntax → `#UNPARSEABLE`.
- Wrong argument count → `#INCORRECT ARGUMENT SET`; wrong operand type → `#INVALID DATA TYPE` / `#INVALID OPERATION`;
  bad value for a function (e.g. month 13, `VALUE("x")`) → `#INVALID VALUE`; array literals `{1,2}` are not
  values (→ `#INVALID REF`); a cell referring to itself → `#CIRCULAR REFERENCE` (cells depending on it `#BLOCKED`).
- `IF(cond, a, b)`: the condition must be a boolean or exactly 0 or 1 (`IF(2,..)`, `IF("a",..)`, `IF("",..)`
  → `#INVALID DATA TYPE`; a blank cell as condition also errors). `IF(false, a)` with no third argument → blank.
- Numbers display to 5 decimals in text/number columns while the stored value keeps 15 significant digits.
- Blank cells: `ISBLANK` true; a blank number counts as 0 in arithmetic (`=-Num@row` → 0); a date cell that is blank
  gives a blank result in `Dt@row+1`.

## Operators
`+ - * / ^` (`2^10`=1024), unary minus, parentheses, comparisons `= <> < > <= >=` (case-insensitive text equality:
`"a"="A"` true; text compared by ordering). `AND`, `OR`, `NOT` take booleans. Precedence is the usual one.

## Functions observed to exist
Math: `ABS ROUND ROUNDUP ROUNDDOWN INT MOD` (`MOD(-10,3)`=2: result takes the sign of the divisor) `SUM AVG MIN MAX MEDIAN COUNT`.
`ROUND(2.5)`=3, `ROUND(-2.5)`=-3 (half away from zero), `INT(-2.5)`=-2 (truncates toward zero, unlike floor).
`COUNT` counts all non-blank arguments (`COUNT(1,2,"a")`=3). Range arguments `Col:Col` (whole column) and
`[Column Name]:[Column Name]` work in `SUM AVG COUNT`.
Conditional: `COUNTIF(range,">1")` and `SUMIF(range,">1")` and `AVERAGEIF(range,">0")` work; wildcards (`"a*"`) matched nothing
in the test (treat as unsupported until proven). `SUMIF`/`COUNTIFS`/`SUMIFS` with several ranges returned
`#INCORRECT ARGUMENT SET` in the test: re-check with explicit row ranges before relying on them.
Text: `LEFT RIGHT MID LEN UPPER LOWER SUBSTITUTE REPLACE VALUE CHAR`; `FIND("l","hello")`=3 (1-based), not found → 0;
`VALUE("12")`=12. **Not present** (unparseable): `SQRT POWER EXP LN LOG EVEN ODD PRODUCT PROPER TRIM CONCATENATE TEXT CLEAN FIXED NUMBER COUNTA EOMONTH DAYS`.
Dates: `DATE(y,m,d)` (overflow rolls: `DATE(2026,2,30)`=2026-03-02; month 13 → `#INVALID VALUE`), `DAY MONTH YEAR WEEKDAY`
(`WEEKDAY(Sun 2026-03-15)`=1; the 2-argument form is not accepted), `YEARDAY` (2026-03-15 → 74), `TODAY()`,
date±number adds/subtracts **calendar days**, date−date is a number of calendar days (`DATE(3/15)-DATE(3/1)`=14),
`NETDAYS(a,b)`=calendar days **inclusive** counted from a to b (3/1→3/15 = 15; reversed = -15),
`NETWORKDAYS(a,b)`=working days (Mon-Fri) inclusive (3/1 Sun → 3/15 Sun = 10),
`VARIANCE(a,b)`=b−a in calendar days on a sheet without project settings (14; reversed -14),
`WORKDAY(date,n)`: n≥1 moves forward n working days (Fri+1=Mon), n=0 returns the date *unchanged even if it is a weekend*,
negative n moves back (Sat−1=Fri). On a sheet with a project calendar the calendar's working days and holidays apply (to be confirmed).
`MAX`/`MIN` of dates return dates; `IF` can return dates.
Checks: `ISBLANK ISNUMBER ISTEXT ISBOOLEAN ISERROR ISDATE`. `IFERROR(x, y)`.

## Row and column references
`Column@row` (and `[Column Name]@row`) is the cell in the same row; `[Column]5` a specific row; `Column:Column` a column range.
Cross-sheet references use `{Reference Name}` (seen in real formulas: `COUNTIF({sheet_status}, "x")`). A formula typed in a
column header is a **column formula**: every cell of that column evaluates it for its own row.

## Hierarchy functions (rows `P1(c1=10,c2=20,c3=30)`, `P2(d1=5(g1=7), d2=8)`, `solo=99`)
- `COUNT(ANCESTORS())` = depth: 0 for top-level, 1 for children, 2 for grandchildren.
- `COUNT(CHILDREN())` = number of direct children (P1=3, P2=2, d1=1, leaves 0); `COUNT(DESCENDANTS())` all below (P2=3).
- `SUM(CHILDREN(Num@row))`: sum over **direct** children only: P1=60, P2=13, d1=7, leaves 0.
  `SUM(CHILDREN())` with no argument refers to the formula's own column and is therefore empty/0 in the test:
  the usual form passes the column (`CHILDREN([Cost]@row)`).
- `PARENT(Num@row)` is the parent's cell (g1 → d1's 5); blank for top-level.
- `SIBLINGS` does not exist. A formula that depends on its own column's children/parent errors with `#CIRCULAR REFERENCE`.
- Real-world patterns seen in project sheets: `=SUM(CHILDREN())` / `=MIN(CHILDREN())` roll-ups in parent rows,
  `=COUNT(ANCESTORS())` for the level, `=VARIANCE(Finish@row, Baseline Finish@row)` for baseline variance,
  `=CALCDURATION(start,end)`, `=CALCSTART(...)`, `=CALCPERCENT(CHILDREN(..),CHILDREN(Duration))`, `=WORKDAY(date,n)`,
  `=TODAY()+n`, `=IF(AND(..),"..",IF(..))` status flags with RYG text.

## Implementation notes for us
1. Evaluate with a type-aware destination (text/number, checkbox, date) and produce exactly these error names.
2. Keep our existing extras (NETDAYS name kept compatible) but add the missing functions above; where the
   reference *lacks* a function (SQRT, POWER, TRIM, ...) we may add it as an extension, flagged as ours.
3. Cell/column formulas must recalculate on dependency changes, detect cycles, and respect the hierarchy.

---

# Our implementation (status as of the formula-engine unit)

`src/formula/referenceConformance.test.ts` evaluates every vector in `vectors/formulas-*.json` through the real sheet
evaluator (a formula cell in a column of the stated type) and compares value, error name and display. All of them
pass except the entries of its `knownDifferences` list, each of which asserts what *we* return so it cannot drift.

## Where we deliberately differ (the `knownDifferences` list)
| Case | Reference | Ours | Why |
|---|---|---|---|
| `COUNTIF(Txt:Txt,"a*")` | 0 (no wildcards) | wildcards `*` and `?` work | the observation is marked uncertain; extension |
| `SUMIF(r,crit,sum_range)`, `COUNTIFS`, `SUMIFS` (+ `AVERAGEIF` 3-arg, `AVERAGEIFS`) | `#INCORRECT ARGUMENT SET` on whole-column ranges | implemented | extension, flagged `ours` in the registry; the notes ask to re-check with explicit row ranges |
| `SQRT`, `POWER`, `TRIM`, `CONCATENATE` | `#UNPARSEABLE` | implemented | extensions, flagged `ours` |
| `=SUM(CHILDREN()) + SUM(PARENT())` on rows `c1`, `c2` | `#BLOCKED` | `#CIRCULAR REFERENCE` | which members of a cycle the reference calls BLOCKED depends on its evaluation order; we say CIRCULAR for every cell on the cycle and BLOCKED only for cells that merely depend on one |

Other functions the reference lacks stay unparseable (`PRODUCT EXP LN LOG EVEN ODD COUNTA PROPER TEXT CLEAN FIXED NUMBER EOMONTH DAYS`, `SIBLINGS`).
`NETDAYS` now has the reference meaning (calendar days, both ends included); it used to count working days after the start.

## Types, blanks and results (as observed, plus the rules we derived to cover what was not observed)
- A cell value is typed by its **column**: a DATE column cell is a date, a CHECKBOX cell a boolean (unchecked = false), a DURATION cell a number of
  working days (`3d` is 3), anything else a number (numbers stored as text such as `"12"` read as numbers: ours, keeps older sheets working) or text.
- The **destination column** decides what a result may be (`T` text/number, `B` checkbox, `D` date; a DURATION column takes numbers as days):
  boolean fits only `B` (`T`: `#INVALID COLUMN VALUE`, `D`: `#DATE EXPECTED`); a date fits only `D` (`T`: `#INVALID COLUMN VALUE`, `B`: `#BOOLEAN EXPECTED`);
  a number fits `T`; in `B` only 0/1 (else `#BOOLEAN EXPECTED`); in `D` only 0, which is empty (else `#DATE EXPECTED`); text fits anywhere; an empty result is
  blank (`false` in a checkbox column).
- Blank arithmetic: a blank number is 0 (`-Num@row` is 0); a blank *date* stays blank next to a number, a date or another blank date
  (`Dt@row+1`, `Dt@row-Dt2@row`) but `Dt@row + Num@row` with both blank is `#INVALID OPERATION` (observed). Date functions of a blank date give blank (ours).
- Operand errors (derived): `+` with text concatenates; `- * / ^` with text give `#INVALID DATA TYPE`; booleans or dates where a number is needed
  give `#INVALID OPERATION`; date + number and number + date are dates, date - date is a number, date + date and number - date are `#INVALID OPERATION`.
  `^` binds tighter than `* /` and looser than unary minus, left to right (as in Excel: `-2^2` is 4, `2^3^2` is 64). Non-finite results are `#INVALID VALUE`.
- Comparison: text is case-insensitive; two numeric texts compare as numbers; a number and numeric text compare as numbers; a number is never equal to
  non-numeric text and ordering them is `#INVALID DATA TYPE`; a blank equals 0, "" or false; dates compare with dates and with ISO text.
- A formula's number result keeps 15 significant digits and is shown to 5 decimals.
- Errors in a cell that another formula reads propagate with the same name. Cycles are found on a static dependency graph (every branch of every formula,
  ranges as the whole column, CHILDREN/DESCENDANTS/ANCESTORS/PARENT as the rows they reach): `#CIRCULAR REFERENCE` for every cell that can reach itself,
  `#BLOCKED` for a cell that only depends on one.

## References
`Column@row`, `[Column Name]@row`, `[Column Name]5` (row 5, 1-based in sheet order), `Col:Col`, `[Col]:[Col]` (whole column), `[Col]2:[Col]9` (rows 2 to 9, ours)
and the older `[Column Title]` (the same row, or the whole column when it is a direct argument of SUM, COUNT, COUNTIF, ...). A range must stay within one column.
Column titles resolve exactly, then ignoring case. `{Name}` cross-sheet references and `{...}` array literals parse but evaluate to `#INVALID REF`
(reserved for the cross-sheet unit). An unknown column is `#UNPARSEABLE`. A row number out of range is `#INVALID REF`.

## Ours (derived): functions the reference has that we had to define ourselves
No observations exist for these; the semantics come from the Smartsheet documentation as we know it and from our scheduling engine (`src/engine/*`),
and use the sheet's calendar (working weekdays and non-working dates) wherever "working days" appear.
- `CALCDURATION(start, end)`: working days from `start` to `end`, both included (what the scheduler stores as a task's duration: a task starting
  on a Monday with 5 days ends on that Friday). `end` before `start` is `#INVALID VALUE`; a blank date gives blank. Returns a number (days); in a DURATION column it shows as `5d`.
- `CALCSTART(duration, end, [holidays])`: the start date that gives `duration` working days ending on `end` (an `end` that is not a working day counts
  back from the previous working day; 0 or 1 day gives that day itself). Round trip: `CALCDURATION(CALCSTART(n, e), e)` is n for n >= 1. A DURATION cell can be passed as `duration`.
- `CALCPERCENT(percents, durations)`: the duration-weighted percent complete of a group, rounded to a whole percent like the scheduler's summary rows;
  a plain average when all durations are 0; blank when there are no rows. Usual form: `=CALCPERCENT(CHILDREN([% Complete]@row), CHILDREN([Duration]@row))`.
- `NETWORKDAYS(a, b, [holidays])` and `WORKDAY(d, n, [holidays])` take an optional holidays range and use the sheet calendar; the reference sheet had none.
- `VARIANCE` is calendar days on every sheet (the reference's project-settings variant is not modelled).
- Collection helpers over ranges: `JOIN(range, [delimiter])`, `HAS(range, value)`, `INDEX(range, n)`, `MATCH(value, range, [type])` (exact match only),
  `DISTINCT(range)`. With an array literal they return `#INVALID REF`, as observed.
- Criteria of COUNTIF and friends: a value, or text with a leading `>`, `>=`, `<`, `<=`, `<>`, `=`; numbers, ISO dates and text (case-insensitive, `*`/`?` wildcards).

## Column formulas
A formula set on a column (`columns.formula`, migration `0007_column_formula.sql`) applies to every row whose own cell is empty. A cell's own value or
formula overrides it until the cell is cleared; a new row gets it with no copying. Not allowed in the primary column nor in schedule columns while
dependencies are on. In a checkbox column the result is shown as a read-only checkbox. Recalculation keeps the per-cell results of the previous version
of the sheet and the cells each result read, so an edit re-evaluates only the cells that depend on it (a change to columns, calendar or the row tree starts over).
