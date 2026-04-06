'use client'

import { PeraWalletConnect } from '@perawallet/connect'
import algosdk from 'algosdk'
import { useEffect, useMemo, useState } from 'react'
import { algod, appId, assets, encodeU64, getAppAddress } from '../lib/algorand'

const pera = new PeraWalletConnect({ chainId: 416002 })

type PoolState = {
  reserveA: number
  reserveB: number
  reserveC: number
  feeBps: number
}

function pickReserve(pool: PoolState, assetId: number) {
  if (assetId === assets[0].id) return pool.reserveA
  if (assetId === assets[1].id) return pool.reserveB
  return pool.reserveC
}

function quoteLocal(pool: PoolState, inId: number, outId: number, amountIn: number) {
  if (amountIn <= 0) return 0
  const reserveIn = pickReserve(pool, inId)
  const reserveOut = pickReserve(pool, outId)
  if (reserveIn <= 0 || reserveOut <= 0) return 0
  const amountInAfterFee = Math.floor((amountIn * (10000 - pool.feeBps)) / 10000)
  const newReserveIn = reserveIn + amountInAfterFee
  const k = reserveIn * reserveOut
  const newReserveOut = Math.floor(k / newReserveIn)
  return reserveOut - newReserveOut
}

export default function SwapPage() {
  const [account, setAccount] = useState<string>('')
  const [pool, setPool] = useState<PoolState>({ reserveA: 0, reserveB: 0, reserveC: 0, feeBps: 30 })
  const [assetInId, setAssetInId] = useState<number>(assets[0].id)
  const [assetOutId, setAssetOutId] = useState<number>(assets[1].id)
  const [amountIn, setAmountIn] = useState<number>(10)
  const [slippageBps, setSlippageBps] = useState<number>(100)
  const [status, setStatus] = useState<string>('')

  const estimateOut = useMemo(() => quoteLocal(pool, assetInId, assetOutId, amountIn), [pool, assetInId, assetOutId, amountIn])
  const reserveIn = useMemo(() => pickReserve(pool, assetInId), [pool, assetInId])
  const reserveOut = useMemo(() => pickReserve(pool, assetOutId), [pool, assetOutId])
  const spotPrice = reserveIn > 0 ? reserveOut / reserveIn : 0
  const executionPrice = amountIn > 0 ? estimateOut / amountIn : 0
  const priceImpactPct = spotPrice > 0 ? Math.max(0, ((spotPrice - executionPrice) / spotPrice) * 100) : 0

  async function loadPool() {
    if (!appId) return
    const app = await algod.getApplicationByID(appId).do()
    const gs = app.params.globalState ?? []
    const byKey = (key: string) =>
      Number(gs.find((x: any) => Buffer.from(x.key, 'base64').toString('utf8') === key)?.value?.uint ?? 0)

    setPool({
      reserveA: byKey('reserveA'),
      reserveB: byKey('reserveB'),
      reserveC: byKey('reserveC'),
      feeBps: byKey('feeBps') || 30,
    })
  }

  async function connect() {
    const [addr] = await pera.connect()
    setAccount(addr)
  }

  async function swap() {
    if (!account) throw new Error('Connect wallet first')
    if (!amountIn || amountIn <= 0) throw new Error('Enter valid amount')
    if (assetInId === assetOutId) throw new Error('Choose different assets')

    const appAddress = getAppAddress()
    const sp = await algod.getTransactionParams().do()
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
      sender: account,
      receiver: appAddress,
      amount: amountIn,
      assetIndex: assetInId,
      suggestedParams: sp,
    })

    const minAmountOut = Math.floor(estimateOut * (1 - slippageBps / 10000))

    const tx1 = algosdk.makeApplicationNoOpTxnFromObject({
      sender: account,
      appIndex: BigInt(appId),
      appArgs: [swapMethod.getSelector(), encodeU64(assetInId), encodeU64(amountIn), encodeU64(minAmountOut)],
      foreignAssets: [assetOutId],
      suggestedParams: { ...sp, fee: 2000n },
    })

    algosdk.assignGroupID([tx0, tx1])

    const txGroup = [
      { txn: tx0, signers: [account] },
      { txn: tx1, signers: [account] },
    ]

    setStatus('Signing with Pera Wallet...')
    const signed = await pera.signTransaction([txGroup])

    setStatus('Submitting grouped swap transaction...')
    const { txid } = await algod.sendRawTransaction(signed).do()
    await algosdk.waitForConfirmation(algod, txid, 4)

    setStatus(`Swap confirmed: ${txid}`)
    await loadPool()
  }

  useEffect(() => {
    loadPool().catch((e) => setStatus(e.message))
  }, [])

  useEffect(() => {
    if (assetInId === assetOutId) {
      const fallback = assets.find((a) => a.id !== assetInId)
      if (fallback) setAssetOutId(fallback.id)
    }
  }, [assetInId, assetOutId])

  const pricePreview = estimateOut > 0 ? (estimateOut / Math.max(amountIn, 1)).toFixed(6) : '0'

  return (
    <main>
      <h1>Tri-Asset AMM (TestNet)</h1>
      <p>Unified pool for Asset A / Asset B / Asset C with exact-input swaps.</p>
      <p>This is a simplified 3-asset AMM: pairwise pricing with global invariant validation.</p>

      <div className="card">
        <div className="grid">
          <button onClick={connect}>{account ? `Connected: ${account.slice(0, 8)}...` : 'Connect Pera Wallet'}</button>
          <button className="secondary" onClick={loadPool}>Refresh Pool</button>
        </div>
      </div>

      <div className="card">
        <h3>Swap</h3>
        <div className="grid">
          <div>
            <label>Input Asset</label>
            <select value={assetInId} onChange={(e) => setAssetInId(Number(e.target.value))}>
              {assets.map((a) => (
                <option key={a.id} value={a.id}>{a.symbol} ({a.id})</option>
              ))}
            </select>
          </div>
          <div>
            <label>Output Asset</label>
            <select value={assetOutId} onChange={(e) => setAssetOutId(Number(e.target.value))}>
              {assets.filter((a) => a.id !== assetInId).map((a) => (
                <option key={a.id} value={a.id}>{a.symbol} ({a.id})</option>
              ))}
            </select>
          </div>
          <div>
            <label>Amount In</label>
            <input type="number" min={1} value={amountIn} onChange={(e) => setAmountIn(Number(e.target.value))} />
          </div>
          <div>
            <label>Slippage (bps)</label>
            <input type="number" min={1} value={slippageBps} onChange={(e) => setSlippageBps(Number(e.target.value))} />
          </div>
        </div>

        <p>Estimated Output: <b>{estimateOut}</b></p>
        <p>Price Preview: 1 in ≈ {pricePreview} out</p>
        <p>Estimated Price Impact: {priceImpactPct.toFixed(2)}%</p>
        <div className="warning">Swaps are rounded down. Execution fails if output is below minimum after slippage protection.</div>
        {priceImpactPct > 1 && <div className="warning">Price impact warning: this trade meaningfully moves pool price.</div>}

        <div style={{ marginTop: 14 }}>
          <button onClick={() => swap().catch((e) => setStatus(e.message))}>Swap Exact In</button>
        </div>
      </div>

      <div className="card">
        <h3>Pool Reserves</h3>
        <p>Asset A ({assets[0].id}): {pool.reserveA}</p>
        <p>Asset B ({assets[1].id}): {pool.reserveB}</p>
        <p>Asset C ({assets[2].id}): {pool.reserveC}</p>
        <p>feeBps: {pool.feeBps}</p>
      </div>

      {status && <div className="card"><b>Status:</b> {status}</div>}
    </main>
  )
}
