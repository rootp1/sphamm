'use client'

import { WalletProvider } from '@txnlab/use-wallet-react'
import { walletManager } from '../lib/walletManager'

export default function AppWalletProvider({ children }: { children: React.ReactNode }) {
  return <WalletProvider manager={walletManager}>{children}</WalletProvider>
}