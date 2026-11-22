import { describe, expect, it, vi } from 'vitest'
import { contextFromSearch, listenForProcoreContext } from './context'

describe('contextFromSearch', () => {
  it('reads the company and project from the address', () => {
    expect(contextFromSearch('?company=42&project=7')).toEqual({ companyId: '42', projectId: '7' })
    expect(contextFromSearch('?view=panel&project=7&company=42')).toEqual({ companyId: '42', projectId: '7' })
  })

  it('ignores ids that are not numbers', () => {
    expect(contextFromSearch('?company=abc&project=7')).toBeNull()
    expect(contextFromSearch('?company=42')).toBeNull()
    expect(contextFromSearch('?company={{procore.company.id}}&project=7')).toBeNull()
    expect(contextFromSearch('')).toBeNull()
  })
})

/** A fake window: records postMessage calls and lets a test dispatch message events. */
function fakeWindow() {
  const listeners = new Set<(e: MessageEvent) => void>()
  const parent = { postMessage: vi.fn() }
  const win = {
    parent,
    addEventListener: vi.fn((type: string, fn: (e: MessageEvent) => void) => type === 'message' && listeners.add(fn)),
    removeEventListener: vi.fn((type: string, fn: (e: MessageEvent) => void) => type === 'message' && listeners.delete(fn)),
  }
  const send = (origin: string, data: unknown, source: unknown = parent) => listeners.forEach((fn) => fn({ origin, data, source } as unknown as MessageEvent))
  return { win: win as unknown as Window, parent, send, listeners }
}

describe('listenForProcoreContext', () => {
  it('asks Procore for the context and reads the setup message', () => {
    const { win, parent, send } = fakeWindow()
    const onContext = vi.fn()
    listenForProcoreContext(win, 'https://app.procore.com/', onContext)
    expect(parent.postMessage).toHaveBeenCalledWith({ type: 'initialize' }, 'https://app.procore.com')
    send('https://app.procore.com', { type: 'setup', context: { company_id: 42, project_id: 7, view: 'budgeting.list', id: null } })
    expect(onContext).toHaveBeenCalledWith({ companyId: '42', projectId: '7' })
  })

  it('does not post to a referrer that is not Procore', () => {
    const { win, parent } = fakeWindow()
    listenForProcoreContext(win, 'https://evil.example/', vi.fn())
    listenForProcoreContext(win, '', vi.fn())
    expect(parent.postMessage).not.toHaveBeenCalled()
  })

  it('ignores messages from other origins', () => {
    const { win, send } = fakeWindow()
    const onContext = vi.fn()
    listenForProcoreContext(win, 'https://app.procore.com/', onContext)
    send('https://app.procore.com.evil.example', { type: 'setup', context: { company_id: 1, project_id: 2 } })
    send('https://evil.example', { type: 'setup', context: { company_id: 1, project_id: 2 } })
    expect(onContext).not.toHaveBeenCalled()
  })

  it('ignores life-cycle and malformed messages, and stops listening on cleanup', () => {
    const { win, send, listeners } = fakeWindow()
    const onContext = vi.fn()
    const stop = listenForProcoreContext(win, 'https://sandbox.procore.com/', onContext)
    for (const data of [{ type: 'sidepanel:app:visible' }, { type: 'sidepanel:app:hidden' }, { type: 'sidepanel:app:destroy' }, { type: 'setup' }, { type: 'setup', context: { company_id: 'x', project_id: 2 } }, null, 'setup'])
      send('https://sandbox.procore.com', data)
    expect(onContext).not.toHaveBeenCalled()
    stop()
    expect(listeners.size).toBe(0)
  })
})

describe('listenForProcoreContext: only the window that framed the page (review fix)', () => {
  it('ignores a Procore-origin message from any window other than the parent', () => {
    const { win, send } = fakeWindow()
    const onContext = vi.fn()
    listenForProcoreContext(win, 'https://app.procore.com/', onContext)
    send('https://app.procore.com', { type: 'setup', context: { company_id: 42, project_id: 7 } }, { postMessage: vi.fn() })
    expect(onContext).not.toHaveBeenCalled()
  })
})
