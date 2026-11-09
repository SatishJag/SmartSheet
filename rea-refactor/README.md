# REA refactor: steps 1 and 2

This patch applies to the uploaded `rea-main.zip` (REA `rea-agents` 6.8.0). See `docs/rea-reengineering-audit.md` for the audit and plan.

Apply it from an REA checkout:

```bash
git apply 0001-split-javascript-steps.patch
```

## Step 1: baseline (unmodified REA, Node 24.22.1)

- `npm ci`: passes.
- `npm run build:cached`: passes, in 17 s.
- Source test group (`node scripts/ci/test-group.mjs source`): 1,348 test files pass and 2 are skipped. 25,096 tests pass and 46 are skipped. No failures. The run took 7 min 20 s.

## Step 2: split the two largest functions

| Function | Before | After |
|---|---|---|
| `collectElectronWrappedCallPathsSteps` | 1,358 lines in a 1,614-line file | 361 lines in a 400-line file |
| `collectSemanticMemberMutationsSteps` | 1,494 lines in a 2,383-line file | 355 lines in a 406-line file |

Code was moved verbatim, as exact line ranges, into owning modules. A line-by-line check found every original line in the new files, except import reshuffles, added `export` keywords and two counter declarations.

There are two deliberate representation changes:

- The local `remainingVisits` counter is now a shared `{ remaining }` budget object.
- The local `recordedEffectCount` counter is now a shared `{ recorded }` counter object.

Each split-out module draws on the same bound or counter, as before.

New modules, all under `src/domain/javascript/`:

- `electronWrappedCallPathContext.ts`: path steps and branch predicates, the visit budget, and shared types.
- `electronWrappedIpcIndex.ts`: IPC endpoint deduplication index.
- `electronWrappedInvocationFacts.ts`: how handler sites relate to traced invocations.
- `electronWrappedIpcSubstitution.ts`: substituted IPC operations and literal-channel enumeration.
- `electronWrappedBridgeExposures.ts`: substituted contextBridge exposures.
- `javascriptSemanticMutationReferences.ts`: reference types and module-level reference expansion.
- `javascriptSemanticAccessorEffects.ts`: local accessor selection and getter receiver effects.
- `javascriptSemanticObservableMutationPaths.ts`: observable mutation path normalization.
- `javascriptSemanticMutationEffectRecords.ts`: required-module and binding effect records, and identity keys.
- `javascriptSemanticEscapedLeaves.ts`: escaped-value expansion.
- `javascriptSemanticValueMarks.ts`: write and escape propagation (`markValue` and related functions).

## Validation after the change

- `tsc --noEmit` (strict): passes.
- `verify:module-boundaries` and `verify:architecture-guards`: pass.
- `oxfmt --check`: passes.
- `oxlint`: no errors.
- `knip`: no new unused exports.
- `src/domain/javascript/` and `src/application/javascript/` tests: all 208 files pass (5,850 tests pass and 6 are skipped).
- Full source test group: 1,348 test files pass and 2 are skipped. 25,096 tests pass and 46 are skipped. No failures. The run took 7 min 5 s. These counts match the baseline exactly.

## What remains

- `markValue` is still about 640 lines, now in `javascriptSemanticValueMarks.ts`. Splitting its identifier branch means turning `continue` statements into `return`s, so it needs its own careful step.
- The new factory functions still trip the repo's 100-line `max-lines-per-function` warning. Every file is now under the 500-line `max-lines` limit, except `javascriptSemanticValueMarks.ts` at 855 lines.
- Boundary and acceptance test projects, and real-provider lanes, were not run.
