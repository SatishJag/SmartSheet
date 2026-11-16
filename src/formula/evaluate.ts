/**
 * Formula evaluator: parser + interpreter. Pure and dependency-free. Never uses eval/new Function
 * and never throws: every failure is a result with one of the reference product's error names
 * (`#DIVIDE BY ZERO`, `#UNPARSEABLE`, ...) and an explanation for the cell tooltip.
 *
 * What a formula may return depends on the destination column (`ctx.dest`): text/number,
 * checkbox, date or duration; see `finish` in values.ts and docs/behavior/formulas.md.
 */
import { defaultCalendar } from '../engine/calendar'
import { formatDuration } from '../engine/duration'
import { Interp, type FormulaContext } from './interp'
import { parseFormula } from './parse'
import { ERROR_HELP, FormulaError, finish, type ErrorName, type FormulaValue } from './values'

export type { CellKind, FormulaContext } from './interp'
export type { Dest, ErrorName, FormulaValue } from './values'
export { ERROR_HELP } from './values'

export type FormulaResult =
  | { ok: true; value: FormulaValue }
  | { ok: false; error: ErrorName; message: string }

const failure = (e: unknown): FormulaResult => {
  if (e instanceof FormulaError) return { ok: false, error: e.code, message: e.message }
  const message = e instanceof Error ? e.message : String(e)
  return { ok: false, error: '#UNPARSEABLE', message }
}

/** The text after the leading `=`, or a failure when the text is not a formula. */
function body(formula: unknown): string | FormulaResult {
  if (typeof formula !== 'string' || !formula.trimStart().startsWith('=')) {
    return { ok: false, error: '#UNPARSEABLE', message: "Formula must start with '='" }
  }
  return formula.trimStart().slice(1)
}

export function evaluate(formula: string, ctx: FormulaContext): FormulaResult {
  const src = body(formula)
  if (typeof src !== 'string') return src
  try {
    const ast = parseFormula(src)
    const value = new Interp(ctx).eval(ast)
    const hoursPerDay = (ctx.calendar ?? defaultCalendar).hoursPerDay
    return {
      ok: true,
      value: finish(value, ctx.dest ?? 'any', (days) => formatDuration({ minutes: Math.round(days * hoursPerDay * 60), elapsed: false }, hoursPerDay)),
    }
  } catch (e) {
    return failure(e)
  }
}

/** Whether the formula can be read at all (syntax, function names, argument counts), without evaluating it. */
export function checkFormula(formula: string): { ok: true } | { ok: false; error: ErrorName; message: string } {
  const src = body(formula)
  if (typeof src !== 'string') return src as { ok: false; error: ErrorName; message: string }
  try {
    parseFormula(src)
    return { ok: true }
  } catch (e) {
    return failure(e) as { ok: false; error: ErrorName; message: string }
  }
}

/** The explanation for an error name, for tooltips. */
export const explainError = (name: ErrorName): string => ERROR_HELP[name]
