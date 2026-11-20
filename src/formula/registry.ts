/**
 * The function registry: name, signature, one-line description and argument counts of every
 * formula function. Pure data: the parser checks argument counts against it and the formula
 * editor's autocomplete lists it. The implementations live in functions.ts.
 */

export type FunctionCategory = 'Math' | 'Aggregate' | 'Conditional' | 'Text' | 'Date' | 'Logic' | 'Hierarchy' | 'List' | 'Project'

export interface FunctionInfo {
  name: string
  /** e.g. `ROUND(number, [digits])`; square brackets mark optional arguments. */
  signature: string
  summary: string
  category: FunctionCategory
  min: number
  max: number
  /** An extension of ours that the reference product does not have (see docs/behavior/formulas.md). */
  ours?: boolean
}

const INF = Number.POSITIVE_INFINITY

const f = (
  category: FunctionCategory,
  signature: string,
  summary: string,
  min: number,
  max: number,
  ours = false,
): FunctionInfo => ({ name: signature.slice(0, signature.indexOf('(')), signature, summary, category, min, max, ...(ours ? { ours: true } : {}) })

export const FUNCTIONS: readonly FunctionInfo[] = [
  // math
  f('Math', 'ABS(number)', 'Absolute value.', 1, 1),
  f('Math', 'ROUND(number, [digits])', 'Rounds half away from zero.', 1, 2),
  f('Math', 'ROUNDUP(number, [digits])', 'Rounds away from zero.', 1, 2),
  f('Math', 'ROUNDDOWN(number, [digits])', 'Rounds toward zero.', 1, 2),
  f('Math', 'INT(number)', 'Drops the decimals (truncates toward zero: INT(-2.5) is -2).', 1, 1),
  f('Math', 'MOD(number, divisor)', 'Remainder; the result takes the sign of the divisor.', 2, 2),
  f('Math', 'CEILING(number, factor)', 'Rounds up to a multiple of the factor.', 2, 2),
  f('Math', 'FLOOR(number, factor)', 'Rounds down to a multiple of the factor.', 2, 2),
  f('Math', 'SQRT(number)', 'Square root (extension).', 1, 1, true),
  f('Math', 'POWER(number, power)', 'Number raised to a power (extension).', 2, 2, true),
  // aggregates
  f('Aggregate', 'SUM(value1, [value2, ...])', 'Adds numbers; ranges and lists skip text and blanks.', 1, INF),
  f('Aggregate', 'AVG(value1, [value2, ...])', 'Average of the numbers.', 1, INF),
  f('Aggregate', 'MIN(value1, [value2, ...])', 'Smallest number or earliest date.', 1, INF),
  f('Aggregate', 'MAX(value1, [value2, ...])', 'Largest number or latest date.', 1, INF),
  f('Aggregate', 'MEDIAN(value1, [value2, ...])', 'Middle value of the numbers.', 1, INF),
  f('Aggregate', 'COUNT(value1, [value2, ...])', 'Counts the values that are not blank.', 1, INF),
  // conditional
  f('Conditional', 'COUNTIF(range, criterion)', 'Counts cells that match, e.g. ">1" or "done".', 2, 2),
  f('Conditional', 'SUMIF(range, criterion, [sum_range])', 'Adds the cells that match.', 2, 3),
  f('Conditional', 'AVERAGEIF(range, criterion, [average_range])', 'Averages the cells that match.', 2, 3),
  f('Conditional', 'COUNTIFS(range1, criterion1, [range2, criterion2, ...])', 'Counts rows where every criterion matches (extension).', 2, INF, true),
  f('Conditional', 'SUMIFS(sum_range, range1, criterion1, ...)', 'Adds where every criterion matches (extension).', 3, INF, true),
  f('Conditional', 'AVERAGEIFS(average_range, range1, criterion1, ...)', 'Averages where every criterion matches (extension).', 3, INF, true),
  // text
  f('Text', 'LEFT(text, [count])', 'The first characters of the text.', 1, 2),
  f('Text', 'RIGHT(text, [count])', 'The last characters of the text.', 1, 2),
  f('Text', 'MID(text, start, count)', 'Characters from a 1-based position.', 3, 3),
  f('Text', 'LEN(text)', 'Number of characters.', 1, 1),
  f('Text', 'UPPER(text)', 'Upper case.', 1, 1),
  f('Text', 'LOWER(text)', 'Lower case.', 1, 1),
  f('Text', 'SUBSTITUTE(text, old, new, [instance])', 'Replaces text; all matches unless an instance is given.', 3, 4),
  f('Text', 'REPLACE(text, start, count, new)', 'Replaces characters by position.', 4, 4),
  f('Text', 'FIND(search, text, [start])', '1-based position of the text, 0 when absent.', 2, 3),
  f('Text', 'VALUE(text)', 'Converts text such as "12" to a number.', 1, 1),
  f('Text', 'CHAR(code)', 'The character with this code.', 1, 1),
  f('Text', 'TRIM(text)', 'Removes leading, trailing and repeated spaces (extension).', 1, 1, true),
  f('Text', 'CONCATENATE(text1, [text2, ...])', 'Joins texts; same as + (extension).', 1, INF, true),
  // dates
  f('Date', 'DATE(year, month, day)', 'A date; days past the end of a month roll over.', 3, 3),
  f('Date', 'TODAY()', "Today's date.", 0, 0),
  f('Date', 'DAY(date)', 'Day of the month.', 1, 1),
  f('Date', 'MONTH(date)', 'Month number.', 1, 1),
  f('Date', 'YEAR(date)', 'Year.', 1, 1),
  f('Date', 'WEEKDAY(date)', 'Day of the week: 1 = Sunday ... 7 = Saturday.', 1, 1),
  f('Date', 'YEARDAY(date)', 'Day of the year, 1 to 366.', 1, 1),
  f('Date', 'DATEONLY(date)', 'The date without any time.', 1, 1),
  f('Date', 'NETDAYS(start, end)', 'Calendar days from start to end, both included.', 2, 2),
  f('Date', 'NETWORKDAYS(start, end, [holidays])', 'Working days from start to end, both included.', 2, 3),
  f('Date', 'VARIANCE(date1, date2)', 'Calendar days from date1 to date2.', 2, 2),
  f('Date', 'WORKDAY(date, days, [holidays])', 'The date a number of working days away.', 2, 3),
  // logic
  f('Logic', 'IF(condition, if_true, [if_false])', 'Chooses a value; the condition is true/false (or 1/0).', 2, 3),
  f('Logic', 'IFERROR(value, [value_if_error])', 'The value, or a fallback when it is an error.', 1, 2),
  f('Logic', 'AND(condition1, [condition2, ...])', 'True when every condition is true.', 1, INF),
  f('Logic', 'OR(condition1, [condition2, ...])', 'True when any condition is true.', 1, INF),
  f('Logic', 'NOT(condition)', 'Reverses true and false.', 1, 1),
  f('Logic', 'ISBLANK(value)', 'True for an empty cell.', 1, 1),
  f('Logic', 'ISNUMBER(value)', 'True for a number.', 1, 1),
  f('Logic', 'ISTEXT(value)', 'True for text.', 1, 1),
  f('Logic', 'ISBOOLEAN(value)', 'True for true/false.', 1, 1),
  f('Logic', 'ISDATE(value)', 'True for a date.', 1, 1),
  f('Logic', 'ISERROR(value)', 'True when the value is an error.', 1, 1),
  // hierarchy
  f('Hierarchy', 'CHILDREN([cell])', "The cell's column in the direct child rows (own column when omitted).", 0, 1),
  f('Hierarchy', 'DESCENDANTS([cell])', "The cell's column in every row below.", 0, 1),
  f('Hierarchy', 'ANCESTORS([cell])', "The cell's column in every parent row up to the top. COUNT(ANCESTORS()) is the level.", 0, 1),
  f('Hierarchy', 'PARENT([cell])', "The cell's column in the parent row (blank at the top level).", 0, 1),
  // lists
  f('List', 'JOIN(range, [delimiter])', 'Joins the values with a delimiter (default ", ").', 1, 2),
  f('List', 'HAS(range, value)', 'True when the value is in the range.', 2, 2),
  f('List', 'INDEX(range, position)', 'The value at a 1-based position.', 2, 2),
  f('List', 'MATCH(value, range, [type])', '1-based position of the value in the range, 0 when absent.', 2, 3),
  f('List', 'DISTINCT(range)', 'The values without repeats.', 1, 1),
  // project (ours, derived from the scheduling engine: docs/behavior/formulas.md)
  f('Project', 'CALCDURATION(start, end)', 'Working days from start to end, both included (sheet calendar).', 2, 2),
  f('Project', 'CALCSTART(duration, end, [holidays])', 'The start that gives this many working days ending on end.', 2, 3),
  f('Project', 'CALCPERCENT(percents, durations)', 'Duration-weighted % complete of a group, e.g. of CHILDREN(...).', 2, 2),
]

const byName = new Map(FUNCTIONS.map((fn) => [fn.name, fn]))

export const functionInfo = (name: string): FunctionInfo | undefined => byName.get(name.toUpperCase())

/** Functions whose name starts with `prefix` (case-insensitive), alphabetical; all of them for an empty prefix. */
export function matchFunctions(prefix: string): FunctionInfo[] {
  const p = prefix.toUpperCase()
  return FUNCTIONS.filter((fn) => fn.name.startsWith(p)).sort((a, b) => a.name.localeCompare(b.name))
}
