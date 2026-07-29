// Minimal stand-ins for @types/node so the packages can be typechecked before install.

declare class Buffer extends Uint8Array {
  static from(input: string | ArrayBufferLike | Uint8Array, encoding?: string): Buffer
  static alloc(size: number): Buffer
  toString(encoding?: string): string
  readonly length: number
}

declare module 'node:crypto' {
  export function randomBytes(size: number): Buffer
  export function randomUUID(): string
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean
  export function createHash(algorithm: string): {
    update(data: string | Uint8Array, encoding?: string): {
      digest(encoding: string): string
    }
  }
  export function scrypt(
    password: string | Uint8Array,
    salt: string | Uint8Array,
    keylen: number,
    options: { N?: number; r?: number; p?: number; maxmem?: number },
    callback: (err: Error | null, derivedKey: Buffer) => void,
  ): void
}

declare module 'node:util' {
  export function promisify<T>(fn: T): unknown
}

declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R
    getStore(): T | undefined
  }
}
