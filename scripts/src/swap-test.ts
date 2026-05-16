import algosdk from 'algosdk'
import { getAccountFromMnemonic, getAlgodClient, getRequiredEnv, getSuggestedParams, waitFor } from './common.ts'

function encU64(v: number | bigint) {
  return algosdk.encodeUint64(BigInt(v))
}

function readUintState(globalState: any[], key: string): number {
  return Number(globalState.find((x: any) => Buffer.from(x.key, 'base64').toString('utf8') === key)?.value?.uint ?? 0)
}

function globalInvariant(a: number, b: number, c: number): bigint {
  return BigInt(a) * BigInt(a) + BigInt(b) * BigInt(b) + BigInt(c) * BigInt(c)
}

function sqrtFloor(value: bigint): bigint {
  if (value < 2n) return value
  let x0 = value
  let x1 = (x0 + value / x0) / 2n
  while (x1 < x0) {
    x0 = x1
    x1 = (x0 + value / x0) / 2n
  }
  return x0
}

function computeQuoteStats(reserveInN: number, reserveOutN: number, reserveThirdN: number, amountInN: number) {
  const reserveIn = BigInt(reserveInN)
  const reserveOut = BigInt(reserveOutN)
  const reserveThird = BigInt(reserveThirdN)
  const amountIn = BigInt(amountInN)
  const k = globalInvariant(reserveInN, reserveOutN, reserveThirdN)
  const sqIn = reserveIn * reserveIn
  const sqOut = reserveOut * reserveOut
  const sqThird = reserveThird * reserveThird
  const maxSq = [sqIn, sqOut, sqThird].reduce((a, b) => (a > b ? a : b), 0n)
  const dominanceBps = Number((maxSq * 10_000n) / k)
  const feeBps = dominanceBps <= 3400 ? 30 : dominanceBps >= 6400 ? 100 : 30 + Math.floor(((dominanceBps - 3400) * 70) / 3000)
  const amountInAfterFee = (amountIn * BigInt(10_000 - feeBps)) / 10_000n
  let base = (reserveThird * amountInAfterFee) / (reserveIn * 20n)
  if (base <= 0n) base = 1n
  let deltaThird = (base * (10_000n + BigInt(dominanceBps))) / 10_000n
  if (deltaThird <= 0n) deltaThird = 1n
  if (deltaThird >= reserveThird) deltaThird = reserveThird - 1n
  const newReserveThird = reserveThird - deltaThird
  const newReserveIn = reserveIn + amountInAfterFee
  const targetOutSq = k - newReserveIn * newReserveIn - newReserveThird * newReserveThird
  const newReserveOut = sqrtFloor(targetOutSq)
  const amountOut = reserveOut - newReserveOut
  return {
    dominanceBps,
    feeBps,
    amountInAfterFee: Number(amountInAfterFee),
    deltaThird: Number(deltaThird),
    estimatedOut: Number(amountOut),
    newReserveThird: Number(newReserveThird),
  }
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
  const quoteStats = computeQuoteStats(reserveABefore, reserveBBefore, reserveCBefore, amountIn)

  console.log('Reserves before swap')
  console.log(`reserveA=${reserveABefore}`)
  console.log(`reserveB=${reserveBBefore}`)
  console.log(`reserveC=${reserveCBefore}`)
  console.log(`K_orbital_before=${invariantBefore}`)
  console.log(`dominance_bps_before=${quoteStats.dominanceBps}`)
  console.log(`effective_fee_bps=${quoteStats.feeBps}`)
  console.log(`amount_in_after_fee=${quoteStats.amountInAfterFee}`)
  console.log(`third_reserve_adjustment_est=${quoteStats.deltaThird}`)
  console.log(`estimated_amount_out=${quoteStats.estimatedOut}`)

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
    suggestedParams: { ...sp, fee: 5_000n },
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
  const realizedOut = reserveBBefore - reserveBAfter
  const realizedDeltaThird = reserveCBefore - reserveCAfter
  const slippageAbs = quoteStats.estimatedOut - realizedOut
  const slippageBps = quoteStats.estimatedOut > 0 ? Math.floor((slippageAbs * 10_000) / quoteStats.estimatedOut) : 0

  console.log('Swap completed: 10 A -> B')
  console.log('Reserves after swap')
  console.log(`reserveA=${reserveAAfter}`)
  console.log(`reserveB=${reserveBAfter}`)
  console.log(`reserveC=${reserveCAfter}`)
  console.log(`K_orbital_after=${invariantAfter}`)
  console.log(`third_reserve_adjustment_realized=${realizedDeltaThird}`)
  console.log(`amount_out_realized=${realizedOut}`)
  console.log(`slippage_vs_estimate_bps=${slippageBps}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
