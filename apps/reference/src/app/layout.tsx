import { AppShell } from '@forge/kernel-ui'
import '@/generated/kernel.ui/tokens.css'
import '@/generated/kernel.ui/navigation'

export const metadata = { title: "reference" }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppShell product={"reference"}>{children}</AppShell>
      </body>
    </html>
  )
}
