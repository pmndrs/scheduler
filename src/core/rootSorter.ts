//* Root Sorter - Stable Topological Ordering ==============================

import type { RootEntry } from '../types'

/**
 * Sort roots by hard before/after dependencies, using numeric order and
 * registration sequence as the stable preference between available roots.
 */
export function rebuildSortedRoots(roots: Iterable<RootEntry>): RootEntry[] {
  const baseline = Array.from(roots).sort(compareRoots)
  if (baseline.length <= 1) return baseline
  if (!baseline.some((root) => root.before.size > 0 || root.after.size > 0)) return baseline

  const rootMap = new Map(baseline.map((root) => [root.id, root]))
  const inDegree = new Map<string, number>()
  const adjacency = new Map<string, Set<string>>()
  let hasResolvedConstraints = false

  for (const root of baseline) {
    inDegree.set(root.id, 0)
    adjacency.set(root.id, new Set())
  }

  const addEdge = (from: string, to: string) => {
    if (!rootMap.has(from) || !rootMap.has(to)) return

    const neighbors = adjacency.get(from)!
    if (neighbors.has(to)) return

    neighbors.add(to)
    inDegree.set(to, inDegree.get(to)! + 1)
    hasResolvedConstraints = true
  }

  for (const root of baseline) {
    for (const target of root.before) addEdge(root.id, target)
    for (const target of root.after) addEdge(target, root.id)
  }

  if (!hasResolvedConstraints) return baseline

  const ready = baseline.filter((root) => inDegree.get(root.id) === 0)
  const result: RootEntry[] = []

  while (ready.length > 0) {
    const root = ready.shift()!
    result.push(root)

    for (const neighborId of adjacency.get(root.id)!) {
      const degree = inDegree.get(neighborId)! - 1
      inDegree.set(neighborId, degree)
      if (degree === 0) insertSorted(ready, rootMap.get(neighborId)!)
    }
  }

  if (result.length === baseline.length) return result

  console.warn('[Scheduler] Circular dependency detected in root constraints')
  return sortCollapsedGraph(baseline, adjacency)
}

//* Cycle Recovery --------------------------------

/**
 * Collapse each strongly connected component into one DAG node. Roots within a
 * cycle use stable fallback order, while every valid edge outside it is retained.
 */
function sortCollapsedGraph(baseline: RootEntry[], adjacency: Map<string, Set<string>>): RootEntry[] {
  const components = findStronglyConnectedComponents(baseline, adjacency)
  const componentByRoot = new Map<string, number>()
  const componentEdges = components.map(() => new Set<number>())
  const inDegree = components.map(() => 0)

  components.forEach((component, componentIndex) => {
    for (const root of component) componentByRoot.set(root.id, componentIndex)
  })

  for (const [rootId, neighbors] of adjacency) {
    const from = componentByRoot.get(rootId)!

    for (const neighborId of neighbors) {
      const to = componentByRoot.get(neighborId)!
      if (from === to || componentEdges[from].has(to)) continue

      componentEdges[from].add(to)
      inDegree[to]++
    }
  }

  const ready = components
    .map((_, index) => index)
    .filter((index) => inDegree[index] === 0)
    .sort((a, b) => compareRoots(components[a][0], components[b][0]))
  const result: RootEntry[] = []

  while (ready.length > 0) {
    const componentIndex = ready.shift()!
    result.push(...components[componentIndex])

    for (const neighborIndex of componentEdges[componentIndex]) {
      inDegree[neighborIndex]--
      if (inDegree[neighborIndex] === 0) insertComponentSorted(ready, neighborIndex, components)
    }
  }

  return result
}

/** Find root cycles with Tarjan's strongly connected components algorithm. */
function findStronglyConnectedComponents(baseline: RootEntry[], adjacency: Map<string, Set<string>>): RootEntry[][] {
  const rootMap = new Map(baseline.map((root) => [root.id, root]))
  const indices = new Map<string, number>()
  const lowLinks = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const components: RootEntry[][] = []
  let nextIndex = 0

  const visit = (rootId: string): void => {
    indices.set(rootId, nextIndex)
    lowLinks.set(rootId, nextIndex)
    nextIndex++
    stack.push(rootId)
    onStack.add(rootId)

    for (const neighborId of adjacency.get(rootId)!) {
      if (!indices.has(neighborId)) {
        visit(neighborId)
        lowLinks.set(rootId, Math.min(lowLinks.get(rootId)!, lowLinks.get(neighborId)!))
      } else if (onStack.has(neighborId)) {
        lowLinks.set(rootId, Math.min(lowLinks.get(rootId)!, indices.get(neighborId)!))
      }
    }

    if (lowLinks.get(rootId) !== indices.get(rootId)) return

    const component: RootEntry[] = []
    let memberId: string

    do {
      memberId = stack.pop()!
      onStack.delete(memberId)
      component.push(rootMap.get(memberId)!)
    } while (memberId !== rootId)

    components.push(component.sort(compareRoots))
  }

  for (const root of baseline) {
    if (!indices.has(root.id)) visit(root.id)
  }

  return components
}

//* Stable Preference --------------------------------

/** Numeric order first, then registration sequence. */
function compareRoots(a: RootEntry, b: RootEntry): number {
  return a.order !== b.order ? a.order - b.order : a.sequence - b.sequence
}

/** Insert into an already sorted ready queue. */
function insertSorted(roots: RootEntry[], root: RootEntry): void {
  let index = 0
  while (index < roots.length && compareRoots(roots[index], root) <= 0) index++
  roots.splice(index, 0, root)
}

/** Insert a component into the ready queue by its first root's preference. */
function insertComponentSorted(ready: number[], component: number, components: RootEntry[][]): void {
  let index = 0
  while (index < ready.length && compareRoots(components[ready[index]][0], components[component][0]) <= 0) index++
  ready.splice(index, 0, component)
}
