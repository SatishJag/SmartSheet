# Design system

The UI follows the PMIS design language: warm off-white pages, large rounded cards with soft
shadows, pill buttons, a single brand accent (orange by default) and a quiet neutral chrome. It is
plain CSS (no Tailwind): everything lives in CSS custom properties in `src/theme.css`.

Two densities share one token set:

- **Airy** (sheet list, wizard, dialogs): cards, generous whitespace, springy `.lift` hover.
- **Dense** (Grid and Gantt inside a sheet): 32px rows, 13px type, tabular numerals, sticky header
  and first columns. A **Compact / Comfortable** switch in the sheet toolbar (Comfortable = 40px rows,
  14px type) is remembered in `localStorage` (`smartsheet-density`).

| Before | After |
| --- | --- |
| ![Grid before](before-grid.png) | ![Grid after](grid.png) |
| ![Gantt before](before-gantt.png) | ![Gantt after](gantt-critical.png) |

## Tokens (`src/theme.css`)

| Group | Tokens |
| --- | --- |
| Brand scale | `--b50 ... --b800` as space-separated RGB triplets, so alpha works: `rgb(var(--b700) / .4)`. `data-theme` on `<html>` swaps the whole scale. |
| Brand shortcuts | `--accent` (b700: text, links, primary buttons), `--accent-strong` (b800), `--accent-fill` (b600: bars/indicators), `--accent-soft` / `--accent-soft-2` (tints), `--on-accent` |
| Neutrals | `--ink` `#16181d`, `--ink-2` (secondary text, 9:1), `--ink-3` (muted text, 5.6:1+), `--page` `#faf9f7`, `--surface`, `--surface-2`, `--line`, `--line-2`, `--line-strong` (form outlines, 3.6:1) |
| Status | `--danger`, `--warn`, `--ok`, `--info` (+ `-soft` backgrounds), all >= 4.5:1 as text; `--crit` is the critical-path colour (an RGB triplet) |
| Radius | `--r-xs 6` `--r-sm 10` `--r-md 16` `--r-lg 24` `--r-pill 999` |
| Shadow | `--shadow-card`, `--shadow-lift` (tinted by the brand), `--shadow-pop` (menus, dialogs), `--ring` (focus ring) |
| Type | `--font` Plus Jakarta Sans (Google Fonts `<link>` in `index.html`, `display=swap`) with a system-font fallback so it renders offline. Scale: 11/12 (labels, hints), 13 (dense data), 14-15 (body), 18-20 (titles), 28 (page title); weights 500/600/700/800 |
| Spacing | 4/8px rhythm (4, 8, 12, 16, 24, 32) |
| Layout | `--header-h`, `--page-pad`, `--control-h` (38px, 44px on touch devices) |

Contrast was checked for every theme: white on `--b700` is 5.0:1 (green) to 17.9:1 (black); brand text
on tinted backgrounds uses `--b800` (>= 6.1:1); bar outlines use `--b600` (>= 3.3:1 on white).
The bright steps (b300 to b500) are only ever fills.

### Shared classes

`.card`, `.lift` (springy hover; fully disabled under `prefers-reduced-motion`), `.btn` / `.btn-primary`
/ `.btn-ghost` / `.btn-danger` / `.btn-sm` / `.btn-icon`, `.input` / `.label`, `.chip`, `.segmented`
(pill switch; selected = `aria-selected` or `aria-pressed`), `.progress` (striped), `.skeleton`, `kbd`,
`.rise` (entrance for things that open on demand). Plain `<button>`, `<input>`, `<select>` are styled
by default (with zero specificity, so any class wins), which means new screens, including the AI
wizard, get the look without any markup changes.

## Themes

Eight themes: orange (default), blue, purple, green, red, teal, grey, black. The `ThemePicker`
(`src/ui/ThemePicker.tsx`) is a swatch popover in the app header. The choice is saved in
`localStorage` (`smartsheet-theme`, inside try/catch), written to `data-theme` on `<html>` and to the
`theme-color` meta tag. An inline script in `index.html` applies it before first paint, so there is no
flash.

**Add a theme:**

1. In `src/theme.css` add `[data-theme='name'] { --b50: ...; ... --b800: ...; }` (9 steps, RGB triplets).
   Check white on `--b700` >= 4.5:1 and `--b800` on `--b100` >= 4.5:1.
2. In `src/ui/theme.ts` add `{ id, label, color }` to `THEMES` (`color` = the b600/b700 hex).
3. In `index.html` add the id and colour to the `bar` map of the inline script.
4. If the brand colour is close to red, override `--crit` for the theme (see the `red` theme).

![Theme picker](theme-picker.png)

## Components

| Component | Where |
| --- | --- |
| App shell: sticky translucent header, brand mark, theme picker | `src/App.tsx`, `src/App.css` |
| Sheet list: template radio cards, "Plan with AI" feature card, sheet card grid, empty state, skeletons | `src/auth/SheetList.tsx`, `sheetList.css` |
| Sheet header: breadcrumb (Sheets > name, inline rename), save-status pill, notices | `src/views/SheetView.tsx`, `sheetView.css`, `grid/SaveStatusBadge.tsx` |
| Toolbar: view switch (`.segmented` tabs), Schedule settings, Critical path switch, density toggle | `src/views/SheetView.tsx` |
| Density context (`ROW_HEIGHTS`, `useDensity`) | `src/views/density.tsx` |
| Grid | `src/views/grid/grid.css` |
| Gantt (+ Day / Week / Month zoom) | `src/views/gantt/` |
| Kanban | `src/views/kanban/kanban.css` |
| Dialogs, menus | `src/views/confirmDialog.css`, `scheduleSettings.css`, `grid/columnMenu.css` |
| Icons (one inline-SVG set, 1.8 stroke, `currentColor`, decorative) | `src/ui/Icon.tsx` |

### Screens

| | |
| --- | --- |
| ![Empty list](list-empty.png) | ![List](list.png) |
| ![Grid](grid.png) | ![Grid comfortable](grid-comfortable.png) |
| ![Gantt critical path](gantt-critical.png) | ![Gantt week zoom](gantt-week-zoom.png) |
| ![Kanban](kanban.png) | ![Schedule settings](dialog-schedule-settings.png) |
| ![Confirm](dialog-confirm.png) | |

Mobile (390x844):

| List | Grid | Gantt | Kanban |
| --- | --- | --- | --- |
| ![](mobile-list.png) | ![](mobile-grid.png) | ![](mobile-gantt.png) | ![](mobile-kanban.png) |

## Design decisions

- **Grid.** Calmer header row, faint separators, tabular numerals, sticky row number and first
  column (`--rn-w` is set from the real column width), brand-coloured selection and active cell,
  parent rows tinted and bold, read-only (calculated) cells slightly darker. The status column keeps its
  text and adds a shape-coded dot (open ring, half, filled, square) so status never depends on colour;
  % Complete draws a thin progress bar from `--pct`. Row height stays a JS value
  (`ROW_HEIGHT` / `useDensity().rowHeight`, applied inline), so the virtualizer and CSS cannot drift.
- **Gantt.** Two-tier header (month / day, thinning to Mondays and then to the 1st and 15th when
  zoomed out), weekend and non-working-day shading, today line in the accent colour, bars with a
  brand outline and a diagonal-striped progress fill (SVG `<pattern>`), milestone diamonds, dark summary
  brackets, crimson critical bars and arrows with a text "Critical" / "Nd float" badge beside the
  label, elbow dependency arrows. The Day / Week / Month zoom only changes the day width; passing the
  `dayWidth` prop still fixes the scale (tests rely on it).
- **Accessibility.** Visible focus ring everywhere, `prefers-reduced-motion` removes the springy hover
  and animations, 44px controls on touch devices (grid and Gantt toggles get larger invisible hit
  areas), no horizontal page scroll at 390px (grid and Gantt scroll in their own panes).
- **Skeletons** replace bare "Loading..." text; the original text stays as screen-reader text.

## Plan with AI wizard

The AI planner (`src/planner/PlannerWizard.tsx`, `PlanPreview.tsx`, `plannerWizard.css`) is a flagship
flow, so it gets the full treatment rather than inheriting the base button and input styles. It is
still two steps with the same behaviour; only the presentation changed.

- **Shell.** A header (sparkles mark, title, "1 Request - 2 Review plan" step indicator, close), a
  scrolling body on the warm page background holding white cards, and a **sticky footer** that always
  holds the step's actions (Cancel / Generate, then Back / Regenerate / Create schedule). Validation
  and request failures are pinned in a bar just above the footer so they are never scrolled away.
  Below 640px it is a full-height sheet: footer buttons are 44px, "Create schedule" takes its own row,
  tables scroll inside their own pane, and nothing scrolls sideways.
- **Request.** Equipment with history are selectable tiles (glyph, name, "8 projects", check badge;
  a visually hidden checkbox underneath keeps the keyboard and screen-reader behaviour). Chosen items
  are compact rows (type, name, date, remove icon on one line; they wrap on narrow screens). "Use the
  same date for all" is a switch with the shared date beside it. Field errors use the danger token
  with an icon and `aria-describedby`.
- **Loading.** A striped indeterminate `.progress`, shimmering skeleton cards and a Cancel button.
- **Review.** An overview card (items, earliest required start, late count, status chips, one
  SAMPLE-data warning), then an accordion card per item: header chips (On time / Late, AI draft or
  History only, Sample data), a green or red status banner with icon and text, a source badge, and an
  activities table with a sticky header and first column, tabular numerals, zebra rows, a duration
  bar, basis chips (p50 / p80 / Default / Adjusted), "Critical" chips and float, plus assumptions and
  risks as tidy lists. A failed item shows its error with Retry and Remove.
- **Styling rules.** Only global tokens and shared classes (`.card`, `.btn*`, `.chip`, `.progress`);
  wizard-only classes carry a `.planner-` prefix; status colours are always text plus tint pairs and
  every status also has an icon and a word, never colour alone. Animations (sheet entrance, switch,
  pulse, stripes, skeleton) are removed under `prefers-reduced-motion`.

| Request | Request, 3 items with a validation error |
| --- | --- |
| ![Request](wizard-request-empty.png) | ![Three items](wizard-request-items.png) |

| Loading | Review, first item open |
| --- | --- |
| ![Loading](wizard-loading.png) | ![Review](wizard-review.png) |

| Review, late item open | Review, one item failed |
| --- | --- |
| ![Late](wizard-review-late.png) | ![Failed](wizard-review-failed.png) |

| Single item review | |
| --- | --- |
| ![Single](wizard-single-review.png) | |

Mobile (390x844):

| Request | 3 items | Loading | Review | Late | Failed | Single |
| --- | --- | --- | --- | --- | --- | --- |
| ![](wizard-mobile-request.png) | ![](wizard-mobile-request-items.png) | ![](wizard-mobile-loading.png) | ![](wizard-mobile-review.png) | ![](wizard-mobile-review-late.png) | ![](wizard-mobile-review-failed.png) | ![](wizard-mobile-single-review.png) |
