import './globals.css'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Tri-Asset AMM MVP',
  description: '3-asset AMM on Algorand TestNet',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
