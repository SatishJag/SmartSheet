# Observed behaviour of the reference product (clean-room specification)

Why this exists: we are building a competitor to Smartsheet. To match the behaviour users expect, we
observed the reference product as a user would, through its public API, and recorded *what goes in and
what comes out*. Nothing here comes from its code (no decompiling, no scraping) and no data from the
account used is stored: every input below is synthetic, made up for the experiment. Our implementation
is written from scratch against these observations.

Contents
- `formulas.md`: the formula language: types, operators, functions, errors, hierarchy functions.
- `scheduling.md`: dates, durations, dependencies, calendars and roll-ups of project sheets.
- `vectors/*.json`: the raw experiments, usable as test fixtures:
  - `formulas-text-column.json`: 130 expressions evaluated into a text/number column. NOTE: booleans and
    dates cannot be stored in a text column, so those show `#INVALID COLUMN VALUE` here; see the next file.
  - `formulas-typed-columns.json`: ~80 expressions evaluated into text, checkbox and date columns side
    by side (`T`, `B`, `D`): the column type decides what a result may be.
  - `formulas-hierarchy.json`: hierarchy functions on a fixed parent/child tree (see the file header in `formulas.md`).
  - `scheduling-dependencies.json`: 24 scheduling scenarios with the calendar used (Mon-Fri, one holiday).

How the experiments were run (reproducible): create a scratch sheet in the account, write the inputs,
read back the computed cells, delete the sheet. Project sheets cannot be created through the API, so a
structure-only copy (no rows) of an existing project sheet was used and deleted afterwards. A further
conformance check ran our engine over 1,244 rows of real project data read-only (nothing stored).

Known limits of this method: results hold for the product version observed on 2026-11-16 (server
554.0.0); things that send e-mail (automation, update requests) were not triggered; reports and
dashboards cannot be created through the API, so their behaviour comes from reading existing ones and
from the published documentation.
