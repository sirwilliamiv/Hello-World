declare module '@forge/kernel-data' {
  export interface EntityRegistryEntry { name: string; owner: string; fields: readonly { name: string; type: string; required?: boolean }[] }
  export const entities: { get(name: string): any; all(): readonly any[] }
  export function registerEntity(entity: any): void
  export function Repository(entity: string): any
}
