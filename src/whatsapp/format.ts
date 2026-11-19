/**
 * Every message the assistant sends, as plain WhatsApp text (*bold*, _italic_). Pure.
 * Lists are numbered 1..n; "N <status>" replies refer to these numbers (the conversation keeps the
 * row ids of the last list).
 */
import type { MenuCounts } from './select'
import type { TaskFact } from './tasks'

/** WhatsApp allows 4096 characters per text message; leave room for a continuation marker. */
export const MAX_MESSAGE_CHARS = 3800
/** Tasks shown in one list before "reply EMAIL for the full list". */
export const LIST_LIMIT = 25

const PRIORITY_MARK: Record<TaskFact['priority'], string> = { HIGH: '🔴', MEDIUM: '🟠', LOW: '🟢' }

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`
}

function who(t: TaskFact): string {
  return t.owners.length ? t.owners.map((e) => e.split('@')[0]).join(', ') : 'no owner'
}

/** One list entry: "*3.* Pour slab L3\n    Due 2026-11-12 · 7 days late · ravi · critical" */
export function taskLine(i: number, t: TaskFact): string {
  const bits: string[] = []
  if (t.finish) bits.push(`${t.milestone ? 'Date' : 'Due'} ${t.finish}`)
  if (t.delayDays > 0) bits.push(`*${plural(t.delayDays, 'day')} late*`)
  else if (t.daysToFinish !== null && t.daysToFinish >= 0 && t.daysToFinish <= 30) bits.push(t.daysToFinish === 0 ? 'due today' : `in ${plural(t.daysToFinish, 'day')}`)
  if (t.percent !== null) bits.push(`${Math.round(t.percent)}%`)
  bits.push(who(t))
  if (t.critical) bits.push('critical path')
  return `*${i}.* ${t.name}\n    ${bits.join(' · ')}`
}

export function listMessage(title: string, tasks: TaskFact[], opts: { canUpdate: boolean; empty: string }): string {
  if (tasks.length === 0) return `*${title}*\n\n${opts.empty}\n\nReply *MENU* for the menu.`
  const shown = tasks.slice(0, LIST_LIMIT)
  const lines = [`*${title}* (${tasks.length})`, '', ...shown.map((t, i) => taskLine(i + 1, t))]
  if (tasks.length > shown.length) lines.push('', `…and ${tasks.length - shown.length} more. Reply *EMAIL* for the full list.`)
  lines.push('')
  if (opts.canUpdate) lines.push('Update one: reply with its number and a status, e.g. *2 Complete* or *2 In progress - waiting for steel*.')
  lines.push('Details: *#2*  ·  Menu: *MENU*')
  return lines.join('\n')
}

export function menuMessage(sheetName: string, c: MenuCounts, opts: { canNotifyOwners: boolean }): string {
  const lines = [
    `📋 *${sheetName}*`,
    `${plural(c.total, 'task')} · ${c.complete} complete`,
    '',
    `*1* 🔴 Delayed: ${c.delayed}`,
    `*2* 🟡 Due in the next 30 days: ${c.due30}`,
    `*3* 🟢 On track: ${c.onTrack} · at risk: ${c.atRisk}`,
    `*4* ⚡ Critical path: ${c.critical} (${c.criticalDelayed} late)`,
    `*5* 🏁 Milestones: ${c.milestones}`,
  ]
  if (opts.canNotifyOwners) lines.push('*6* 📨 Send delay reminders to task owners')
  lines.push('*7* 📊 Summary', '*0* 🔁 Switch project', '', 'Reply with a number, or just ask a question, e.g. _what is late on the MEP works?_')
  return lines.join('\n')
}

export function sheetPickerMessage(greetingName: string | null, sheets: { name: string }[], more: number): string {
  if (sheets.length === 0) return `👋 Hi${greetingName ? ` ${greetingName}` : ''}! You have no sheets yet. Create one in the planner, then reply *MENU*.`
  const lines = [`👋 Hi${greetingName ? ` *${greetingName}*` : ''}! Pick a project:`, '', ...sheets.map((s, i) => `*${i + 1}* ${s.name}`)]
  if (more > 0) lines.push(`…and ${more} more (the ${sheets.length} most recent are shown).`)
  lines.push('', `Reply 1–${sheets.length}.`)
  return lines.join('\n')
}

export function detailMessage(t: TaskFact, sheetName: string): string {
  const lines = [`*${t.name}*`, `_${sheetName}, row ${t.number}${t.parentName ? ` · ${t.parentName}` : ''}_`, '']
  if (t.start || t.finish) lines.push(`📅 ${t.start ?? '?'} → ${t.finish ?? '?'}${t.durationDays !== null ? ` (${plural(t.durationDays, 'day')})` : ''}`)
  if (t.status) lines.push(`Status: ${t.status}`)
  if (t.percent !== null) lines.push(`Progress: ${Math.round(t.percent)}%`)
  if (t.delayDays > 0) lines.push(`⚠️ ${plural(t.delayDays, 'day')} past the finish date`)
  if (t.forecastFinish) lines.push(`Forecast finish at this rate: ${t.forecastFinish}`)
  if (t.totalFloat !== null) lines.push(`Float: ${plural(t.totalFloat, 'working day')}${t.critical ? ' (critical path)' : ''}`)
  lines.push(`Priority: ${PRIORITY_MARK[t.priority]} ${t.priority}`)
  lines.push(`Owner: ${t.owners.length ? t.owners.join(', ') : 'none'}`)
  if (t.department) lines.push(`Department: ${t.department}`)
  return lines.join('\n')
}

export function summaryMessage(sheetName: string, today: string, c: MenuCounts, topDelayed: TaskFact[]): string {
  const pct = c.total ? Math.round((c.complete / c.total) * 100) : 0
  const lines = [
    `📊 *${sheetName}* — ${today}`,
    '',
    `Tasks: ${c.total} · complete ${c.complete} (${pct}%)`,
    `🔴 Delayed: ${c.delayed}${c.criticalDelayed ? ` (${c.criticalDelayed} on the critical path)` : ''}`,
    `🟡 Due in 30 days: ${c.due30} · at risk: ${c.atRisk}`,
    `🏁 Open milestones: ${c.milestones}`,
  ]
  if (topDelayed.length) {
    lines.push('', '*Most delayed*')
    topDelayed.slice(0, 5).forEach((t, i) => lines.push(taskLine(i + 1, t)))
  }
  lines.push('', 'Reply *MENU* for details.')
  return lines.join('\n')
}

export function delayAlertMessage(t: TaskFact, sheetName: string, opts: { toOwner: boolean }): string {
  const head = t.critical ? '🔴 *Critical path task is late*' : '⚠️ *Task is late*'
  const lines = [head, '', `*${t.name}*`, `_${sheetName}, row ${t.number}_`, `Finish was ${t.finish} (${plural(t.delayDays, 'day')} ago)`]
  if (t.percent !== null) lines.push(`Progress: ${Math.round(t.percent)}%`)
  if (!opts.toOwner) lines.push(`Owner: ${t.owners.length ? t.owners.join(', ') : 'none'}`)
  lines.push('')
  lines.push(opts.toOwner ? 'Reply *1* On track · *2* Delayed · *3* Complete · *4* Blocked (add a note after a dash: _2 - crane down_)' : 'Reply *MENU* for the project menu.')
  return lines.join('\n')
}

export const NUDGE_CHOICES = ['On track', 'Delayed', 'Complete', 'Blocked'] as const

export function nudgeMessage(t: TaskFact, sheetName: string, milestone: number, reminder: number): string {
  const lines = [
    reminder > 0 ? `⏰ *Reminder ${reminder}* — progress check` : `⏱️ *Progress check* — ${milestone}% of the time has passed`,
    '',
    `*${t.name}*`,
    `_${sheetName}, row ${t.number}_`,
    `📅 ${t.start ?? '?'} → ${t.finish ?? '?'}${t.percent !== null ? ` · reported ${Math.round(t.percent)}%` : ''}`,
    '',
    'How is it going? Reply *1* On track · *2* Delayed · *3* Complete · *4* Blocked',
    'Add a note after a dash, or send a percentage: _2 - waiting for rebar_, _60%_',
  ]
  return lines.join('\n')
}

export function noResponseMessage(t: TaskFact, sheetName: string, contactLabel: string, milestone: number, sent: number): string {
  return [
    '🚩 *No response to progress checks*',
    '',
    `*${t.name}* (${sheetName}, row ${t.number})`,
    `${contactLabel} did not answer ${plural(sent, 'message')} at the ${milestone}% check.`,
    `Finish: ${t.finish ?? '?'}${t.delayDays ? ` · ${plural(t.delayDays, 'day')} late` : ''}`,
  ].join('\n')
}

export function ownerReminderMessage(sheetName: string, tasks: TaskFact[], fromName: string): string {
  return [
    `📨 *Delay reminder* from ${fromName}`,
    `_${sheetName}_`,
    '',
    ...tasks.slice(0, LIST_LIMIT).map((t, i) => taskLine(i + 1, t)),
    '',
    'Update one: reply with its number and a status, e.g. *1 Complete* or *1 In progress - 2 days*.',
  ].join('\n')
}

export const HELP_MESSAGE = [
  '*How to use this assistant*',
  '',
  '*MENU* the project menu · *0* switch project',
  '*1*–*7* menu options',
  '*#3* details of item 3 in the last list',
  '*3 Complete* / *3 60%* / *3 Delayed - crane down* update item 3',
  '*EMAIL* the full last list to your e-mail',
  '*STOP* no more messages · *START* resume',
  '',
  'Or ask a question in your own words.',
].join('\n')

/** Splits a long text at line breaks into WhatsApp-sized messages. */
export function chunkMessage(text: string, max = MAX_MESSAGE_CHARS): string[] {
  if (text.length <= max) return [text]
  const out: string[] = []
  let cur = ''
  for (const line of text.split('\n')) {
    const piece = line.length > max ? line.slice(0, max - 1) + '…' : line
    if (cur.length + piece.length + 1 > max) {
      out.push(cur)
      cur = piece
    } else cur = cur ? `${cur}\n${piece}` : piece
  }
  if (cur) out.push(cur)
  return out
}

/** One line for a template parameter: WhatsApp refuses newlines, tabs and long runs of spaces there. */
export function templateParam(text: string, max = 900): string {
  const flat = text
    .replace(/\s*\n+\s*/g, ' · ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
