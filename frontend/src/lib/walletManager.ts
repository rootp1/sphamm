import { NetworkId, WalletId, WalletManager } from '@txnlab/use-wallet-react'

const supportedWallets = [
  { id: WalletId.LUTE },
  { id: WalletId.PERA },
  { id: WalletId.DEFLY },
  { id: WalletId.EXODUS },
]

export const walletManager = new WalletManager({
  wallets: supportedWallets,
  defaultNetwork: NetworkId.TESTNET,
  networks: {
    [NetworkId.TESTNET]: {
      algod: {
        baseServer: process.env.NEXT_PUBLIC_ALGOD_SERVER ?? 'https://testnet-api.algonode.cloud',
        port: process.env.NEXT_PUBLIC_ALGOD_PORT ?? '',
        token: process.env.NEXT_PUBLIC_ALGOD_TOKEN ?? '',
      },
    },
    [NetworkId.MAINNET]: {
      algod: {
        baseServer: 'https://mainnet-api.algonode.cloud',
        port: '',
        token: '',
      },
    },
  },
  options: {
    resetNetwork: true,
  },
})