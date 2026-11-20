/** A tiny event bus so the notification bell refreshes the moment a rule creates a notification. */
const listeners = new Set<() => void>()

export function emitNotificationsChanged(): void {
  listeners.forEach((l) => l())
}

export function onNotificationsChanged(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
