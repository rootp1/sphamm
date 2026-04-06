import type { uint64 } from '@algorandfoundation/algorand-typescript'
import {
  Account,
  assert,
  Contract,
  Global,
  GlobalState,
  gtxn,
  itxn,
  Txn,
} from '@algorandfoundation/algorand-typescript'

export class TriAssetAmm extends Contract {
  assetAId = GlobalState<uint64>()
  assetBId = GlobalState<uint64>()
  assetCId = GlobalState<uint64>()

  reserveA = GlobalState<uint64>()
  reserveB = GlobalState<uint64>()
  reserveC = GlobalState<uint64>()

  feeBps = GlobalState<uint64>()
  admin = GlobalState<Account>()
  paused = GlobalState<boolean>()
  totalLiquidity = GlobalState<uint64>()

  public createApplication(): void {
    this.assetAId.value = 0
    this.assetBId.value = 0
    this.assetCId.value = 0

    this.reserveA.value = 0
    this.reserveB.value = 0
    this.reserveC.value = 0

    this.feeBps.value = 0
    this.admin.value = Txn.sender
    this.paused.value = false
    this.totalLiquidity.value = 0
  }

  public create_pool(
    assetA: uint64,
    assetB: uint64,
    assetC: uint64,
    amountA: uint64,
    amountB: uint64,
    amountC: uint64,
    feeBps: uint64,
  ): void {
    assert(this.assetAId.value === 0, 'pool already initialized')
    assert(assetA > 0 && assetB > 0 && assetC > 0, 'invalid asset ids')
    assert(assetA !== assetB && assetA !== assetC && assetB !== assetC, 'duplicate assets')
    assert(amountA > 0 && amountB > 0 && amountC > 0, 'invalid initial amounts')
    assert(feeBps <= 1000, 'fee too high')

    assert(Global.groupSize === 4, 'invalid group size')

    const tx0 = gtxn.AssetTransferTxn(0)
    const tx1 = gtxn.AssetTransferTxn(1)
    const tx2 = gtxn.AssetTransferTxn(2)

    assert(tx0.sender === Txn.sender && tx1.sender === Txn.sender && tx2.sender === Txn.sender, 'sender mismatch')
    assert(tx0.assetReceiver === Global.currentApplicationAddress, 'a receiver invalid')
    assert(tx1.assetReceiver === Global.currentApplicationAddress, 'b receiver invalid')
    assert(tx2.assetReceiver === Global.currentApplicationAddress, 'c receiver invalid')

    assert(tx0.xferAsset.id === assetA && tx0.assetAmount === amountA, 'asset A funding mismatch')
    assert(tx1.xferAsset.id === assetB && tx1.assetAmount === amountB, 'asset B funding mismatch')
    assert(tx2.xferAsset.id === assetC && tx2.assetAmount === amountC, 'asset C funding mismatch')

    this.assetAId.value = assetA
    this.assetBId.value = assetB
    this.assetCId.value = assetC

    this.reserveA.value = amountA
    this.reserveB.value = amountB
    this.reserveC.value = amountC

    this.feeBps.value = feeBps
    this.admin.value = Txn.sender
    this.paused.value = false

    const liqPartial: uint64 = amountA + amountB
    assert(liqPartial >= amountA && liqPartial >= amountB, 'liquidity overflow')
    const liqTotal: uint64 = liqPartial + amountC
    assert(liqTotal >= liqPartial, 'liquidity overflow')
    this.totalLiquidity.value = liqTotal
  }

  public quote_swap_exact_in(assetInId: uint64, amountIn: uint64): uint64 {
    assert(this.assetAId.value > 0, 'pool not initialized')
    assert(amountIn > 0, 'amountIn must be positive')
    assert(Txn.numAssets >= 1, 'missing output asset')

    const assetOutId = Txn.assets(0).id
    assert(assetOutId !== assetInId, 'same asset pair invalid')

    const amountInAfterFee = this.applyFee(amountIn)
    const reserveIn = this.getReserveByAssetId(assetInId)
    const reserveOut = this.getReserveByAssetId(assetOutId)

    return this.computeAmountOut(reserveIn, reserveOut, amountInAfterFee)
  }

  public swap_exact_in(assetInId: uint64, amountIn: uint64, minAmountOut: uint64): uint64 {
    assert(this.assetAId.value > 0, 'pool not initialized')
    assert(!this.paused.value, 'pool paused')
    assert(this.reserveA.value > 0 && this.reserveB.value > 0 && this.reserveC.value > 0, 'pool assets not active')

    assert(Global.groupSize === 2, 'group size must be 2')
    const transfer = gtxn.AssetTransferTxn(0)

    assert(transfer.sender === Txn.sender, 'sender mismatch')
    assert(transfer.assetReceiver === Global.currentApplicationAddress, 'receiver must be app')
    assert(transfer.xferAsset.id === assetInId, 'assetIn mismatch')
    assert(transfer.assetAmount === amountIn, 'amount mismatch')
    assert(amountIn > 0, 'amountIn must be positive')
    assert(Txn.numAssets >= 1, 'missing output asset in foreign assets')

    const assetOutId = Txn.assets(0).id
    assert(this.isPoolAsset(assetInId), 'assetIn unsupported')
    assert(this.isPoolAsset(assetOutId), 'assetOut unsupported')
    assert(assetOutId !== assetInId, 'output asset must differ')

    const kBefore = this.computeGlobalK(this.reserveA.value, this.reserveB.value, this.reserveC.value)

    const amountInAfterFee = this.applyFee(amountIn)
    const reserveIn = this.getReserveByAssetId(assetInId)
    const reserveOut = this.getReserveByAssetId(assetOutId)

    const amountOut = this.computeAmountOut(reserveIn, reserveOut, amountInAfterFee)

    assert(amountOut >= minAmountOut, 'slippage exceeded')
    assert(amountOut > 0, 'amountOut zero')
    assert(amountOut < reserveOut, 'output would drain reserve')
    assert(reserveOut > amountOut, 'reserve underflow')

    const newReserveIn: uint64 = reserveIn + amountIn
    const newReserveOut: uint64 = reserveOut - amountOut
    const [simA, simB, simC] = this.mapReservesAfterSwap(assetInId, assetOutId, newReserveIn, newReserveOut)
    const kAfter = this.computeGlobalK(simA, simB, simC)

    assert(kAfter >= kBefore || kBefore - kAfter <= 1, 'global invariant violated')

    this.setReserveByAssetId(assetInId, newReserveIn)
    this.setReserveByAssetId(assetOutId, newReserveOut)

    itxn
      .assetTransfer({
        xferAsset: assetOutId,
        assetReceiver: Txn.sender,
        assetAmount: amountOut,
        fee: 0,
      })
      .submit()

    return amountOut
  }

  public get_pool_state(): [uint64, uint64, uint64, uint64, uint64, uint64, uint64] {
    return [
      this.assetAId.value,
      this.assetBId.value,
      this.assetCId.value,
      this.reserveA.value,
      this.reserveB.value,
      this.reserveC.value,
      this.feeBps.value,
    ]
  }

  public opt_in_asset(assetId: uint64): void {
    assert(Txn.sender === this.admin.value, 'admin only')
    assert(assetId > 0, 'invalid asset id')

    itxn
      .assetTransfer({
        xferAsset: assetId,
        assetReceiver: Global.currentApplicationAddress,
        assetAmount: 0,
        fee: 0,
      })
      .submit()
  }

  public pause(): void {
    assert(Txn.sender === this.admin.value, 'admin only')
    this.paused.value = true
  }

  public unpause(): void {
    assert(Txn.sender === this.admin.value, 'admin only')
    this.paused.value = false
  }

  private applyFee(amountIn: uint64): uint64 {
    const feeFactor: uint64 = 10_000 - this.feeBps.value
    return (amountIn * feeFactor) / 10_000
  }

  private computeAmountOut(reserveIn: uint64, reserveOut: uint64, amountInAfterFee: uint64): uint64 {
    assert(reserveIn > 0 && reserveOut > 0, 'empty reserves')
    const newReserveIn: uint64 = reserveIn + amountInAfterFee
    const k: uint64 = reserveIn * reserveOut
    const newReserveOut: uint64 = k / newReserveIn
    const amountOut: uint64 = reserveOut - newReserveOut
    return amountOut
  }

  private computeGlobalK(reserveA: uint64, reserveB: uint64, reserveC: uint64): uint64 {
    const ab: uint64 = reserveA * reserveB
    assert(reserveB === 0 || ab / reserveB === reserveA, 'k overflow')

    const abc: uint64 = ab * reserveC
    assert(reserveC === 0 || abc / reserveC === ab, 'k overflow')

    return abc
  }

  private mapReservesAfterSwap(
    assetInId: uint64,
    assetOutId: uint64,
    newReserveIn: uint64,
    newReserveOut: uint64,
  ): [uint64, uint64, uint64] {
    let nextA: uint64 = this.reserveA.value
    let nextB: uint64 = this.reserveB.value
    let nextC: uint64 = this.reserveC.value

    if (assetInId === this.assetAId.value) nextA = newReserveIn
    if (assetInId === this.assetBId.value) nextB = newReserveIn
    if (assetInId === this.assetCId.value) nextC = newReserveIn

    if (assetOutId === this.assetAId.value) nextA = newReserveOut
    if (assetOutId === this.assetBId.value) nextB = newReserveOut
    if (assetOutId === this.assetCId.value) nextC = newReserveOut

    return [nextA, nextB, nextC]
  }

  private getReserveByAssetId(assetId: uint64): uint64 {
    assert(this.isPoolAsset(assetId), 'unsupported asset')
    if (assetId === this.assetAId.value) return this.reserveA.value
    if (assetId === this.assetBId.value) return this.reserveB.value
    return this.reserveC.value
  }

  private setReserveByAssetId(assetId: uint64, value: uint64): void {
    assert(this.isPoolAsset(assetId), 'unsupported asset')
    if (assetId === this.assetAId.value) {
      this.reserveA.value = value
      return
    }
    if (assetId === this.assetBId.value) {
      this.reserveB.value = value
      return
    }
    this.reserveC.value = value
  }

  private isPoolAsset(assetId: uint64): boolean {
    return assetId === this.assetAId.value || assetId === this.assetBId.value || assetId === this.assetCId.value
  }
}
