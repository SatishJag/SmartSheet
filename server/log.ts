/** Server-side structured logging. Never receives secrets: callers pass only names, statuses and ids. */
export type Logger = (event: string, detail?: Record<string, unknown>) => void

export const consoleLogger: Logger = (event, detail) => {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...detail }))
}

export const silentLogger: Logger = () => {}
