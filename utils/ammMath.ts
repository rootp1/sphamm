export function applyFee(amountIn: number, feeBps: number): number {
  return Math.floor((amountIn * (10_000 - feeBps)) / 10_000)
}

export function quoteExactIn(reserveIn: number, reserveOut: number, amountIn: number, feeBps: number): number {
  if (reserveIn <= 0 || reserveOut <= 0 || amountIn <= 0) return 0
  const amountInAfterFee = applyFee(amountIn, feeBps)
  const newReserveIn = reserveIn + amountInAfterFee
  const k = reserveIn * reserveOut
  const newReserveOut = Math.floor(k / newReserveIn)
  return reserveOut - newReserveOut
}
