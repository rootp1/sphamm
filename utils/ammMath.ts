const SCALE_BPS = 10_000n
const MAX_RESERVE = 100_000_000n

function toBigInt(value: number): bigint {
  return BigInt(Math.floor(value))
}

function safeSquare(x: bigint): bigint {
  if (x < 0n || x > 4_000_000_000n) throw new Error('square bound exceeded')
  return x * x
}

function safeSub(a: bigint, b: bigint): bigint {
  if (a < b) throw new Error('underflow')
  return a - b
}

function invariant3(a: bigint, b: bigint, c: bigint): bigint {
  return safeSquare(a) + safeSquare(b) + safeSquare(c)
}

function sqrtFloor(value: bigint): bigint {
  if (value < 0n) throw new Error('sqrt negative')
  if (value < 2n) return value
  let x0 = value
  let x1 = (x0 + value / x0) / 2n
  while (x1 < x0) {
    x0 = x1
    x1 = (x0 + value / x0) / 2n
  }
  return x0
}

function dominanceBps(a: bigint, b: bigint, c: bigint, k: bigint): bigint {
  const aSq = safeSquare(a)
  const bSq = safeSquare(b)
  const cSq = safeSquare(c)
  const maxSq = aSq > bSq ? (aSq > cSq ? aSq : cSq) : bSq > cSq ? bSq : cSq
  return (maxSq * SCALE_BPS) / k
}

function dynamicFeeBps(a: bigint, b: bigint, c: bigint): bigint {
  const k = invariant3(a, b, c)
  const dom = dominanceBps(a, b, c, k)
  if (dom <= 3_400n) return 30n
  if (dom >= 6_400n) return 100n
  return 30n + ((dom - 3_400n) * 70n) / 3_000n
}

function couplingAdjustment(reserveIn: bigint, reserveThird: bigint, amountInAfterFee: bigint, domBps: bigint): bigint {
  const denom = reserveIn * 20n
  let base = (reserveThird * amountInAfterFee) / denom
  if (base <= 0n) base = 1n
  let weighted = (base * (10_000n + domBps)) / SCALE_BPS
  if (weighted <= 0n) weighted = 1n
  const maxAdjust = reserveThird - 1n
  return weighted > maxAdjust ? maxAdjust : weighted
}

export type OrbitalQuote = {
  amountOut: number
  feeBps: number
  dominanceBps: number
  imbalanceRatio: number
  couplingAdjustment: number
  newReserveIn: number
  newReserveOut: number
  newReserveThird: number
}

export function quoteOrbitalExactIn(reserveInN: number, reserveOutN: number, reserveThirdN: number, amountInN: number): OrbitalQuote {
  const reserveIn = toBigInt(reserveInN)
  const reserveOut = toBigInt(reserveOutN)
  const reserveThird = toBigInt(reserveThirdN)
  const amountIn = toBigInt(amountInN)

  if (reserveIn <= 0n || reserveOut <= 0n || reserveThird <= 1n || amountIn <= 0n) {
    return { amountOut: 0, feeBps: 0, dominanceBps: 0, imbalanceRatio: 0, couplingAdjustment: 0, newReserveIn: Number(reserveIn), newReserveOut: Number(reserveOut), newReserveThird: Number(reserveThird) }
  }
  if (reserveIn > MAX_RESERVE || reserveOut > MAX_RESERVE || reserveThird > MAX_RESERVE) {
    return { amountOut: 0, feeBps: 0, dominanceBps: 0, imbalanceRatio: 0, couplingAdjustment: 0, newReserveIn: Number(reserveIn), newReserveOut: Number(reserveOut), newReserveThird: Number(reserveThird) }
  }
  if (reserveIn < 20n || amountIn > reserveIn / 20n) {
    return { amountOut: 0, feeBps: 0, dominanceBps: 0, imbalanceRatio: 0, couplingAdjustment: 0, newReserveIn: Number(reserveIn), newReserveOut: Number(reserveOut), newReserveThird: Number(reserveThird) }
  }

  const k = invariant3(reserveIn, reserveOut, reserveThird)
  const dom = dominanceBps(reserveIn, reserveOut, reserveThird, k)
  if (dom > 6_400n) {
    return { amountOut: 0, feeBps: Number(dynamicFeeBps(reserveIn, reserveOut, reserveThird)), dominanceBps: Number(dom), imbalanceRatio: Number(dom) / 10_000, couplingAdjustment: 0, newReserveIn: Number(reserveIn), newReserveOut: Number(reserveOut), newReserveThird: Number(reserveThird) }
  }

  const feeBps = dynamicFeeBps(reserveIn, reserveOut, reserveThird)
  const amountInAfterFee = (amountIn * (SCALE_BPS - feeBps)) / SCALE_BPS
  if (amountInAfterFee <= 0n) {
    return { amountOut: 0, feeBps: Number(feeBps), dominanceBps: Number(dom), imbalanceRatio: Number(dom) / 10_000, couplingAdjustment: 0, newReserveIn: Number(reserveIn), newReserveOut: Number(reserveOut), newReserveThird: Number(reserveThird) }
  }

  const newReserveIn = reserveIn + amountInAfterFee
  const deltaThird = couplingAdjustment(reserveIn, reserveThird, amountInAfterFee, dom)
  const newReserveThird = safeSub(reserveThird, deltaThird)

  const targetOutSq = safeSub(safeSub(k, safeSquare(newReserveIn)), safeSquare(newReserveThird))
  const newReserveOut = sqrtFloor(targetOutSq)
  if (newReserveOut > reserveOut) {
    return { amountOut: 0, feeBps: Number(feeBps), dominanceBps: Number(dom), imbalanceRatio: Number(dom) / 10_000, couplingAdjustment: Number(deltaThird), newReserveIn: Number(newReserveIn), newReserveOut: Number(newReserveOut), newReserveThird: Number(newReserveThird) }
  }
  const amountOut = safeSub(reserveOut, newReserveOut)

  return {
    amountOut: Number(amountOut),
    feeBps: Number(feeBps),
    dominanceBps: Number(dom),
    imbalanceRatio: Number(dom) / 10_000,
    couplingAdjustment: Number(deltaThird),
    newReserveIn: Number(newReserveIn),
    newReserveOut: Number(newReserveOut),
    newReserveThird: Number(newReserveThird),
  }
}
