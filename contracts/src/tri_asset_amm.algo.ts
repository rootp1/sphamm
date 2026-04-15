import type { uint64 } from '@algorandfoundation/algorand-typescript'
import {
  Account,
  assert,
  Contract,
  Global,
  GlobalState,
  gtxn,
  itxn,
  op,
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
    assert(this.reserveA.value > 0 && this.reserveB.value > 0 && this.reserveC.value > 0, 'pool assets not active')
    assert(amountIn > 0, 'amountIn must be positive')
    assert(Txn.numAssets >= 1, 'missing output asset')

    const assetOutId = Txn.assets(0).id
    assert(this.isPoolAsset(assetInId), 'assetIn unsupported')
    assert(this.isPoolAsset(assetOutId), 'assetOut unsupported')
    assert(assetOutId !== assetInId, 'same asset pair invalid')

    const amountInAfterFee = this.applyFee(amountIn)
    const reserveIn = this.getReserveByAssetId(assetInId)
    const reserveOut = this.getReserveByAssetId(assetOutId)
    const reserveThird = this.getThirdReserveByAssetIds(assetInId, assetOutId)
    const [amountOut] = this.solveOrbitalSwap(reserveIn, reserveOut, reserveThird, amountInAfterFee)
    return amountOut
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

    const amountInAfterFee = this.applyFee(amountIn)
    const reserveIn = this.getReserveByAssetId(assetInId)
    const reserveOut = this.getReserveByAssetId(assetOutId)
    const reserveThird = this.getThirdReserveByAssetIds(assetInId, assetOutId)

    const [amountOut, newReserveIn, newReserveOut] = this.solveOrbitalSwap(
      reserveIn,
      reserveOut,
      reserveThird,
      amountInAfterFee,
    )

    assert(amountOut >= minAmountOut, 'slippage exceeded')
    assert(amountOut > 0, 'amountOut zero')
    assert(amountOut < reserveOut, 'output would drain reserve')
    assert(reserveOut >= amountOut, 'reserve underflow')

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

  private solveOrbitalSwap(
    reserveIn: uint64,
    reserveOut: uint64,
    reserveThird: uint64,
    amountInAfterFee: uint64,
  ): [uint64, uint64, uint64] {
    assert(reserveIn > 0 && reserveOut > 0 && reserveThird > 0, 'empty reserves')

    const kBefore = this.computeOrbitalInvariant(reserveIn, reserveOut, reserveThird)
    const newReserveIn: uint64 = reserveIn + amountInAfterFee
    assert(newReserveIn >= reserveIn, 'reserve overflow')

    const newReserveInSq = this.safeSquare(newReserveIn)
    const reserveThirdSq = this.safeSquare(reserveThird)

    assert(kBefore >= newReserveInSq, 'invariant exhausted by input')
    const remainingAfterInput: uint64 = kBefore - newReserveInSq
    assert(remainingAfterInput >= reserveThirdSq, 'invariant exhausted by third reserve')

    const targetOutSq: uint64 = remainingAfterInput - reserveThirdSq
    const newReserveOut: uint64 = this.sqrtFloor(targetOutSq)

    assert(reserveOut >= newReserveOut, 'invalid output reserve')
    const amountOut: uint64 = reserveOut - newReserveOut
    return [amountOut, newReserveIn, newReserveOut]
  }

  private computeOrbitalInvariant(reserveA: uint64, reserveB: uint64, reserveC: uint64): uint64 {
    const reserveASq = this.safeSquare(reserveA)
    const reserveBSq = this.safeSquare(reserveB)
    const reserveCSq = this.safeSquare(reserveC)

    const sumAB: uint64 = reserveASq + reserveBSq
    assert(sumAB >= reserveASq, 'invariant overflow')
    const sumABC: uint64 = sumAB + reserveCSq
    assert(sumABC >= sumAB, 'invariant overflow')

    return sumABC
  }

  private safeSquare(value: uint64): uint64 {
    const squared: uint64 = value * value
    assert(value === 0 || squared / value === value, 'square overflow')
    return squared
  }

  private sqrtFloor(value: uint64): uint64 {
    return op.sqrt(value)
  }

  private getThirdReserveByAssetIds(assetInId: uint64, assetOutId: uint64): uint64 {
    assert(this.isPoolAsset(assetInId), 'assetIn unsupported')
    assert(this.isPoolAsset(assetOutId), 'assetOut unsupported')
    assert(assetInId !== assetOutId, 'asset ids must differ')

    if (assetInId !== this.assetAId.value && assetOutId !== this.assetAId.value) return this.reserveA.value
    if (assetInId !== this.assetBId.value && assetOutId !== this.assetBId.value) return this.reserveB.value
    return this.reserveC.value
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
