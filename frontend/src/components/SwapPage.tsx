'use client'

import { useWallet, Wallet, WalletId } from '@txnlab/use-wallet-react'
import algosdk from 'algosdk'
import { useEffect, useMemo, useState } from 'react'
import { algod, appId, assets, encodeU64, getAppAddress } from '../lib/algorand'

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
  if (inId === outId) return 0
  const reserveIn = pickReserve(pool, inId)
  const reserveOut = pickReserve(pool, outId)
  const third = [assets[0].id, assets[1].id, assets[2].id].find((id) => id !== inId && id !== outId)
  if (!third) return 0
  const reserveThird = pickReserve(pool, third)
  if (reserveIn <= 0 || reserveOut <= 0 || reserveThird <= 0) return 0

  const q = quoteLocalDetailed(reserveIn, reserveOut, reserveThird, amountIn)
  return q.amountOut
}

function quoteLocalDetailed(reserveInN: number, reserveOutN: number, reserveThirdN: number, amountInN: number) {
  const reserveIn = BigInt(Math.floor(reserveInN))
  const reserveOut = BigInt(Math.floor(reserveOutN))
  const reserveThird = BigInt(Math.floor(reserveThirdN))
  const amountIn = BigInt(Math.floor(amountInN))
  const scale = 10_000n

  const result = {
    amountOut: 0,
    feeBps: 0,
    dominanceBps: 0,
    couplingAdjustment: 0,
  }

  if (reserveIn <= 0n || reserveOut <= 0n || reserveThird <= 1n || amountIn <= 0n) return result
  if (reserveIn < 20n || amountIn > reserveIn / 20n) return result

  const sq = (x: bigint) => x * x
  const inv = sq(reserveIn) + sq(reserveOut) + sq(reserveThird)
  const maxSq = [sq(reserveIn), sq(reserveOut), sq(reserveThird)].reduce((a, b) => (a > b ? a : b), 0n)
  const dom = Number((maxSq * scale) / inv)
  if (dom > 6400) return result

  let fee = 30
  if (dom > 3400) fee = Math.min(100, 30 + Math.floor(((dom - 3400) * 70) / 3000))
  const amountInAfterFee = (amountIn * BigInt(10_000 - fee)) / scale
  if (amountInAfterFee <= 0n) return result

  const newReserveIn = reserveIn + amountInAfterFee
  let base = (reserveThird * amountInAfterFee) / (reserveIn * 20n)
  if (base <= 0n) base = 1n
  let deltaThird = (base * (10_000n + BigInt(dom))) / scale
  if (deltaThird <= 0n) deltaThird = 1n
  if (deltaThird >= reserveThird) deltaThird = reserveThird - 1n
  const newReserveThird = reserveThird - deltaThird

  const targetOutSq = inv - sq(newReserveIn) - sq(newReserveThird)
  if (targetOutSq <= 0n) return result

  const sqrtFloor = (n: bigint) => {
    if (n < 2n) return n
    let x0 = n
    let x1 = (x0 + n / x0) / 2n
    while (x1 < x0) {
      x0 = x1
      x1 = (x0 + n / x0) / 2n
    }
    return x0
  }
  const newReserveOut = sqrtFloor(targetOutSq)
  if (newReserveOut > reserveOut) return result

  return {
    amountOut: Number(reserveOut - newReserveOut),
    feeBps: fee,
    dominanceBps: dom,
    couplingAdjustment: Number(deltaThird),
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function senderFromSignedTxn(stxn: Uint8Array) {
  const decoded = algosdk.decodeSignedTransaction(stxn)
  const sender = decoded.txn.sender
  return typeof sender === 'string' ? sender : algosdk.encodeAddress(sender.publicKey)
}

function toNumber(value: unknown): number {
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number(value)
  return 0
}

function readAssetId(asset: any): number {
  return toNumber(asset?.assetId ?? asset?.['asset-id'])
}

function readAssetAmount(asset: any): number {
  return toNumber(asset?.amount)
}

export default function SwapPage() {
  const {
    wallets,
    activeWallet,
    activeAddress,
    isReady,
    signTransactions,
  } = useWallet()

  const [pool, setPool] = useState<PoolState>({ reserveA: 0, reserveB: 0, reserveC: 0, feeBps: 30 })
  const [assetInId, setAssetInId] = useState<number>(assets[0].id)
  const [assetOutId, setAssetOutId] = useState<number>(assets[1].id)
  const [amountIn, setAmountIn] = useState<number>(10)
  const [slippageBps, setSlippageBps] = useState<number>(100)
  const [selectedWalletId, setSelectedWalletId] = useState<string>('')
  const [optedAssetIds, setOptedAssetIds] = useState<number[]>([])
  const [walletAssetBalances, setWalletAssetBalances] = useState<Record<number, number>>({})
  const [lastSigningAddress, setLastSigningAddress] = useState<string>('')
  const [status, setStatus] = useState<string>('')
  const [mounted, setMounted] = useState(false)
  const [fundAmount, setFundAmount] = useState<number>(10)
  const [fundingAssetId, setFundingAssetId] = useState<number | null>(null)

  const preferredWalletOrder = [WalletId.LUTE, WalletId.PERA, WalletId.DEFLY, WalletId.EXODUS]

  const sortedWallets = useMemo(() => {
    return [...wallets].sort((left, right) => {
      const li = preferredWalletOrder.indexOf(left.id)
      const ri = preferredWalletOrder.indexOf(right.id)
      const leftRank = li === -1 ? 99 : li
      const rightRank = ri === -1 ? 99 : ri
      return leftRank - rightRank
    })
  }, [wallets])

  const configuredAssets = useMemo(() => assets.filter((asset) => asset.id > 0), [])
  const hasConfigError = !appId || configuredAssets.length !== 3
  const configErrorMessage =
    'Missing frontend env config. Set NEXT_PUBLIC_AMM_APP_ID and NEXT_PUBLIC_ASSET_A_ID/B_ID/C_ID in Vercel.'

  const estimateOut = useMemo(() => quoteLocal(pool, assetInId, assetOutId, amountIn), [pool, assetInId, assetOutId, amountIn])
  const thirdAssetId = useMemo(() => [assets[0].id, assets[1].id, assets[2].id].find((id) => id !== assetInId && id !== assetOutId) ?? 0, [assetInId, assetOutId])
  const quoteDetails = useMemo(() => {
    const reserveInLocal = pickReserve(pool, assetInId)
    const reserveOutLocal = pickReserve(pool, assetOutId)
    const reserveThirdLocal = thirdAssetId ? pickReserve(pool, thirdAssetId) : 0
    return quoteLocalDetailed(reserveInLocal, reserveOutLocal, reserveThirdLocal, amountIn)
  }, [pool, assetInId, assetOutId, thirdAssetId, amountIn])
  const hydratedAddress = mounted ? activeAddress : null
  const hydratedWallets = mounted ? sortedWallets : []
  const reserveIn = useMemo(() => pickReserve(pool, assetInId), [pool, assetInId])
  const reserveOut = useMemo(() => pickReserve(pool, assetOutId), [pool, assetOutId])
  const spotPrice = reserveIn > 0 ? reserveOut / reserveIn : 0
  const executionPrice = amountIn > 0 ? estimateOut / amountIn : 0
  const priceImpactPct = spotPrice > 0 ? Math.max(0, ((spotPrice - executionPrice) / spotPrice) * 100) : 0
  const allSq = useMemo(() => [pool.reserveA * pool.reserveA, pool.reserveB * pool.reserveB, pool.reserveC * pool.reserveC], [pool])
  const invariantNow = useMemo(() => allSq[0] + allSq[1] + allSq[2], [allSq])
  const dominanceNowBps = useMemo(() => (invariantNow > 0 ? Math.floor((Math.max(allSq[0], allSq[1], allSq[2]) * 10000) / invariantNow) : 0), [allSq, invariantNow])
  const isImbalanced = dominanceNowBps >= 5800
  const missingOptIns = useMemo(
    () => configuredAssets.filter((asset) => !optedAssetIds.includes(asset.id)),
    [configuredAssets, optedAssetIds],
  )
  const inputAssetBalance = walletAssetBalances[assetInId] ?? 0

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

  async function loadWalletAssetOptIns() {
    if (!activeAddress) {
      setOptedAssetIds([])
      setWalletAssetBalances({})
      return
    }

    const accountInfo = await algod.accountInformation(activeAddress).do()
    const accountAssets = accountInfo.assets ?? []
    const accountAssetIds = accountAssets.map((asset: any) => readAssetId(asset)).filter((id: number) => id > 0)
    const balancesByAsset = accountAssets.reduce((acc: Record<number, number>, asset: any) => {
      const assetId = readAssetId(asset)
      if (assetId > 0) acc[assetId] = readAssetAmount(asset)
      return acc
    }, {})

    setWalletAssetBalances(balancesByAsset)
    setOptedAssetIds(accountAssetIds)
  }

  async function waitForWalletOptIns(address: string, requiredAssetIds: number[]) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const accountInfo = await algod.accountInformation(address).do()
      const accountAssetIds = new Set((accountInfo.assets ?? []).map((asset: any) => readAssetId(asset)).filter((id: number) => id > 0))
      const stillMissing = requiredAssetIds.filter((assetId) => !accountAssetIds.has(assetId))
      if (stillMissing.length === 0) return
      await sleep(700)
    }
  }

  async function connect() {
    if (!isReady) throw new Error('Wallet providers are still loading')

    const chosenWallet =
      sortedWallets.find((wallet) => wallet.id === selectedWalletId) ??
      sortedWallets.find((wallet) => wallet.id === WalletId.LUTE) ??
      sortedWallets.find((wallet) => wallet.id === WalletId.PERA) ??
      sortedWallets[0]

    if (!chosenWallet) throw new Error('No compatible wallet providers found')

    await chosenWallet.connect()
    setStatus(`Connected via ${chosenWallet.metadata.name}`)
  }

  async function disconnect() {
    if (!activeWallet) return
    await activeWallet.disconnect()
    setStatus('Disconnected wallet')
  }

  async function optInMissingAssets() {
    if (hasConfigError) throw new Error(configErrorMessage)
    if (!activeAddress) throw new Error('Connect wallet first')
    if (missingOptIns.length === 0) {
      setStatus('All pool assets already opted in')
      return
    }

    const sp = await algod.getTransactionParams().do()
    const optInTxns = missingOptIns.map((asset) =>
      algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: activeAddress,
        receiver: activeAddress,
        amount: 0,
        assetIndex: asset.id,
        suggestedParams: sp,
      }),
    )

    algosdk.assignGroupID(optInTxns)
    const encoded = optInTxns.map((txn) => algosdk.encodeUnsignedTransaction(txn))

    const signerAddress = activeAddress

    setStatus(`Signing opt-in transactions for ${signerAddress}...`)
    const signed = await signTransactions(encoded)
    const signedGroup = signed.filter((stxn): stxn is Uint8Array => stxn !== null)
    if (signedGroup.length !== optInTxns.length) throw new Error('Wallet did not sign all opt-in transactions')

    for (const signedTxn of signedGroup) {
      const sender = senderFromSignedTxn(signedTxn)
      setLastSigningAddress(sender)
      if (sender !== signerAddress) {
        throw new Error(`Connected address ${signerAddress} differs from signing address ${sender}. Switch wallet account and retry.`)
      }
    }

    setStatus(`Submitting opt-ins for ${signerAddress}...`)
    const { txid } = await algod.sendRawTransaction(signedGroup).do()
    await algosdk.waitForConfirmation(algod, txid, 4)

    setStatus(`Asset opt-ins confirmed for ${signerAddress}: ${txid}`)
    await waitForWalletOptIns(signerAddress, configuredAssets.map((asset) => asset.id))
    await loadWalletAssetOptIns()

    const postInfo = await algod.accountInformation(signerAddress).do()
    const postAssetIds = new Set((postInfo.assets ?? []).map((asset: any) => readAssetId(asset)).filter((id: number) => id > 0))
    const stillMissing = configuredAssets.filter((asset) => !postAssetIds.has(asset.id))
    if (stillMissing.length > 0) {
      throw new Error(
        `Opt-in was processed for ${signerAddress}, but still missing IDs: ${stillMissing.map((a) => a.id).join(', ')}`,
      )
    }

    setStatus(`All pool asset opt-ins verified for ${signerAddress}`)
  }

  async function swap() {
    if (hasConfigError) throw new Error(configErrorMessage)
    if (!activeAddress) throw new Error('Connect wallet first')
    const signerAddress = activeAddress
    if (!amountIn || amountIn <= 0) throw new Error('Enter valid amount')
    if (assetInId === assetOutId) throw new Error('Choose different assets')
    if (missingOptIns.length > 0) throw new Error('Opt in missing pool assets before swapping')
    if (inputAssetBalance < amountIn) {
      throw new Error(`Insufficient input asset balance: have ${inputAssetBalance}, need ${amountIn}`)
    }

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
      sender: signerAddress,
      receiver: appAddress,
      amount: amountIn,
      assetIndex: assetInId,
      suggestedParams: sp,
    })

    const minAmountOut = Math.floor(estimateOut * (1 - slippageBps / 10000))

    const tx1 = algosdk.makeApplicationNoOpTxnFromObject({
      sender: signerAddress,
      appIndex: BigInt(appId),
      appArgs: [swapMethod.getSelector(), encodeU64(assetInId), encodeU64(amountIn), encodeU64(minAmountOut)],
      foreignAssets: [assetOutId],
      suggestedParams: { ...sp, fee: 5000n, flatFee: true },
    })

    algosdk.assignGroupID([tx0, tx1])

    const encodedGroup = [algosdk.encodeUnsignedTransaction(tx0), algosdk.encodeUnsignedTransaction(tx1)]

    setStatus('Signing with selected wallet...')
    const signed = await signTransactions(encodedGroup)
    const signedGroup = signed.filter((stxn): stxn is Uint8Array => stxn !== null)
    if (signedGroup.length !== 2) throw new Error('Wallet did not sign full transaction group')

    for (const signedTxn of signedGroup) {
      const sender = senderFromSignedTxn(signedTxn)
      setLastSigningAddress(sender)
      if (sender !== signerAddress) {
        throw new Error(`Connected address ${signerAddress} differs from signing address ${sender}. Switch wallet account and retry.`)
      }
    }

    setStatus('Submitting grouped swap transaction...')
    const { txid } = await algod.sendRawTransaction(signedGroup).do()
    await algosdk.waitForConfirmation(algod, txid, 4)

    setStatus(`Swap confirmed: ${txid}`)
    await loadPool()
  }

  async function fundConnectedWallet(assetId: number) {
    if (!activeAddress) throw new Error('Connect wallet first')
    if (!Number.isInteger(fundAmount) || fundAmount <= 0) throw new Error('Fund amount must be a positive integer')

    setFundingAssetId(assetId)
    try {
      setStatus(`Funding wallet with asset ${assetId}...`)

      const response = await fetch('/api/faucet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receiver: activeAddress,
          assetId,
          amount: fundAmount,
        }),
      })

      const payload = (await response.json()) as { txid?: string; error?: string }
      if (!response.ok) {
        throw new Error(payload.error ?? 'Faucet transfer failed')
      }

      setStatus(`Funded ${fundAmount} units of ${assetId}. Tx: ${payload.txid}`)
      await loadWalletAssetOptIns()
    } finally {
      setFundingAssetId(null)
    }
  }

  useEffect(() => {
    loadPool().catch((e) => setStatus(e.message))
  }, [])

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    loadWalletAssetOptIns().catch((e) => setStatus(e.message))
  }, [activeAddress])

  useEffect(() => {
    if (assetInId === assetOutId) {
      const fallback = configuredAssets.find((a) => a.id !== assetInId)
      if (fallback) setAssetOutId(fallback.id)
    }
  }, [assetInId, assetOutId, configuredAssets])

  const pricePreview = estimateOut > 0 ? (estimateOut / Math.max(amountIn, 1)).toFixed(6) : '0'

  return (
    <main>
      <h1>Tri-Asset AMM (TestNet)</h1>
      <p>Orbital-inspired geometric AMM</p>
      <p>Dynamic 3-asset coupling enabled</p>
      <p>Invariant: A² + B² + C²</p>

      <div className="card">
        {hasConfigError && <div className="warning">{configErrorMessage}</div>}
        <div className="grid">
          <select value={selectedWalletId} onChange={(e) => setSelectedWalletId(e.target.value)}>
            <option value="">Auto (Lute → Pera → others)</option>
            {hydratedWallets.map((wallet: Wallet) => (
              <option key={wallet.id} value={wallet.id}>{wallet.metadata.name}</option>
            ))}
          </select>
          <button onClick={() => connect().catch((e) => setStatus(e.message))}>
            {hydratedAddress ? `Connected: ${hydratedAddress.slice(0, 8)}...` : 'Connect Wallet'}
          </button>
          <button className="secondary" onClick={() => disconnect().catch((e) => setStatus(e.message))}>Disconnect</button>
          <button className="secondary" onClick={() => optInMissingAssets().catch((e) => setStatus(e.message))}>
            {missingOptIns.length > 0 ? `Opt-in missing assets (${missingOptIns.length})` : 'All assets opted in'}
          </button>
          <button className="secondary" onClick={loadPool}>Refresh Pool</button>
        </div>
        <div className="grid" style={{ marginTop: 10 }}>
          <input
            type="number"
            min={1}
            value={fundAmount}
            onChange={(e) => setFundAmount(Number(e.target.value))}
            placeholder="Fund amount"
          />
          {configuredAssets.map((asset) => (
            <button
              key={`fund-${asset.id}`}
              className="secondary"
              onClick={() => fundConnectedWallet(asset.id).catch((e) => setStatus(e.message))}
              disabled={fundingAssetId === asset.id}
            >
              {fundingAssetId === asset.id ? `Funding ${asset.symbol}...` : `Fund ${asset.symbol}`}
            </button>
          ))}
        </div>
        {hydratedAddress && (
          <div style={{ marginTop: 10 }}>
            Input asset wallet balance: <b>{inputAssetBalance}</b>
          </div>
        )}
        {hydratedAddress && missingOptIns.length > 0 && (
          <div className="warning" style={{ marginTop: 10 }}>
            Wallet must opt in to pool ASAs before swapping. Missing IDs: {missingOptIns.map((asset) => asset.id).join(', ')}
          </div>
        )}
      </div>

      <div className="card">
        <h3>Swap</h3>
        <div className="grid">
          <div>
            <label>Input Asset</label>
            <select value={assetInId} onChange={(e) => setAssetInId(Number(e.target.value))}>
              {configuredAssets.map((a) => (
                <option key={a.id} value={a.id}>{a.symbol} ({a.id})</option>
              ))}
            </select>
          </div>
          <div>
            <label>Output Asset</label>
            <select value={assetOutId} onChange={(e) => setAssetOutId(Number(e.target.value))}>
              {configuredAssets.filter((a) => a.id !== assetInId).map((a) => (
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
        <p>Effective Fee (dynamic): {quoteDetails.feeBps} bps</p>
        <p>Third Reserve Adjustment (est): {quoteDetails.couplingAdjustment}</p>
        <div className="warning">Swaps are rounded down. Execution fails if output is below minimum after slippage protection.</div>
        {isImbalanced && <div className="warning">Imbalance warning: reserve dominance is high ({(dominanceNowBps / 100).toFixed(2)}%).</div>}
        {priceImpactPct >= 2.5 && <div className="warning">Price impact warning: this trade meaningfully moves pool price.</div>}

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
        <p>Reserve Health: {dominanceNowBps <= 5800 ? 'Healthy' : 'Stressed'} ({(dominanceNowBps / 100).toFixed(2)}% dominance)</p>
      </div>

      <div className="card">
        <h3>Wallet Debug</h3>
        <p>Connected address: {hydratedAddress || 'Not connected'}</p>
        <p>Active wallet: {activeWallet ? `${activeWallet.metadata.name} (${activeWallet.id})` : 'None'}</p>
        <p>Last signing address: {lastSigningAddress || 'No signatures yet'}</p>
        <p>Opted pool assets: {optedAssetIds.length > 0 ? optedAssetIds.join(', ') : 'None'}</p>
        <p>
          Pool balances in wallet:{' '}
          {assets
            .map((asset) => `${asset.id}:${walletAssetBalances[asset.id] ?? 0}`)
            .join(' | ')}
        </p>
      </div>

      {status && <div className="card"><b>Status:</b> {status}</div>}
    </main>
  )
}
