declare module '@forge/kernel-access' {
  export function can(user: any, action: string, resource?: any): Promise<boolean>
  export function RequirePermission(action: string): any
  export function registerPermission(entry: any): void
}
