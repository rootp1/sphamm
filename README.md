# Tri-Asset AMM MVP (Algorand TestNet)

End-to-end MVP of a **3-asset unified AMM pool** on Algorand using:

- AlgoKit CLI
- Smart contracts in Algorand TypeScript (PuyaTS)
- Next.js App Router frontend (TypeScript)
- Pera Wallet integration
- TestNet deployment/scripts

## Project Structure

- `/contracts` — Algorand TypeScript smart contract + deploy script
- `/frontend` — Next.js swap UI + Pera integration
- `/scripts` — ASA creation, pool init, swap test scripts
- `/utils` — shared deterministic AMM math helper

## Smart Contract Summary

Contract file: `contracts/src/tri_asset_amm.algo.ts`

Global state:
- `assetAId`, `assetBId`, `assetCId`
- `reserveA`, `reserveB`, `reserveC`
- `feeBps`
- `admin`
- `paused`

Methods:
- `create_pool(assetA, assetB, assetC, amountA, amountB, amountC, feeBps)`
- `quote_swap_exact_in(assetInId, amountIn) -> amountOut`
- `swap_exact_in(assetInId, amountIn, minAmountOut) -> amountOut`
- `get_pool_state()`
- `pause()` / `unpause()`

Swap validation for `swap_exact_in`:
- group size == 2
- txn[0] is ASA transfer
- sender match
- receiver = app address
- asset and amount match
- paused check

## Invariant / Math

Simplified deterministic integer math (round down only):

1. `amountInAfterFee = floor(amountIn * (10000 - feeBps) / 10000)`
2. Pairwise projection using reserves of selected input/output assets:
   - `k = reserveIn * reserveOut`
   - `newReserveOut = floor(k / (reserveIn + amountInAfterFee))`
   - `amountOut = reserveOut - newReserveOut`
3. Require `amountOut >= minAmountOut`
4. Update reserves and send output ASA via inner tx

## AMM Model Explanation

This MVP uses a practical 3-asset approximation model:

- Pairwise pricing for swap quotes and execution (`reserveIn`/`reserveOut` constant-product step)
- Global 3-asset invariant validation after each swap (`K_global = reserveA * reserveB * reserveC`)

Why this design:

- Keeps computation light and deterministic for AVM limits
- Preserves simple exact-input UX and existing transaction flow
- Adds unified-pool consistency checks so post-swap state is globally coherent

Invariant behavior:

- Contract computes `K_before` and simulated `K_after`
- Swap is rejected if `K_after` decreases beyond rounding tolerance
- This approximates spherical/holistic 3-asset behavior while staying MVP-friendly

## Prerequisites

- Node.js 22+
- AlgoKit CLI 2.5+
- Python env with `puyapy` through AlgoKit
- Funded TestNet account(s)

## Environment

Copy and fill:

```bash
cp .env.example .env
cp frontend/.env.local.example frontend/.env.local
```

Required in `.env`:
- `DEPLOYER_MNEMONIC`
- `USER_MNEMONIC` (can be same as deployer for MVP)
- network endpoints (defaults already TestNet AlgoNode)

## Setup & Run

From project root:

```bash
npm run bootstrap
```

### 0) Fund deployer via TestNet Dispenser API (recommended)

Authenticate once:

```bash
algokit dispenser login
```

Then set `ALGOKIT_DISPENSER_ACCESS_TOKEN` in `.env` and run:

```bash
npm run fund:testnet
```

This uses:
- `ensureFundedFromTestNetDispenserApi` for minimum balance targeting
- optional direct funding via `TOP_UP_MICROALGOS` if set > 0

### 1) Build contract artifacts

```bash
npm run build:contracts
```

### 2) Deploy contract (TestNet)

```bash
npm run deploy:testnet
```

Take printed `APP_ID` and set `AMM_APP_ID` in `.env` and `NEXT_PUBLIC_AMM_APP_ID` in `frontend/.env.local`.

### 3) Create 3 ASAs

```bash
npm run create:asas
```

Set returned IDs into:
- `.env` as `ASSET_A_ID`, `ASSET_B_ID`, `ASSET_C_ID`
- `frontend/.env.local` as `NEXT_PUBLIC_ASSET_A_ID`, `NEXT_PUBLIC_ASSET_B_ID`, `NEXT_PUBLIC_ASSET_C_ID`

### 4) Initialize pool with 1000 each

```bash
npm run init:pool
```

### 5) Run frontend

```bash
npm run dev:frontend
```

Open `http://localhost:3000`, connect Pera, and swap.

### 6) Scripted swap test (10 A -> B)

```bash
npm run swap:test
```

This performs atomic group:
- Txn0: ASA transfer `A` user -> app
- Txn1: app call `swap_exact_in` with `foreignAssets=[B]`

Then prints updated reserves.

## Demo Flow Checklist

1. Deploy contract
2. Create 3 ASAs
3. Initialize pool (1000 each)
4. Connect Pera wallet in UI
5. Swap `10 A -> B`
6. Observe updated reserves in UI and script output

## Notes

- Deterministic uint64-only math; no floating point in contract.
- Output always rounds down.
- Frontend quote preview uses same formula for UX estimate.
- Keep this MVP on TestNet only.
