/** Test double for @forge/kernel-identity. */

export interface User {
  readonly id: string
  readonly email: string
}

let user: User | null = null

export async function currentUser(): Promise<User | null> {
  return user
}

export function setCurrentUser(next: User | null): void {
  user = next
}
