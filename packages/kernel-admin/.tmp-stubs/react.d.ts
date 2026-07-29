declare module 'react' {
  export const useState: any
  export const useEffect: any
  export const useCallback: any
  export type FormEvent<T = any> = any
  export namespace JSX {
    type Element = any
  }
}

declare module 'react/jsx-runtime' {
  export const jsx: any
  export const jsxs: any
  export const Fragment: any
  export namespace JSX {
    type Element = any
    interface IntrinsicElements {
      [name: string]: any
    }
    interface ElementChildrenAttribute {
      children: unknown
    }
  }
}
