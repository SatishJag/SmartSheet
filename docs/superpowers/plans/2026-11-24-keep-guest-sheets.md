# Keep a guest account's sheets: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A guest (anonymous) user turns their account into an email account from a strip at the top of the app, keeping every sheet.

**Architecture:** One React component, `KeepSheetsBanner`, rendered above the app for the signed-in user; it calls `client.auth.updateUser` twice (email, then password) and keeps its progress in `user_metadata`. AuthGate already re-renders on `USER_UPDATED`.

**Tech Stack:** React 18 + TS, supabase-js auth, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-24-keep-guest-sheets-design.md`

## Global Constraints
- Copy, verbatim: "You're using a guest account: your sheets are only reachable from this browser.", "Keep my sheets", "Send link", "Check {email} and open the link in this browser.", "Use a different email", "That email already has an account. Sheets can't be moved into it yet; use another email.", "Set a password so you can sign in anywhere", "Save", "Saved. Sign in with {email} from now on."
- Metadata keys: `keep_sheets_email` (string), `keep_sheets_password_pending` (boolean).
- No change to the sign-in form.

## Review Focus
1. Email already registered → the friendly message, nothing else changes.
2. Double press on Send link / Save → one call (button disabled while busy).
3. A normal email user (no metadata) never sees the strip.
4. Passwords that differ or are under 6 characters → message, no call.
5. Supabase error on either step → its message shown, form kept.

---

### Task 1: KeepSheetsBanner

**Files:** Create `src/auth/KeepSheetsBanner.tsx`, `src/auth/KeepSheetsBanner.test.tsx`; modify `src/App.tsx` (render it above `Shell`), `src/auth/sheetList.css` or a small new css for the strip.

**Interfaces:** `KeepSheetsBanner({ client: SupabaseClient, user: User })` → strip or `null`.

- [ ] Step 1: failing tests: nothing for an email user; guest sees the strip; Keep my sheets → Email; empty email → "Enter your email", no call; Send link calls `updateUser({ email, data: { keep_sheets_email, keep_sheets_password_pending: true } }, { emailRedirectTo: location.origin })` once (double click) and shows "Check …"; guest with `keep_sheets_email` shows "Check …" and Use a different email reopens the form; "already registered" error → the friendly message; confirmed user with pending → password form; differing / short passwords → messages, no call; Save calls `updateUser({ password, data: { keep_sheets_password_pending: false } })` and shows "Saved. Sign in with … from now on."
- [ ] Step 2: run, FAIL. Step 3: implement. Step 4: PASS + full suite + tsc. Step 5: commit.

### Task 2: Ship
- [ ] Final review (fresh reviewer), PR, merge (owner asked), then screenshot the live strip with a throwaway anonymous user and delete that user.
