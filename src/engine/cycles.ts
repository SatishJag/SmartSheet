import type { SchedDep } from './schedule'

export interface CycleGroup {
  /** Every row id in the strongly connected component, in first-seen order. */
  members: string[]
  /** One concrete cycle through the group, in dependency order (predecessor before successor). */
  path: string[]
}

/**
 * Finds every group of rows that depend on each other (strongly connected components
 * with a cycle, via an iterative Tarjan so deep chains cannot overflow the stack).
 * A single-row component only counts when the row depends on itself.
 * Groups are ordered by the first-seen position of their earliest member.
 */
export function findCycleGroups(deps: Pick<SchedDep, 'predecessorId' | 'successorId'>[]): CycleGroup[] {
  const index = new Map<string, number>() // first-seen order, also the node id
  const names: string[] = []
  const adj: number[][] = []
  const selfEdge = new Set<number>()
  const idOf = (name: string): number => {
    let i = index.get(name)
    if (i === undefined) {
      i = names.length
      index.set(name, i)
      names.push(name)
      adj.push([])
    }
    return i
  }
  for (const d of deps) {
    const from = idOf(d.predecessorId)
    const to = idOf(d.successorId)
    adj[from].push(to)
    if (from === to) selfEdge.add(from)
  }

  const n = names.length
  const order = new Array<number>(n).fill(-1)
  const low = new Array<number>(n).fill(0)
  const onStack = new Array<boolean>(n).fill(false)
  const stack: number[] = []
  let counter = 0
  const components: number[][] = []

  for (let root = 0; root < n; root++) {
    if (order[root] !== -1) continue
    const work: [node: number, nextEdge: number][] = [[root, 0]]
    order[root] = low[root] = counter++
    stack.push(root)
    onStack[root] = true

    while (work.length > 0) {
      const frame = work[work.length - 1]
      const v = frame[0]
      if (frame[1] < adj[v].length) {
        const w = adj[v][frame[1]++]
        if (order[w] === -1) {
          order[w] = low[w] = counter++
          stack.push(w)
          onStack[w] = true
          work.push([w, 0])
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], order[w])
        }
      } else {
        work.pop()
        if (work.length > 0) {
          const parent = work[work.length - 1][0]
          low[parent] = Math.min(low[parent], low[v])
        }
        if (low[v] === order[v]) {
          const component: number[] = []
          let w: number
          do {
            w = stack.pop()!
            onStack[w] = false
            component.push(w)
          } while (w !== v)
          if (component.length > 1 || selfEdge.has(v)) components.push(component.sort((a, b) => a - b))
        }
      }
    }
  }

  components.sort((a, b) => a[0] - b[0])
  return components.map((component) => ({
    members: component.map((i) => names[i]),
    path: cyclePath(component, adj).map((i) => names[i]),
  }))
}

/** Shortest cycle back to the component's earliest row, staying inside the component. */
function cyclePath(component: number[], adj: number[][]): number[] {
  const inside = new Set(component)
  const start = component[0]
  const from = new Map<number, number>()
  const queue = [start]
  for (let i = 0; i < queue.length; i++) {
    const u = queue[i]
    for (const v of adj[u]) {
      if (!inside.has(v)) continue
      if (v === start) {
        const path = [u]
        while (path[path.length - 1] !== start) path.push(from.get(path[path.length - 1])!)
        return path.reverse()
      }
      if (!from.has(v)) {
        from.set(v, u)
        queue.push(v)
      }
    }
  }
  return [start] // unreachable: a component with a cycle always has a path back to start
}

/** The row ids of one dependency cycle in cycle order, or null if there is none. A self-dependency gives [id]. */
export function findCycle(deps: SchedDep[]): string[] | null {
  return findCycleGroups(deps)[0]?.path ?? null
}

/** Every row id that sits inside any dependency cycle. */
export function findCycleRows(deps: SchedDep[]): Set<string> {
  return new Set(findCycleGroups(deps).flatMap((g) => g.members))
}
