import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RichText } from './RichText'

describe('RichText', () => {
  it('renders headings, paragraphs, bullet lists and inline styles', () => {
    const { container } = render(<RichText text={'# Site status\n\nAll **on track** and *calm*.\nSecond line.\n\n- one\n- two\n\n## Notes'} />)
    expect(screen.getByRole('heading', { level: 3, name: 'Site status' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 4, name: 'Notes' })).toBeInTheDocument()
    expect(container.querySelector('strong')?.textContent).toBe('on track')
    expect(container.querySelector('em')?.textContent).toBe('calm')
    expect(container.querySelector('p')?.textContent).toBe('All on track and calm. Second line.')
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['one', 'two'])
  })

  it('keeps only web links, opened safely, and never renders markup as HTML', () => {
    const { container } = render(
      <RichText text={'[ok](https://example.com/a) [bad](javascript:alert(1)) <img src=x onerror=alert(1)> <script>alert(1)</script>'} />,
    )
    const links = container.querySelectorAll('a')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', 'https://example.com/a')
    expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer')
    expect(container.querySelector('img, script')).toBeNull()
    expect(container.textContent).toContain('[bad](javascript:alert(1))')
    expect(container.textContent).toContain('<script>alert(1)</script>')
  })
})
