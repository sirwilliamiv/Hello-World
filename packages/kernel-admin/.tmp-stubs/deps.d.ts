// Stand-ins for third-party packages not installed in this environment.

declare module 'zod' {
  class ZodErrorClass extends Error {
    issues: unknown[]
  }
  interface Z {
    [key: string]: any
    ZodError: typeof ZodErrorClass
  }
  export const z: Z
}

declare module 'drizzle-orm/pg-core' {
  export const pgTable: any
  export const text: any
  export const timestamp: any
  export const boolean: any
  export const integer: any
  export const jsonb: any
  export const index: any
  export const uniqueIndex: any
}

declare module '@forge/kernel-data' {
  export const Repository: (entity: string) => any
  export const registerEntity: (entity: any) => void
}

declare module '@forge/kernel-events' {
  export const publish: (name: string, payload: any) => Promise<void>
  export const subscribe: (pattern: string, handler: (e: any) => Promise<void>) => void
}

declare module 'vitest' {
  export const describe: (name: string, fn: () => void) => void
  export const it: (name: string, fn: () => unknown) => void
  export const beforeEach: (fn: () => unknown) => void
  export const afterEach: (fn: () => unknown) => void
  export const expect: any
}
