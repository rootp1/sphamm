import algosdk from 'algosdk'

export const algod = new algosdk.Algodv2(
  process.env.NEXT_PUBLIC_ALGOD_TOKEN ?? '',
  process.env.NEXT_PUBLIC_ALGOD_SERVER ?? 'https://testnet-api.algonode.cloud',
  process.env.NEXT_PUBLIC_ALGOD_PORT ?? '443',
)

export const appId = Number(process.env.NEXT_PUBLIC_AMM_APP_ID ?? '0')
export const assetAId = Number(process.env.NEXT_PUBLIC_ASSET_A_ID ?? '0')
export const assetBId = Number(process.env.NEXT_PUBLIC_ASSET_B_ID ?? '0')
export const assetCId = Number(process.env.NEXT_PUBLIC_ASSET_C_ID ?? '0')

export const assets = [
  { id: assetAId, symbol: 'A' },
  { id: assetBId, symbol: 'B' },
  { id: assetCId, symbol: 'C' },
]

export function encodeU64(v: number | bigint) {
  return algosdk.encodeUint64(BigInt(v))
}

export function getAppAddress() {
  return algosdk.getApplicationAddress(appId)
}
