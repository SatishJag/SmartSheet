import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('App', () => {
  it('shows the not-configured screen when Supabase env is missing', () => {
    vi.stubEnv('VITE_SUPABASE_URL', '')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')
    render(<App />)
    expect(screen.getByText('Supabase is not configured')).toBeInTheDocument()
    expect(screen.getByText('VITE_SUPABASE_URL')).toBeInTheDocument()
    expect(screen.getByText('VITE_SUPABASE_ANON_KEY')).toBeInTheDocument()
  })
})
