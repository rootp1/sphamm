import './globals.css'
import type { Metadata } from 'next'
import AppWalletProvider from '../components/WalletProvider'

export const metadata: Metadata = {
  title: 'Tri-Asset AMM MVP',
  description: '3-asset AMM on Algorand TestNet',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppWalletProvider>{children}</AppWalletProvider>
      </body>
    </html>
  )
}
