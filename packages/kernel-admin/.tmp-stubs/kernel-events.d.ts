declare module '@forge/kernel-events' {
  export function publish(name: string, payload: unknown): Promise<void>
  export function subscribe(pattern: string, handler: (e: unknown) => Promise<void>): void
}
