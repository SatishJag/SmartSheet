-- Column formulas: a formula set on a COLUMN applies to every row whose own cell is empty (a cell's
-- own value or formula overrides it until cleared; new rows get it automatically). It is stored on
-- the column, with its leading '=', so nothing is copied into the rows.
--
-- Additive and nullable: existing columns keep formula = null and behave exactly as before. Row-level
-- security is unchanged: the columns_owner policy (0002) and the table grants (0001) cover the new
-- column.

alter table columns add column formula text;

alter table columns
  add constraint columns_formula_check
  check (formula is null or (left(formula, 1) = '=' and length(formula) <= 2000));
