/**
 * Stylesheet imports.
 *
 * AppShell imports this package's two stylesheets so that a product gets them
 * by mounting the shell, and so that the *generated* tokens.css — imported
 * after it in the root layout — overrides them on source order. The bundler
 * (Next.js/webpack, or Vite in tests) handles the import; TypeScript needs to
 * be told the module exists.
 */
declare module '*.css' {
  const content: string
  export default content
}
