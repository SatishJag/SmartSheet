import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSupabaseConfig } from './supabase'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('getSupabaseConfig', () => {
  it('returns null when the URL is missing', () => {
    vi.stubEnv('VITE_SUPABASE_URL', '')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'fake-anon-key')
    expect(getSupabaseConfig()).toBeNull()
  })

  it('returns null when the anon key is missing', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')
    expect(getSupabaseConfig()).toBeNull()
  })

  it('returns the config when both are set', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'fake-anon-key')
    expect(getSupabaseConfig()).toEqual({
      url: 'https://example.supabase.co',
      anonKey: 'fake-anon-key',
    })
  })
})
