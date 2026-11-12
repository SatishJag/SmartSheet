import { generateKeyBetween } from 'fractional-indexing'

export interface RowNode {
  id: string
  parentId: string | null
  position: string
}

/**
 * Pure row-tree operations. Nothing here mutates its inputs. Operations that
 * cannot be applied (or would change nothing) return the SAME input array
 * reference so callers can detect "nothing changed" with `===`.
 *
 * Siblings are ordered by `position` (plain string comparison), ties broken by
 * `id`. A row whose `parentId` refers to a missing row is treated as top-level.
 */

function compareRows(a: RowNode, b: RowNode): number {
  if (a.position < b.position) return -1
  if (a.position > b.position) return 1
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

/** The parent a row effectively has: its parentId, or null if that row is missing. */
function effectiveParent(row: RowNode, ids: ReadonlySet<string>): string | null {
  return row.parentId !== null && ids.has(row.parentId) ? row.parentId : null
}

interface Tree {
  byId: Map<string, RowNode>
  ids: Set<string>
  /** Sorted children keyed by effective parent id (null = top level). */
  children: Map<string | null, RowNode[]>
}

function buildTree(rows: readonly RowNode[]): Tree {
  const byId = new Map<string, RowNode>()
  for (const r of rows) byId.set(r.id, r)
  const ids = new Set(byId.keys())
  const children = new Map<string | null, RowNode[]>()
  for (const r of rows) {
    const p = effectiveParent(r, ids)
    const list = children.get(p)
    if (list) list.push(r)
    else children.set(p, [r])
  }
  for (const list of children.values()) list.sort(compareRows)
  return { byId, ids, children }
}

/** generateKeyBetween that never throws on corrupt (non-increasing) neighbours. */
function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) return generateKeyBetween(a, null)
  return generateKeyBetween(a, b)
}

/** True if `candidateId` is `id` itself or lies anywhere beneath it. */
function isSelfOrDescendant(tree: Tree, id: string, candidateId: string): boolean {
  const seen = new Set<string>()
  let cur: string | null = candidateId
  while (cur !== null && !seen.has(cur)) {
    if (cur === id) return true
    seen.add(cur)
    const row = tree.byId.get(cur)
    cur = row ? effectiveParent(row, tree.ids) : null
  }
  return false
}

/**
 * Position for a row placed under `parentId` immediately after `afterId`
 * (`null` = first child), ignoring `excludeId` among the siblings.
 * `afterId` must be an existing child of `parentId`; otherwise returns null.
 */
function slotPosition(
  tree: Tree,
  parentId: string | null,
  afterId: string | null,
  excludeId: string | null,
): string | null {
  const siblings = (tree.children.get(parentId) ?? []).filter((r) => r.id !== excludeId)
  if (afterId === null) return keyBetween(null, siblings[0]?.position ?? null)
  const idx = siblings.findIndex((r) => r.id === afterId)
  if (idx === -1) return null
  return keyBetween(siblings[idx].position, siblings[idx + 1]?.position ?? null)
}

function replaceRow(rows: readonly RowNode[], id: string, patch: Partial<RowNode>): RowNode[] {
  return rows.map((r) => (r.id === id ? { ...r, ...patch } : r))
}

/** Row ids in depth-first order, omitting descendants of any collapsed id. */
export function visibleOrder(rows: readonly RowNode[], collapsed: ReadonlySet<string>): string[] {
  const tree = buildTree(rows)
  const out: string[] = []
  const visited = new Set<string>()
  const walk = (parentId: string | null): void => {
    for (const r of tree.children.get(parentId) ?? []) {
      if (visited.has(r.id)) continue
      visited.add(r.id)
      out.push(r.id)
      if (!collapsed.has(r.id)) walk(r.id)
    }
  }
  walk(null)
  return out
}

/** Every row id in depth-first order (nothing collapsed). */
export function fullOrder(rows: readonly RowNode[]): string[] {
  return visibleOrder(rows, new Set())
}

/**
 * The position a new row would get under `parentId`, right after `afterId`
 * (same rule as moveRow; `afterId = null` = first child). An `afterId` that is
 * not a child of `parentId` is treated as "append as the last child".
 */
export function positionForNewRow(
  rows: readonly RowNode[],
  parentId: string | null,
  afterId: string | null,
): string {
  const tree = buildTree(rows)
  const pos = slotPosition(tree, parentId, afterId, null)
  if (pos !== null) return pos
  const siblings = tree.children.get(parentId) ?? []
  return keyBetween(siblings[siblings.length - 1]?.position ?? null, null)
}

/** The row becomes the last child of its previous sibling. No-op for a first sibling. */
export function indent(rows: RowNode[], id: string): RowNode[] {
  const tree = buildTree(rows)
  const row = tree.byId.get(id)
  if (!row) return rows
  const siblings = tree.children.get(effectiveParent(row, tree.ids)) ?? []
  const idx = siblings.findIndex((r) => r.id === id)
  if (idx <= 0) return rows
  const prev = siblings[idx - 1]
  const prevChildren = tree.children.get(prev.id) ?? []
  const position = keyBetween(prevChildren[prevChildren.length - 1]?.position ?? null, null)
  return replaceRow(rows, id, { parentId: prev.id, position })
}

/** The row moves to its grandparent, right after its former parent. No-op at top level. */
export function outdent(rows: RowNode[], id: string): RowNode[] {
  const tree = buildTree(rows)
  const row = tree.byId.get(id)
  if (!row) return rows
  const parentId = effectiveParent(row, tree.ids)
  if (parentId === null) return rows
  const parent = tree.byId.get(parentId)!
  const grandParentId = effectiveParent(parent, tree.ids)
  const parentSiblings = tree.children.get(grandParentId) ?? []
  const pIdx = parentSiblings.findIndex((r) => r.id === parentId)
  const position = keyBetween(parent.position, parentSiblings[pIdx + 1]?.position ?? null)
  return replaceRow(rows, id, { parentId: grandParentId, position })
}

/**
 * Put the row under `newParentId` immediately after `afterId` (`null` = first
 * child). Invalid moves return the input unchanged: unknown ids, moving a row
 * under itself or a descendant, `afterId` not a child of `newParentId`, or
 * `afterId === id`.
 */
export function moveRow(
  rows: RowNode[],
  id: string,
  afterId: string | null,
  newParentId: string | null,
): RowNode[] {
  const tree = buildTree(rows)
  if (!tree.byId.has(id)) return rows
  if (afterId === id) return rows
  if (newParentId !== null) {
    if (!tree.byId.has(newParentId)) return rows
    if (isSelfOrDescendant(tree, id, newParentId)) return rows
  }
  if (afterId !== null) {
    const after = tree.byId.get(afterId)
    if (!after || effectiveParent(after, tree.ids) !== newParentId) return rows
  }
  const position = slotPosition(tree, newParentId, afterId, id)
  if (position === null) return rows
  return replaceRow(rows, id, { parentId: newParentId, position })
}

/** Removes the row and all its descendants; `removedIds` is depth-first, the row first. */
export function deleteWithChildren(
  rows: RowNode[],
  id: string,
): { rows: RowNode[]; removedIds: string[] } {
  const tree = buildTree(rows)
  if (!tree.byId.has(id)) return { rows, removedIds: [] }
  const removedIds: string[] = []
  const seen = new Set<string>()
  const walk = (rid: string): void => {
    if (seen.has(rid)) return
    seen.add(rid)
    removedIds.push(rid)
    for (const c of tree.children.get(rid) ?? []) walk(c.id)
  }
  walk(id)
  return { rows: rows.filter((r) => !seen.has(r.id)), removedIds }
}
