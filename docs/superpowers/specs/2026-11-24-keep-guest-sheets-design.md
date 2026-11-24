# Keep a guest account's sheets: design (short)

Date: 2026-11-24. Status: approved by the owner ("don't overcomplicate sign-in for the MVP").

## Why
The app has required email sign-in since 2026-11-16, but a browser that signed in anonymously before then keeps
its guest session (the owner's: 7 sheets, the only account). Anonymous sign-ins are to be turned off; a guest
must be able to turn the account into an email account first, keeping every sheet.

## Goals / non-goals
- Goal: a guest adds an email, confirms it, sets a password; same user id, so all sheets stay.
- Non-goals: moving a guest's sheets into an existing email account; password reset; any change to the normal
  sign-in form.

## Approaches
1. **Supabase's own conversion (chosen):** `auth.updateUser({ email })` links the email to the anonymous user;
   after the confirmation link, `auth.updateUser({ password })`. Same user, nothing to migrate.
2. Sign up a new account and move the rows to it: needs a server-side ownership transfer. Rejected (more moving
   parts, the owner asked for simple).

## Design
- A strip at the top of the app, only for guests (`user.is_anonymous`): "You're using a guest account: your
  sheets are only reachable from this browser." + **Keep my sheets**.
- Step 1: Email + **Send link** → `updateUser({ email, data: { keep_sheets_email: email,
  keep_sheets_password_pending: true } }, { emailRedirectTo: <app origin> })`. Then: "Check <email> and open the
  link in this browser." with **Use a different email**. An email that already has an account: "That email already
  has an account. Sheets can't be moved into it yet; use another email." Other errors as Supabase words them.
- Step 2 (confirmed: not anonymous, `keep_sheets_password_pending` true): "Set a password so you can sign in
  anywhere": Password + Confirm + **Save** → `updateUser({ password, data: { keep_sheets_password_pending: false } })`.
  Then "Saved. Sign in with <email> from now on." and the strip goes.
- The progress lives in the user's metadata (UI state only), so step 2 shows in any browser.

## Owner's setup (Supabase dashboard, before using it)
- Authentication → Sign In / Providers: **Allow manual linking** on.
- Authentication → URL Configuration: the app address in **Redirect URLs** (and as Site URL).
- Keep anonymous sign-ins on until the guest account is converted; then turn them off.

## Left to the builder
Wording within the above; validation messages (empty email, passwords that differ, under 6 characters).
