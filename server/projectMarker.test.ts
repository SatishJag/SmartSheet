// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { createProjectMarker } from './projectMarker'

function fakeService(error: { message: string } | null = null) {
  const calls: unknown[][] = []
  const chain = {
    update: (patch: unknown) => (calls.push(['update', patch]), chain),
    eq: (col: string, value: unknown) => (calls.push(['eq', col, value]), chain),
    then: (resolve: (v: { error: typeof error }) => unknown) => Promise.resolve({ error }).then(resolve),
  }
  const from = vi.fn(() => chain)
  return { client: { from } as unknown as SupabaseClient, from, calls }
}

describe('createProjectMarker', () => {
  it('marks only that project, and only if it is not marked yet', async () => {
    const { client, from, calls } = fakeService()
    await createProjectMarker(client)('BKK-04')
    expect(from).toHaveBeenCalledWith('projects')
    expect(calls).toEqual([
      ['update', { in_procore: true }],
      ['eq', 'code', 'BKK-04'],
      ['eq', 'in_procore', false],
    ])
  })

  it('throws the database error', async () => {
    const { client } = fakeService({ message: 'permission denied' })
    await expect(createProjectMarker(client)('BKK-04')).rejects.toThrow('permission denied')
  })
})
