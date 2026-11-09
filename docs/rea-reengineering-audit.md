# REA re-engineering audit

Target: `rea-main.zip` (REA, "Reverse Engineer Anything", `rea-agents` 6.8.0, MIT).
Scope: audit and plan only. No REA source was changed.
Environment: Node 22.23.4 (the repo pins 24.22.1 in `.nvmrc`). TypeScript 7.0.2 native, so the JS compiler API is unavailable. Function sizes were measured with the bundled `typescript6` package.

## 1. Baseline (measured)

| Check | Result |
|---|---|
| `npm ci --ignore-scripts` | passes |
| `tsc --noEmit` (strict) | passes, about 39 s |
| `verify:module-boundaries` | passes, 3,893 files |
| `verify:architecture-guards` | passes, 2,578 files |
| `oxlint` | warnings only, all in tests (`max-params`, un-awaited `expect`) |
| `knip` | 2 unresolved imports (`#web-bundle-analysis-worker`, `#javascript-analysis-worker`, likely `package.json#imports` resolution when `dist/` is not built) and 1 unused test-fixture export |
| `jscpd` (src only) | 2,073 clones, 22,478 duplicated lines (2.13%) |
| Not run | the vitest suite, the build, the Python tests and `docs:check`. The numbers above are static checks only. |

**Conclusion:** the codebase is healthy. There are no layering violations. `domain/` imports nothing from providers, `application/` or `process/`. There are 0 `@ts-ignore`, 0 `eslint-disable`, 0 TODO/FIXME and only 7 `any`. Enforced boundary and architecture scripts already exist. A rewrite is not justified. The work is decomposition of oversized units.

## 2. Size profile

- 616k lines of production TypeScript and 427k lines of tests, across 50+ modules.
- Largest areas by production lines: `domain` 208k, `application` 101k, `native` 39k, `browser` 36k, `artifacts` 35k, `process` 20k, `ghidra` 19k.
- 71 production files exceed 1,000 lines and 341 exceed 500.
- 246 production files over 400 lines have no sibling `*.test.ts`. Some are covered by boundary or acceptance tests, so this is a lead to check, not a verdict.
- Of 3,292 functions and methods, 171 exceed 100 lines and 52 exceed 200.

## 3. Hotspots

### A. Oversized functions (highest value, lowest risk)

| Lines | Function | Note |
|---|---|---|
| 1,494 | `collectSemanticMemberMutationsSteps` (`domain/javascript/javascriptSemanticMemberMutations.ts`) | one function in a 2,383-line file |
| 1,358 | `collectElectronWrappedCallPathsSteps` (`domain/javascript/electronWrappedCallPaths.ts`) | same "Steps" pattern |
| 701 | `#observeProvider` (`application/reverse/ReverseEngineeringService.ts`) | probably a provider switch |
| 628 / 585 / 409 | `#inspect` in `WabtArtifactProvider`, `EvmoleInterfaceProvider` and `PwntoolsDecoder` | the same shape repeats across providers |
| 583 / 396 | `AdbProvider.#executeOperation` and `pullPackage` | |
| 423 | `GdbSessionManager.#startProtocol` | |
| 423 / 420 / 415 | `writeResult` (`cli/cliResultOutput.ts`), `GhidraLauncher.launch`, `inspectAdmitted` (`HistoricalCaptureDecoder`) | |

The two `*Steps` functions are the clear outliers. They look like generator-style traversal bodies in the JavaScript semantic analyzer.

### B. God classes

`AdbProvider` (2,526 lines, 33 members), `KunaSessionClient` (2,012, 78), `GdbSessionManager` (1,740, 44), `BinarySession` (1,646, 69), `GhidraClient` (1,545, 90), `RizinDebugSessionManager` (1,420, 43), `NativeMacOSClient` (1,362, 34), `FridaInstrumentationManager` (1,259, 48). Several have very long methods and few members, such as `AdbProvider` with 33 members in 2,526 lines. Splitting by operation would help more than extracting helpers.

### C. Parallel debugger/session managers

`GdbSessionManager`, `RizinDebugSessionManager` and `FridaInstrumentationManager` each define their own process-exit, timeout and protocol-failure error classes. Each has its own session lifecycle. `AGENTS.md` requires shared lifecycle invariants (ownership, cancellation during final cleanup, cleanup retry). Candidate: one shared session-lifecycle owner in `src/process/`, with per-engine protocol adapters on top. This is the largest structural gain and the riskiest change.

### D. Duplication

2.13% duplicated lines is low overall. Cluster the 2,073 clones by directory before acting. The `#inspect` providers in section A are the likeliest source of one extractable pattern.

### E. Tooling and test hygiene

- Fix the two `knip` unresolved imports, or add them to the knip config.
- Fix the un-awaited `expect` calls in `PlaywrightScenarioSession.test.ts` (lines 1220, 1341, 1372). These can hide failures.
- Align the local Node version with `.nvmrc` before running the full gate.

## 4. Recommended plan

Each step ends with `npm run check:fast` and the relevant `npm run test:focused -- PATH` run, as `AGENTS.md` requires.

1. **Get a real baseline.** Install Node 24.22.1, run `npm run build:cached`, then the source tests (`npm run test:fast`). Record failures before changing anything.
2. **Decompose the two `*Steps` functions** in `domain/javascript`. Split by AST node kind or phase into private step modules. Keep one public entry point. Pure domain code, so the existing tests protect it.
3. **Split `AdbProvider`** by operation (`#executeOperation` into one handler per operation, `pullPackage` into phases). Public surface unchanged.
4. **Factor the `#inspect` provider pattern** (Wabt, Evmole, Pwntools) after checking that the duplication is real, not coincidental.
5. **Shared session lifecycle** for GDB, Rizin and Frida. Write an ADR first (`docs/adr/`, per the repo's documentation rules). Use the lifecycle regressions listed in `docs/development/testing.md` (late handshakes, cancellation during final cleanup, mixed child outcomes, cleanup retry).
6. **Hygiene.** Resolve the knip and test warnings.

## 5. Risks and constraints

- `CONTRIBUTING.md` and `AGENTS.md` ask for maintainer scope approval before changes touching target execution, injection or mutation. Items 3 and 5 sit near that boundary.
- Simulated providers do not prove real-provider behavior. ADB, GDB, Rizin and Frida need real-tool verification that this sandbox does not have.
- `AGENTS.md` also requires a human to review and own any PR. I have not opened one.
- This audit used static checks only. No tests ran, so no claim is made that behavior is unchanged anywhere.

## 6. Decision needed

Say which step to start with. My recommendation is steps 1 and 2: they are behavior-preserving, pure, and the most measurable.
