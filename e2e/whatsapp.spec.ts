import { expect, test, type Page, type Route } from '@playwright/test'
import { createScheduleSheet, openApp } from './support/app'

/**
 * The WhatsApp page against the fake backend. The planning server's /api/whatsapp/* endpoints are
 * stubbed here (their behaviour is covered by server/whatsapp/whatsapp.test.ts); what is tested is the
 * page: linking, the test chat, site contacts, per-sheet alert settings and the rule option.
 */
const goTo = (page: Page, section: 'Sheets' | 'Automation' | 'WhatsApp') => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: section }).click()

interface ServerStub {
  linked: boolean
  simulated: string[]
}

async function stubServer(page: Page): Promise<ServerStub> {
  const stub: ServerStub = { linked: false, simulated: [] }
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route('**/api/whatsapp/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path === '/api/whatsapp/status') {
      return json(route, { ok: true, enabled: true, reason: null, mode: 'simulator', businessNumber: '971500000100', template: false, ai: true, linked: stub.linked ? { phone: '971501234567', masked: '+971 ••• 4567' } : null })
    }
    if (path === '/api/whatsapp/link') return json(route, { ok: true, code: 'ABCD2345', text: 'LINK ABCD2345', waLink: 'https://wa.me/971500000100?text=LINK%20ABCD2345', expiresAt: '2030-01-01T10:30:00Z' })
    if (path === '/api/whatsapp/simulate') {
      const body = route.request().postDataJSON() as { text: string; phone: string }
      stub.simulated.push(`${body.phone}: ${body.text}`)
      if (/^LINK /i.test(body.text)) {
        stub.linked = true
        return json(route, { ok: true, phone: body.phone, replies: [{ body: '✅ This number is now linked to your planner account. Reply *MENU* to pick a project.', status: 'simulated' }] })
      }
      return json(route, { ok: true, phone: body.phone, replies: [{ body: '📋 *Project schedule*\n6 tasks · 1 complete\n\n*1* 🔴 Delayed: 2', status: 'simulated' }] })
    }
    if (path === '/api/whatsapp/unlink') {
      stub.linked = false
      return json(route, { ok: true })
    }
    const invite = /^\/api\/whatsapp\/contacts\/([^/]+)\/invite$/.exec(path)
    if (invite) return json(route, { ok: true, code: 'JOIN6789', text: 'JOIN JOIN6789', waLink: 'https://wa.me/971500000100?text=JOIN%20JOIN6789', message: 'Hi Ravi, we would like to send you task updates on WhatsApp.\nTap this link and press send to accept: https://wa.me/971500000100?text=JOIN%20JOIN6789', expiresAt: '2030-01-14T10:00:00Z' })
    if (/\/summary$/.test(path)) return json(route, { ok: true })
    if (/\/check$/.test(path)) return json(route, { ok: true, alerts: 2, nudges: 1, summary: false })
    return json(route, { ok: false, error: 'not stubbed' }, 404)
  })
  return stub
}

test('link a phone, chat in the simulator, invite a site contact', async ({ page }) => {
  const stub = await stubServer(page)
  await openApp(page)
  await goTo(page, 'WhatsApp')
  await expect(page.getByRole('heading', { name: 'WhatsApp', level: 1 })).toBeVisible()
  await expect(page.getByRole('note')).toContainText('Simulator mode')

  // Link: the page shows the code and the wa.me link, then notices the phone is linked.
  await page.getByRole('button', { name: 'Link my phone' }).click()
  await expect(page.getByText('LINK ABCD2345', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open WhatsApp' })).toHaveAttribute('href', 'https://wa.me/971500000100?text=LINK%20ABCD2345')

  // The test chat plays the phone: send the code, then MENU.
  const chat = page.getByRole('log', { name: 'Test chat' })
  await page.getByLabel('Phone number').fill('+971 50 123 4567')
  await page.getByLabel('Message').fill('LINK ABCD2345')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(chat).toContainText('now linked to your planner account')
  await expect(page.getByText('+971 ••• 4567')).toBeVisible({ timeout: 15_000 })
  await page.getByLabel('Message').fill('menu')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(chat.locator('b', { hasText: 'Project schedule' })).toBeVisible()
  expect(stub.simulated).toEqual(['971501234567: LINK ABCD2345', '971501234567: menu'])
  await page.screenshot({ path: 'test-results/whatsapp-phone.png', fullPage: true })

  // Site contacts: checked input, added as invited, invitation text to forward.
  await page.getByRole('tab', { name: 'Site contacts' }).click()
  await page.getByLabel('Name').fill('Ravi (MEP)')
  await page.getByLabel('E-mail in your sheets').fill('ravi@sub.example')
  await page.getByLabel('WhatsApp number').fill('12')
  await page.getByRole('button', { name: 'Add contact' }).click()
  await expect(page.getByRole('alert')).toContainText('country code')
  await page.getByLabel('WhatsApp number').fill('+971 50 765 4321')
  await page.getByRole('button', { name: 'Add contact' }).click()
  const item = page.locator('.wa-contact', { hasText: 'Ravi (MEP)' })
  await expect(item).toContainText('ravi@sub.example · +971 ••• 4321')
  await expect(item.getByText('Invited')).toBeVisible()
  await page.getByRole('button', { name: 'Invitation for Ravi (MEP)' }).click()
  await expect(page.getByRole('heading', { name: 'Invitation for Ravi (MEP)' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Send from my WhatsApp' })).toHaveAttribute('href', /^https:\/\/wa\.me\/971507654321\?text=Hi%20Ravi/)
  // The same contact twice is refused.
  await page.getByLabel('Name').fill('Ravi again')
  await page.getByLabel('E-mail in your sheets').fill('ravi@sub.example')
  await page.getByLabel('WhatsApp number').fill('+971 50 000 0000')
  await page.getByRole('button', { name: 'Add contact' }).click()
  await expect(page.getByRole('alert')).toContainText('already have a contact')
  await page.screenshot({ path: 'test-results/whatsapp-contacts.png', fullPage: true })
})

test('turn on WhatsApp alerts for a sheet; settings persist; rules can also send on WhatsApp', async ({ page }) => {
  await stubServer(page)
  await openApp(page)
  await createScheduleSheet(page)
  await goTo(page, 'WhatsApp')
  await page.getByRole('tab', { name: 'Sheet alerts' }).click()
  const card = page.getByRole('region', { name: 'WhatsApp alerts for this sheet' })
  await expect(card.getByRole('note')).toContainText('no Contact column')
  await expect(card.getByLabel('Delay alerts')).toBeDisabled()
  await card.getByRole('checkbox', { name: /WhatsApp for this sheet/ }).check()
  await card.getByLabel('Send at', { exact: true }).selectOption('7')
  await card.getByLabel('Remind after (hours)', { exact: true }).fill('12')
  await card.getByLabel('From', { exact: true }).fill('21:30')
  await card.getByRole('button', { name: 'Save' }).click()
  await expect(card.getByRole('status')).toHaveText('Saved.')
  await card.getByRole('button', { name: 'Check alerts now' }).click()
  await expect(card.getByRole('status')).toContainText('2 delay alert(s) and 1 progress check(s)')
  await page.screenshot({ path: 'test-results/whatsapp-alerts.png', fullPage: true })

  // Back later: the settings were stored.
  await goTo(page, 'Sheets')
  await goTo(page, 'WhatsApp')
  await page.getByRole('tab', { name: 'Sheet alerts' }).click()
  await expect(card.getByRole('checkbox', { name: /WhatsApp for this sheet/ })).toBeChecked()
  await expect(card.getByLabel('Send at', { exact: true })).toHaveValue('7')
  await expect(card.getByLabel('Remind after (hours)', { exact: true })).toHaveValue('12')
  await expect(card.getByLabel('From', { exact: true })).toHaveValue('21:30')

  // The Notify action of a rule can also go out on WhatsApp.
  await goTo(page, 'Automation')
  await page.getByRole('button', { name: 'New rule', exact: true }).first().click()
  const form = page.getByRole('form', { name: 'New rule' })
  await form.getByLabel('Rule name').fill('Tell me on WhatsApp')
  await form.getByRole('checkbox', { name: 'Also send on WhatsApp' }).check()
  await expect(form.getByTestId('rule-summary')).toContainText('notify me (in the app), also on WhatsApp.')
  await form.getByRole('button', { name: 'Save rule' }).click()
  await expect(page.getByRole('list', { name: 'Rules' }).getByText('also on WhatsApp')).toBeVisible()
})
