import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemePicker } from './ThemePicker'
import { applyTheme, initTheme, readTheme, THEME_STORAGE_KEY, THEMES } from './theme'
import { DENSITY_STORAGE_KEY, readDensity, saveDensity } from '../views/density'

beforeEach(() => {
  document.head.innerHTML = '<meta name="theme-color" content="#000000" />'
  delete document.documentElement.dataset.theme
  localStorage.clear()
})
afterEach(() => vi.restoreAllMocks())

describe('theme', () => {
  it('offers the eight PMIS themes, orange first', () => {
    expect(THEMES.map((t) => t.id)).toEqual(['orange', 'blue', 'purple', 'green', 'red', 'teal', 'grey', 'black'])
  })

  it('applies a theme to <html>, the theme-color meta and localStorage', () => {
    expect(applyTheme('teal')).toBe('teal')
    expect(document.documentElement.dataset.theme).toBe('teal')
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', '#0d9488')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('teal')
  })

  it('falls back to orange for an unknown saved value, and initTheme restores the saved one', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'nope')
    expect(readTheme()).toBe('orange')
    localStorage.setItem(THEME_STORAGE_KEY, 'purple')
    expect(initTheme()).toBe('purple')
    expect(document.documentElement.dataset.theme).toBe('purple')
  })

  it('still applies the theme when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readTheme()).toBe('orange')
    expect(applyTheme('blue')).toBe('blue')
    expect(document.documentElement.dataset.theme).toBe('blue')
  })
})

describe('ThemePicker', () => {
  it('opens a swatch popover, picks a theme and closes on Escape', () => {
    render(<ThemePicker />)
    const button = screen.getByRole('button', { name: 'Change colour theme' })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('radio', { name: 'Orange' })).toBeChecked()
    fireEvent.click(screen.getByRole('radio', { name: 'Green' }))
    expect(screen.getByRole('radio', { name: 'Green' })).toBeChecked()
    expect(document.documentElement.dataset.theme).toBe('green')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
    expect(button).toHaveFocus()
  })
})

describe('density preference', () => {
  it('defaults to compact, remembers comfortable, and survives blocked storage', () => {
    expect(readDensity()).toBe('compact')
    saveDensity('comfortable')
    expect(localStorage.getItem(DENSITY_STORAGE_KEY)).toBe('comfortable')
    expect(readDensity()).toBe('comfortable')
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readDensity()).toBe('compact')
  })
})
