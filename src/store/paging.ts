/** PostgREST (Supabase) returns at most this many rows per request by default. */
export const PAGE_SIZE = 1000

type PageResult<T> = { data: T[] | null; error: { message: string } | null }

/**
 * Loads every row of a query page by page. `page(from, to)` must build a FRESH query with a
 * stable total order (for example `.order('id')`) and `.range(from, to)`. Stops at the first
 * page shorter than PAGE_SIZE. Throws when a page fails, returns too many rows, or repeats an id
 * (the order was not stable), so a truncated or inconsistent load never passes as complete.
 */
export async function fetchAllPages<T extends { id: string }>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const out: T[] = []
  const seen = new Set<string>()
  for (let from = 0; ; from += PAGE_SIZE) {
    const res = await page(from, from + PAGE_SIZE - 1)
    if (res.error) throw new Error(res.error.message)
    const rows = res.data ?? []
    if (rows.length > PAGE_SIZE) throw new Error(`Paging returned more rows than requested (${rows.length})`)
    for (const r of rows) {
      if (seen.has(r.id)) throw new Error('Paging returned repeated rows; the data changed while loading. Reload the sheet.')
      seen.add(r.id)
      out.push(r)
    }
    if (rows.length < PAGE_SIZE) return out
  }
}
