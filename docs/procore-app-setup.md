# Plan with AI inside Procore: setup

This puts **Plan with AI** inside Procore in two places:
- **a side panel** on the Schedule, Commitments and Budget screens;
- **a full-screen app** in a project's **Apps** menu.

Both show the page `https://smartsheet-web-production.up.railway.app/procore`. It holds only sign-in and Plan with AI, and opens on the Procore project you're in. Design: `docs/superpowers/specs/2026-11-22-procore-panel-design.md`.

## Before you start
- Use the **same Procore app** whose client ID and secret are in Railway for Sync with Procore (`PROCORE_CLIENT_ID`, `PROCORE_CLIENT_SECRET`, `PROCORE_COMPANY_ID`, `PROCORE_ENV`).
  - Each Procore app gets its own Developer Sandbox with its own company ID.
  - With a different app, the page can't match projects: the server answers "other company".
- The project is pre-selected only once those four Railway variables are set. Until then, the planner chooses the project, as in the app.

## 1. Add the components (Developer Portal)
1. Open your app in the [Developer Portal](https://developers.procore.com) and select **Create Version**.
2. Under **Components**, select **Edit Components**. In the **Embedded** group, tick **Side Panel** and **Full Screen**, then select **Save**.
3. **Side Panel** → **Manage**:
   - **External URL:** `https://smartsheet-web-production.up.railway.app/procore?view=panel`
   - **Supported Side Panel Views:** tick these.
     - Schedule:
       - `schedule.calendar.list`
       - `schedule.calendar.month.list`
       - `schedule.calendar.task.list`
       - `schedule.calendar.lookaheads.list`
       - `schedule.calendar.task.detail`
     - Commitments:
       - `commitments.contracts.list`
       - `commitments.work_order_contracts.detail`
       - `commitments.purchase_order_contracts.detail`
     - Budget:
       - `budgeting.list`
       - `budgeting.detail`
       - `budgeting.forecasting.detail`
       - `budgeting.budget_changes.list`
   - Select **Save Configuration**.

   The side panel learns the project from Procore's start-up message, so its URL needs no parameters.
4. **Full Screen** → **Manage**:
   - **External URL:** `https://smartsheet-web-production.up.railway.app/procore?company={{procore.company.id}}&project={{procore.project.id}}`
   - Select **Save Configuration**.
5. Back on **Create Version**, add a **Post-Installation Note**, for example: "Open Plan with AI from the right-hand dock on Schedule, Commitments or Budget, or from the Apps menu. Sign in with your SmartSheet account the first time."
6. Select **Save Version**.

## 2. Install in your Developer Sandbox
1. Install the new sandbox version in your Developer Sandbox ([Procore guide](https://developers.procore.com/documentation/install-version-sandbox)).
2. **To see the project pre-selected,** set a sandbox project's **Project Number** to one of our codes, e.g. `BKK-03` (Project Admin → General). The sandbox's example project is numbered `1234`, which matches nothing in our list.

## 3. Check it works
1. **Side panel:** open the project's **Schedule**, a **commitment** (PO or subcontract) and the **Budget**. Open Plan with AI from the right-hand dock on each.
   - First time: sign in with your SmartSheet email and password.
   - The Project field should show `BKK-03 — Bangkok 3`. Without the Procore variables in Railway, or without a matching project number, it's empty for you to choose.
2. **Full screen:** open **Apps → Plan with AI**. It should show the same page across the full width.
3. **Make a plan and select Create schedule.** "Schedule created" should appear. **Open in SmartSheet** should open the sheet in a new browser tab.

## Two things only your sandbox can show
- **Procore's frame must accept our page.** We only allow `app.procore.com`, `us02.procore.com`, `uk01.procore.com` and `sandbox.procore.com` to show `/procore`. If the panel stays blank, tell me the Procore address you were on so I can add it.
- **Procore must let the panel open new tabs.** If "Open in SmartSheet" does nothing, tell me and I'll change it to a link you can copy.

## Projects planners add
A planner can add a project from the wizard (**Project → + New project…**). It shows as "(new)" and Sync with Procore skips it ("not in Procore") until someone marks it as in Procore. Once its Procore project exists with the same **Project Number**, run this in the Supabase SQL editor (with the real code):

```sql
update projects set in_procore = true where code = 'BKK-04';
```

The sync reads Procore with the app's own account, so it only reads projects someone has checked like this.

## Browsers that block sign-in inside Procore
Some browsers refuse to keep a sign-in inside another site's frame:
- Safari;
- Chrome or Edge with third-party cookies blocked, which includes Incognito and InPrivate windows by default.

The panel then says "Your browser blocks sign-in inside Procore" and offers **Open Plan with AI in a new tab**. The new tab opens on the same Procore project. Chrome and Edge in normal windows, with default settings, keep the sign-in.

## Promote to production
When the sandbox version works, promote it ([Procore guide](https://developers.procore.com/documentation/building-apps-promote-manifest)) and install it in your company. Switch the Railway variables to the production app's values and `PROCORE_ENV=production`.
