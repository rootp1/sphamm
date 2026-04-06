import algosdk from 'algosdk'

export function getAlgodClient(): algosdk.Algodv2 {
  const server = process.env.ALGOD_SERVER ?? 'https://testnet-api.algonode.cloud'
  const port = process.env.ALGOD_PORT ?? '443'
  const token = process.env.ALGOD_TOKEN ?? ''
  return new algosdk.Algodv2(token, server, port)
}

export function getAccountFromMnemonic(envVar: 'DEPLOYER_MNEMONIC' | 'USER_MNEMONIC'): algosdk.Account {
  const mnemonic = process.env[envVar]
  if (!mnemonic) throw new Error(`${envVar} is required`)
  return algosdk.mnemonicToSecretKey(mnemonic)
}

export async function waitFor(algod: algosdk.Algodv2, txId: string) {
  return algosdk.waitForConfirmation(algod, txId, 6)
}

export function getRequiredEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is required`)
  return v
}

export async function getSuggestedParams(algod: algosdk.Algodv2) {
  const sp = await algod.getTransactionParams().do()
  sp.flatFee = true
  sp.fee = 1_000n
  return sp
}
