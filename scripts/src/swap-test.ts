import algosdk from 'algosdk'
import { getAccountFromMnemonic, getAlgodClient, getRequiredEnv, getSuggestedParams, waitFor } from './common.ts'

function encU64(v: number | bigint) {
  return algosdk.encodeUint64(BigInt(v))
}

function readUintState(globalState: any[], key: string): number {
  return Number(globalState.find((x: any) => Buffer.from(x.key, 'base64').toString('utf8') === key)?.value?.uint ?? 0)
}

function globalInvariant(a: number, b: number, c: number): bigint {
  return BigInt(a) * BigInt(b) * BigInt(c)
}

async function main() {
  const algod = getAlgodClient()
  const user = getAccountFromMnemonic('USER_MNEMONIC')

  const appId = Number(getRequiredEnv('AMM_APP_ID'))
  const assetAId = Number(getRequiredEnv('ASSET_A_ID'))
  const assetBId = Number(getRequiredEnv('ASSET_B_ID'))

  const amountIn = 10
  const minAmountOut = 1

  const appInfoBefore = await algod.getApplicationByID(appId).do()
  const gsBefore = appInfoBefore.params.globalState ?? []
  const reserveABefore = readUintState(gsBefore, 'reserveA')
  const reserveBBefore = readUintState(gsBefore, 'reserveB')
  const reserveCBefore = readUintState(gsBefore, 'reserveC')
  const invariantBefore = globalInvariant(reserveABefore, reserveBBefore, reserveCBefore)

  console.log('Reserves before swap')
  console.log(`reserveA=${reserveABefore}`)
  console.log(`reserveB=${reserveBBefore}`)
  console.log(`reserveC=${reserveCBefore}`)
  console.log(`K_global_before=${invariantBefore}`)

  const appAddress = algosdk.getApplicationAddress(appId)
  const sp = await getSuggestedParams(algod)
  const swapMethod = new algosdk.ABIMethod({
    name: 'swap_exact_in',
    args: [
      { type: 'uint64', name: 'assetInId' },
      { type: 'uint64', name: 'amountIn' },
      { type: 'uint64', name: 'minAmountOut' },
    ],
    returns: { type: 'uint64' },
  })

  const tx0 = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: user.addr,
    receiver: appAddress,
    amount: amountIn,
    assetIndex: assetAId,
    suggestedParams: sp,
  })

  const appArgs = [swapMethod.getSelector(), encU64(assetAId), encU64(amountIn), encU64(minAmountOut)]
  const tx1 = algosdk.makeApplicationNoOpTxnFromObject({
    sender: user.addr,
    appIndex: BigInt(appId),
    appArgs,
    foreignAssets: [assetBId],
    suggestedParams: { ...sp, fee: 2_000n },
  })

  algosdk.assignGroupID([tx0, tx1])

  const signed = [tx0.signTxn(user.sk), tx1.signTxn(user.sk)]
  const { txid } = await algod.sendRawTransaction(signed).do()
  await waitFor(algod, txid)

  const appInfo = await algod.getApplicationByID(appId).do()
  const g = appInfo.params.globalState ?? []
  const reserveAAfter = readUintState(g, 'reserveA')
  const reserveBAfter = readUintState(g, 'reserveB')
  const reserveCAfter = readUintState(g, 'reserveC')
  const invariantAfter = globalInvariant(reserveAAfter, reserveBAfter, reserveCAfter)

  console.log('Swap completed: 10 A -> B')
  console.log('Reserves after swap')
  console.log(`reserveA=${reserveAAfter}`)
  console.log(`reserveB=${reserveBAfter}`)
  console.log(`reserveC=${reserveCAfter}`)
  console.log(`K_global_after=${invariantAfter}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
