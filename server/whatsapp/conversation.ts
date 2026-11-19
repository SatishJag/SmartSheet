/**
 * What happens when someone writes to the assistant. One call per inbound message; every answer goes
 * through the outbox. State lives in `whatsapp_sessions`, so restarts and several instances are fine.
 *
 *   planner users (linked phone)  the WBS9 menu over the sheets they own, task details, updates,
 *                                 delay reminders to task owners, summaries, EMAIL, AI questions
 *   site contacts (joined phone)  their own open tasks in the inviting owner's WhatsApp-enabled sheets,
 *                                 details and updates of those tasks only
 *   anyone else                   how to link (once a day); LINK / JOIN codes; STOP / START
 *
 * Who may see or change a task is decided in one place, `canTouch`: the sheet's owner, or a person
 * whose e-mail is in the task's owner column and who is either a linked planner user under that
 * e-mail or an active contact of the sheet's owner.
 */
import { createHash } from 'node:crypto'
import { validateCell, type Column } from '../../src/model/validate'
import type { SheetData } from '../../src/store/persistence'
import {
  detailMessage,
  HELP_MESSAGE,
  listMessage,
  menuMessage,
  NUDGE_CHOICES,
  ownerReminderMessage,
  plural,
  sheetPickerMessage,
  summaryMessage,
  taskLine,
} from '../../src/whatsapp/format'
import { matchStatus, parseCommand, quickAnswer, type Command } from '../../src/whatsapp/parse'
import { atRisk, criticalOpen, delayed, delayedByOwner, dueWithin, menuCounts, milestones, onTrack, ownedBy } from '../../src/whatsapp/select'
import { isDoneStatus, sheetFacts, type SheetFacts, type TaskFact } from '../../src/whatsapp/tasks'
import { localTime } from '../../src/whatsapp/time'
import type { AnthropicLike } from '../ai'
import type { Logger } from '../log'
import { askAssistant, buildContext } from './assistant'
import { queue, resolveRecipients } from './outbox'
import type { Contact, Link, ListState, Session, SessionState, SheetSettings, WhatsAppStore } from './store'

const HOUR_MS = 3_600_000
const PENDING_TTL_MS = 72 * HOUR_MS
const PICKER_SIZE = 9

export interface ConversationDeps {
  store: WhatsAppStore
  now: () => number
  log: Logger
  ai: { client: AnthropicLike; model: string } | null
  /** Sends the full last list to the user's account e-mail; null when e-mail is off. */
  sendEmail: ((to: string, subject: string, text: string) => Promise<boolean>) | null
  aiPerHour?: number
}

export interface Actor {
  phone: string
  link: Link | null
  contacts: Contact[]
  /** The account this conversation's messages belong to. */
  ownerId: string | null
}

export interface LoadedSheet {
  meta: { id: string; name: string; ownerId: string }
  data: SheetData
  settings: SheetSettings | null
  facts: SheetFacts
  today: string
}

export const hashCode = (code: string) => createHash('sha256').update(code.trim().toUpperCase()).digest('hex')

export function createConversation(deps: ConversationDeps) {
  const { store, now, log } = deps
  const aiPerHour = deps.aiPerHour ?? 20

  async function load(sheetId: string): Promise<LoadedSheet | null> {
    const data = await store.loadSheet(sheetId)
    if (!data) return null
    const settings = await store.settings(sheetId)
    const today = localTime(now(), settings?.timeZone ?? 'UTC').date
    return {
      meta: { id: data.sheet.id, name: data.sheet.name, ownerId: data.sheet.ownerId },
      data,
      settings,
      facts: sheetFacts(data, today, { ownerColumnId: settings?.ownerColumnId }),
      today,
    }
  }

  function canTouch(a: Actor, ownerId: string, task: TaskFact): boolean {
    if (a.link && a.link.userId === ownerId) return true
    return task.owners.some((e) => (a.link?.email === e) || a.contacts.some((c) => c.ownerId === ownerId && c.email === e))
  }

  const reply = (a: Actor, body: string) => queue(store, { ownerId: a.ownerId, phone: a.phone, body, kind: 'reply', priority: 'HIGH' }, now())
  const system = (a: Actor, body: string) => queue(store, { ownerId: a.ownerId, phone: a.phone, body, kind: 'system', priority: 'HIGH' }, now())

  // ---------------------------------------------------------------------------------------------
  // Updating a task (shared by users and contacts)

  async function applyUpdate(a: Actor, target: { sheetId: string; rowId: string }, change: { status: string | null; percent: number | null; comment: string; quick: boolean }): Promise<string> {
    const s = await load(target.sheetId)
    if (!s) return 'That project no longer exists.'
    const task = s.facts.tasks.find((t) => t.rowId === target.rowId)
    if (!task) return 'That task no longer exists.'
    if (!canTouch(a, s.meta.ownerId, task)) return 'You can only update tasks you are responsible for.'
    if (task.summary) return `Row ${task.number} (*${task.name}*) is a summary row: update the tasks under it.`
    if (await store.isRowLocked(task.rowId)) return `Row ${task.number} (*${task.name}*) is locked in the planner and cannot be changed.`

    const cols = s.facts.columns
    const colById = new Map(s.data.columns.map((c) => [c.id, c]))
    const ctx = { rowCount: s.data.rows.length, ownRowNumber: task.number, hoursPerDay: s.data.sheet.calendar.hoursPerDay, dependenciesEnabled: s.data.sheet.dependenciesEnabled }
    const patch: Record<string, unknown> = {}
    const said: string[] = []
    const notes: string[] = []
    const set = (col: Column, text: string): string | null => {
      const res = validateCell(col, text, ctx)
      if (!res.ok) return `${col.title}: ${res.error}`
      patch[col.id] = res.value
      return null
    }

    const statusCol = cols.status ? colById.get(cols.status) : undefined
    const percentCol = cols.percent ? colById.get(cols.percent) : undefined
    if (change.status) {
      const done = isDoneStatus(change.status) || /^(done|finished|completed?)$/i.test(change.status.trim())
      if (statusCol?.type === 'CHECKBOX') {
        patch[statusCol.id] = done
        said.push(done ? 'complete' : 'not complete')
      } else if (statusCol) {
        const opt = matchStatus(change.status, statusCol.options)
        if (opt) {
          const err = set(statusCol, opt)
          if (err) return err
          said.push(`status *${opt}*`)
        } else if (change.quick) {
          notes.push(`(“${change.status}” is not a status in this sheet, so the status was left as it is.)`)
        } else {
          return `I don't know the status “${change.status}”. Use one of: ${(statusCol.options ?? []).join(', ')}.`
        }
      } else if (!done) {
        if (!change.quick) return 'This sheet has no Status column, so I can only record progress (e.g. *2 60%*) or *Complete*.'
      }
      if (done && percentCol && patch[percentCol.id] === undefined) {
        const err = set(percentCol, '100')
        if (err) return err
        if (!statusCol) said.push('complete (100%)')
      }
    }
    if (change.percent !== null) {
      if (!percentCol) return 'This sheet has no % Complete column.'
      const err = set(percentCol, String(change.percent))
      if (err) return err
      said.push(`${change.percent}% complete`)
      if (change.percent === 100 && statusCol?.type === 'PICKLIST' && patch[statusCol.id] === undefined) {
        const doneOpt = (statusCol.options ?? []).find((o) => isDoneStatus(o))
        if (doneOpt) patch[statusCol.id] = doneOpt
      }
    }
    if (change.comment) {
      const commentCol = cols.comments ? colById.get(cols.comments) : undefined
      if (commentCol) {
        const who = a.link?.email?.split('@')[0] ?? a.contacts[0]?.name ?? 'WhatsApp'
        const prev = typeof s.data.rows.find((r) => r.id === task.rowId)?.cells[commentCol.id] === 'string' ? String(s.data.rows.find((r) => r.id === task.rowId)!.cells[commentCol.id]) : ''
        const entry = `${s.today} ${who}: ${change.comment}`
        const joined = (prev ? `${prev} | ${entry}` : entry).slice(-2000)
        const err = set(commentCol, joined)
        if (err) return err
        said.push('note added')
      } else notes.push('(The sheet has no Comments column, so the note was not saved.)')
    }
    if (Object.keys(patch).length === 0) return notes.length ? `Nothing was changed. ${notes.join(' ')}` : 'Nothing to change: send a status, a percentage or a note.'

    const res = await store.patchCells(task.rowId, patch)
    if (!res.ok) return `The update could not be saved: ${res.error}`
    await store.answerNudges(task.rowId, a.phone, now())
    const isOwner = a.link?.userId === s.meta.ownerId
    if (!isOwner) {
      const who = a.contacts.find((c) => c.ownerId === s.meta.ownerId)?.name ?? a.link?.email ?? 'A task owner'
      await store.notifyInApp(s.meta.ownerId, {
        sheetId: s.meta.id,
        rowId: task.rowId,
        title: `${who} updated “${task.name}” on WhatsApp`,
        body: [said.join(', '), change.comment ? `Note: ${change.comment}` : ''].filter(Boolean).join('\n'),
      })
    }
    log('whatsapp.update', { sheetId: s.meta.id, rowId: task.rowId, owner: isOwner })
    return [`✅ Row ${task.number} *${task.name}*: ${said.join(', ') || 'saved'}.`, ...notes].join('\n')
  }

  // ---------------------------------------------------------------------------------------------
  // Shared pieces

  function isAnswer(cmd: Command, st: SessionState): boolean {
    const p = st.pending
    if (!p || now() - p.at > PENDING_TTL_MS || (st.lastMenuAt ?? 0) > p.at) return false
    if (cmd.kind === 'number') return cmd.n >= 1 && cmd.n <= 4
    if (cmd.kind === 'answer') return true
    if (cmd.kind === 'update') return cmd.n >= 1 && cmd.n <= 4 && cmd.status === null && cmd.percent === null
    if (cmd.kind === 'text') return matchStatus(cmd.text.split(/\s+[-–—]\s+|[:–—]/)[0], [...NUDGE_CHOICES]) !== null && cmd.text.length <= 200
    return false
  }

  async function answerPending(a: Actor, st: SessionState, cmd: Command): Promise<void> {
    const p = st.pending!
    let change: { status: string | null; percent: number | null; comment: string; quick: boolean }
    if (cmd.kind === 'number') change = { status: quickAnswer(cmd.n), percent: null, comment: '', quick: true }
    else if (cmd.kind === 'update') change = { status: quickAnswer(cmd.n), percent: null, comment: cmd.comment, quick: true }
    else if (cmd.kind === 'answer') change = { status: cmd.status, percent: cmd.percent, comment: cmd.comment, quick: true }
    else {
      const text = (cmd as { text: string }).text
      const m = /^(.*?)(?:\s+[-–—]\s*|\s*[:–—]\s*)(.*)$/.exec(text)
      const head = m ? m[1] : text
      change = { status: matchStatus(head, [...NUDGE_CHOICES]), percent: null, comment: m ? m[2].trim() : '', quick: true }
    }
    // "Delayed" / "Blocked" without a matching status option still records the answer as a note.
    if (change.status && (change.status === 'Delayed' || change.status === 'Blocked') && !change.comment) change.comment = change.status
    const out = await applyUpdate(a, { sheetId: p.sheetId, rowId: p.rowId }, change)
    delete st.pending
    await reply(a, out)
  }

  async function showList(a: Actor, st: SessionState, title: string, items: { sheetId: string; task: TaskFact; label?: string }[], opts: { canUpdate: boolean; empty: string }) {
    st.list = { title, items: items.map((i) => ({ sheetId: i.sheetId, rowId: i.task.rowId })), at: now() }
    st.lastMenuAt = now()
    await reply(a, listMessage(title, items.map((i) => (i.label ? { ...i.task, name: `${i.task.name} (${i.label})` } : i.task)), opts))
  }

  async function listItem(a: Actor, st: SessionState, n: number): Promise<{ s: LoadedSheet; task: TaskFact } | string> {
    const item = st.list?.items[n - 1]
    if (!st.list || !item) return st.list ? `There is no item ${n} in the last list (${st.list.items.length} items).` : 'There is no list yet: reply *MENU* first.'
    const s = await load(item.sheetId)
    const task = s?.facts.tasks.find((t) => t.rowId === item.rowId)
    if (!s || !task) return 'That task no longer exists.'
    if (!canTouch(a, s.meta.ownerId, task)) return 'That task is not one of yours.'
    return { s, task }
  }

  async function detail(a: Actor, st: SessionState, n: number) {
    const hit = await listItem(a, st, n)
    await reply(a, typeof hit === 'string' ? hit : detailMessage(hit.task, hit.s.meta.name))
  }

  async function update(a: Actor, st: SessionState, cmd: Extract<Command, { kind: 'update' }>) {
    if (cmd.status === null && cmd.percent === null) {
      await reply(a, `Add a status or a percentage after the number, e.g. *${cmd.n} Complete* or *${cmd.n} 60%*.`)
      return
    }
    const item = st.list?.items[cmd.n - 1]
    if (!item) {
      await reply(a, st.list ? `There is no item ${cmd.n} in the last list.` : 'Open a list first (reply *MENU*), then update an item by its number.')
      return
    }
    await reply(a, await applyUpdate(a, item, { status: cmd.status, percent: cmd.percent, comment: cmd.comment, quick: false }))
  }

  // ---------------------------------------------------------------------------------------------
  // Planner users

  async function picker(a: Actor, st: SessionState) {
    const sheets = await store.ownedSheets(a.link!.userId, PICKER_SIZE + 1)
    const account = await store.account(a.link!.userId)
    const name = account?.email?.split('@')[0] ?? null
    st.lastMenuAt = now()
    if (sheets.length === 1) {
      await selectSheet(a, st, sheets[0].id)
      return
    }
    st.sheetChoices = sheets.slice(0, PICKER_SIZE).map((s) => s.id)
    st.awaitingSheet = sheets.length > 0
    await reply(a, sheetPickerMessage(name, sheets.slice(0, PICKER_SIZE), sheets.length > PICKER_SIZE))
  }

  async function selectSheet(a: Actor, st: SessionState, sheetId: string) {
    const s = await load(sheetId)
    if (!s || s.meta.ownerId !== a.link!.userId) {
      delete st.sheetId
      await reply(a, 'That project is no longer available. Reply *MENU*.')
      return
    }
    st.sheetId = sheetId
    st.awaitingSheet = false
    st.lastMenuAt = now()
    await reply(a, menuMessage(s.meta.name, menuCounts(s.facts.work), { canNotifyOwners: true }))
  }

  async function currentSheet(a: Actor, st: SessionState): Promise<LoadedSheet | null> {
    if (!st.sheetId) return null
    const s = await load(st.sheetId)
    if (!s || s.meta.ownerId !== a.link!.userId) {
      delete st.sheetId
      return null
    }
    return s
  }

  async function menuOption(a: Actor, st: SessionState, n: number) {
    let s = await currentSheet(a, st)
    if (!s) {
      // With a single project there is nothing to pick: use it.
      const sheets = await store.ownedSheets(a.link!.userId, 2)
      if (sheets.length !== 1) return picker(a, st)
      st.sheetId = sheets[0].id
      s = await currentSheet(a, st)
      if (!s) return picker(a, st)
    }
    const w = s.facts.work
    const items = (ts: TaskFact[]) => ts.map((task) => ({ sheetId: s.meta.id, task }))
    const opts = (empty: string) => ({ canUpdate: true, empty })
    switch (n) {
      case 1:
        return showList(a, st, `${s.meta.name} — Delayed`, items(delayed(w)), opts('Nothing is late. 🎉'))
      case 2:
        return showList(a, st, `${s.meta.name} — Due in 30 days`, items(dueWithin(w, 30)), opts('Nothing is due in the next 30 days.'))
      case 3: {
        const risky = atRisk(w)
        return showList(a, st, `${s.meta.name} — At risk (${risky.length}), then on track`, items([...risky, ...onTrack(w)]), opts('No open tasks.'))
      }
      case 4:
        return showList(a, st, `${s.meta.name} — Critical path`, items(criticalOpen(w)), opts(s.facts.hasFloat ? 'No open critical-path tasks.' : 'Turn on dependencies in the sheet to get a critical path.'))
      case 5:
        return showList(a, st, `${s.meta.name} — Milestones`, items(milestones(w)), opts('No open milestones (a milestone is a task with zero duration).'))
      case 6:
        return remindOwners(a, st, s)
      case 7:
        st.lastMenuAt = now()
        return reply(a, summaryMessage(s.meta.name, s.today, menuCounts(w), delayed(w)))
      default:
        st.lastMenuAt = now()
        return reply(a, menuMessage(s.meta.name, menuCounts(w), { canNotifyOwners: true }))
    }
  }

  async function remindOwners(a: Actor, st: SessionState, s: LoadedSheet) {
    st.lastMenuAt = now()
    const byOwner = delayedByOwner(s.facts.work)
    if (byOwner.size === 0) {
      const late = delayed(s.facts.work).length
      return reply(a, late ? `${plural(late, 'task is', 'tasks are')} late, but none has an owner in a Contact column, so there is no one to remind.` : 'Nothing is late, so no reminders were sent. ✅')
    }
    const account = await store.account(s.meta.ownerId)
    const from = account?.email ?? 'the project team'
    const reached: string[] = []
    const already: string[] = []
    const missing: string[] = []
    for (const [email, tasks] of byOwner) {
      const recipients = await resolveRecipients(store, s.meta.ownerId, [email])
      if (recipients.length === 0) {
        missing.push(email)
        continue
      }
      for (const r of recipients) {
        const ok = await queue(store, {
          ownerId: s.meta.ownerId,
          phone: r.phone,
          body: ownerReminderMessage(s.meta.name, tasks, from),
          kind: 'alert',
          priority: tasks.some((t) => t.critical) ? 'HIGH' : 'MEDIUM',
          sheetId: s.meta.id,
          dedupKey: `remind:${s.meta.id}:${r.phone}:${s.today}`,
        }, now(), s.settings)
        if (!ok) {
          already.push(r.label)
          continue
        }
        reached.push(`${r.label} (${tasks.length})`)
        const sess = await store.session(r.phone)
        const list: ListState = { title: `${s.meta.name} — your delayed tasks`, items: tasks.slice(0, 25).map((t) => ({ sheetId: s.meta.id, rowId: t.rowId })), at: now() }
        await store.saveSession(r.phone, { ...sess.state, list, lastMenuAt: now() })
      }
    }
    const lines = [`📨 *Delay reminders — ${s.meta.name}*`]
    if (reached.length) lines.push(`Sent to: ${reached.join(', ')}`)
    if (already.length) lines.push(`Already reminded today: ${already.join(', ')}`)
    if (missing.length) lines.push(`Not on WhatsApp (add them under Contacts in the planner): ${missing.join(', ')}`)
    return reply(a, lines.join('\n'))
  }

  async function emailList(a: Actor, st: SessionState) {
    if (!deps.sendEmail) return reply(a, 'E-mail is not set up on this server.')
    if (!st.list || st.list.items.length === 0) return reply(a, 'Open a list first (reply *MENU*), then reply *EMAIL*.')
    const account = await store.account(a.link!.userId)
    if (!account?.email) return reply(a, 'Your account has no e-mail address.')
    const lines: string[] = [st.list.title, '']
    let i = 0
    for (const item of st.list.items) {
      i++
      const s = await load(item.sheetId)
      const t = s?.facts.tasks.find((x) => x.rowId === item.rowId)
      if (t) lines.push(taskLine(i, t).replace(/\*/g, ''))
    }
    const ok = await deps.sendEmail(account.email, st.list.title, lines.join('\n'))
    return reply(a, ok ? `📧 Sent the full list (${st.list.items.length}) to ${account.email}.` : 'The e-mail could not be sent. Try again later.')
  }

  async function question(a: Actor, st: SessionState, text: string) {
    const s = await currentSheet(a, st)
    if (!s) return picker(a, st)
    const recent = (st.aiAt ?? []).filter((t) => now() - t < HOUR_MS)
    if (!deps.ai || recent.length >= aiPerHour) {
      st.lastMenuAt = now()
      const why = deps.ai ? 'You have asked a lot of questions this hour; here is the menu.' : 'I can only answer from the menu here.'
      return reply(a, `${why}\n\n${menuMessage(s.meta.name, menuCounts(s.facts.work), { canNotifyOwners: true })}`)
    }
    st.aiAt = [...recent, now()]
    const counts = menuCounts(s.facts.work)
    const answer = await askAssistant({ client: deps.ai.client, model: deps.ai.model, context: buildContext(s.meta.name, s.today, counts, s.facts.work), question: text, log })
    if (answer) return reply(a, answer)
    st.lastMenuAt = now()
    return reply(a, `I'm not sure what you need. Here is the menu:\n\n${menuMessage(s.meta.name, counts, { canNotifyOwners: true })}`)
  }

  async function userFlow(a: Actor, st: SessionState, cmd: Command) {
    if (isAnswer(cmd, st)) return answerPending(a, st, cmd)
    switch (cmd.kind) {
      case 'menu':
      case 'yes':
        if (st.sheetId) {
          const s = await currentSheet(a, st)
          if (s) {
            st.lastMenuAt = now()
            return reply(a, menuMessage(s.meta.name, menuCounts(s.facts.work), { canNotifyOwners: true }))
          }
        }
        return picker(a, st)
      case 'switch':
        return picker(a, st)
      case 'help':
        return reply(a, HELP_MESSAGE)
      case 'email':
        return emailList(a, st)
      case 'number':
        if (st.awaitingSheet && st.sheetChoices) {
          const id = st.sheetChoices[cmd.n - 1]
          if (id) return selectSheet(a, st, id)
          return reply(a, `Reply a number from 1 to ${st.sheetChoices.length}.`)
        }
        return menuOption(a, st, cmd.n)
      case 'detail':
        return detail(a, st, cmd.n)
      case 'update':
        return update(a, st, cmd)
      case 'answer':
        return reply(a, 'Which task? Reply with its number from a list and the percentage, e.g. *2 60%*.')
      case 'text':
        return question(a, st, cmd.text)
      default:
        return picker(a, st)
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Site contacts

  async function contactTasks(a: Actor, st: SessionState) {
    const items: { sheetId: string; task: TaskFact; label: string }[] = []
    for (const c of a.contacts) {
      for (const sheet of await store.ownedSheets(c.ownerId, 200)) {
        const settings = await store.settings(sheet.id)
        if (!settings?.enabled) continue
        const s = await load(sheet.id)
        if (!s) continue
        for (const task of ownedBy(s.facts.work, c.email)) items.push({ sheetId: sheet.id, task, label: s.meta.name })
      }
    }
    const name = a.contacts[0]?.name
    return showList(a, st, name ? `${name} — your open tasks` : 'Your open tasks', items, { canUpdate: true, empty: 'You have no open tasks right now. ✅' })
  }

  async function contactFlow(a: Actor, st: SessionState, cmd: Command) {
    if (isAnswer(cmd, st)) return answerPending(a, st, cmd)
    switch (cmd.kind) {
      case 'number':
        return st.list ? detail(a, st, cmd.n) : contactTasks(a, st)
      case 'detail':
        return detail(a, st, cmd.n)
      case 'update':
        return update(a, st, cmd)
      case 'help':
        return reply(a, 'Reply *TASKS* for your open tasks, *#2* for details of item 2, *2 Complete* or *2 60%* to update it, *STOP* to stop messages.')
      case 'email':
        return reply(a, 'E-mail is only available to planner users.')
      case 'answer':
        return reply(a, 'Which task? Reply *TASKS*, then e.g. *2 60%*.')
      case 'text':
        if (!/^(tasks?|my tasks|list|status)$/i.test(cmd.text)) {
          return reply(a, 'I can list your tasks (reply *TASKS*) and record updates like *1 Complete* or *1 60% - waiting for steel*.')
        }
        return contactTasks(a, st)
      default:
        return contactTasks(a, st)
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Codes, consent and the entry point

  async function useLink(phone: string, code: string): Promise<string> {
    const taken = await store.takeCode(hashCode(code), now())
    if (!taken || taken.kind !== 'link' || !taken.userId) return 'That link code is not valid or has expired. Get a new one in the planner (WhatsApp page).'
    const account = await store.account(taken.userId)
    await store.linkPhone(taken.userId, account?.email ?? null, phone)
    await store.setOptOut(phone, false)
    log('whatsapp.linked', { userId: taken.userId })
    return '✅ This number is now linked to your planner account. Reply *MENU* to pick a project, or *HELP* for what I can do.'
  }

  async function useJoin(phone: string, code: string): Promise<string> {
    const taken = await store.takeCode(hashCode(code), now())
    if (!taken || taken.kind !== 'join' || !taken.contactId) return 'That join code is not valid or has expired. Ask for a new invitation.'
    const contact = await store.contact(taken.contactId)
    if (!contact) return 'That invitation was withdrawn.'
    if (contact.phone !== phone) return 'That invitation was made for a different phone number. Ask for a new invitation for this number.'
    await store.activateContact(contact.id, now())
    await store.setOptOut(phone, false)
    const owner = await store.account(contact.ownerId)
    log('whatsapp.joined', { contactId: contact.id })
    return `✅ Welcome, ${contact.name}! You will get updates from ${owner?.email ?? 'the project team'} about tasks assigned to ${contact.email}.\n\nReply *TASKS* to see them. Reply *STOP* any time to stop messages.`
  }

  /** Handles one inbound text. Returns false when it was a duplicate delivery. */
  async function handle(phone: string, text: string, providerId: string | null): Promise<boolean> {
    const link = await store.linkByPhone(phone)
    const contacts = link ? [] : await store.activeContactsByPhone(phone)
    // A linked user may also be a contact of other owners (their tasks in other people's sheets).
    const allContacts = link ? await store.activeContactsByPhone(phone) : contacts
    const a: Actor = { phone, link, contacts: allContacts, ownerId: link?.userId ?? allContacts[0]?.ownerId ?? null }
    if (!(await store.recordInbound({ phone, ownerId: a.ownerId, body: text || '(not text)', providerId }))) return false
    const session: Session = await store.session(phone)
    const st = session.state
    const cmd = parseCommand(text)
    try {
      if (!text.trim()) {
        await reply(a, 'I can only read text messages. Reply *HELP* for what I can do.')
      } else if (cmd.kind === 'stop') {
        await store.setOptOut(phone, true)
        await system(a, 'You will not get any more messages from this number. Reply *START* to resume.')
      } else if (cmd.kind === 'start') {
        await store.setOptOut(phone, false)
        await reply(a, 'Messages are on again. Reply *MENU* or *TASKS*.')
      } else if (cmd.kind === 'link') {
        await reply(a, await useLink(phone, cmd.code))
      } else if (cmd.kind === 'join') {
        await reply(a, await useJoin(phone, cmd.code))
      } else if (await store.isOptedOut(phone)) {
        await system(a, 'Messages are off for this number. Reply *START* to turn them on.')
      } else if (link) {
        await userFlow(a, st, cmd)
      } else if (allContacts.length) {
        await contactFlow(a, st, cmd)
      } else if (!st.unknownToldAt || now() - st.unknownToldAt > 24 * HOUR_MS) {
        st.unknownToldAt = now()
        await reply(a, 'This number is not linked to a planner account. Open the planner, go to *WhatsApp* and use *Link my phone*. Site contacts: use the invitation link you were sent.')
      }
    } catch (err) {
      log('whatsapp.handle.failed', { error: (err as Error).message })
      await reply(a, '⚠️ Something went wrong on our side. Please try again in a minute.').catch(() => {})
    }
    await store.saveSession(phone, st, now())
    return true
  }

  /** Records that `phone` was just asked about a task (delay alert or progress check). */
  async function setPending(phone: string, pending: NonNullable<SessionState['pending']>) {
    const sess = await store.session(phone)
    await store.saveSession(phone, { ...sess.state, pending })
  }

  return { handle, load, setPending, applyUpdate, canTouch }
}

export type Conversation = ReturnType<typeof createConversation>
