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
