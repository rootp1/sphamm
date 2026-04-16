import algosdk from 'algosdk'
import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing env: ${name}`)
  return value
}

function configuredAssetIds(): number[] {
  const ids = [
    Number(process.env.ASSET_A_ID ?? process.env.NEXT_PUBLIC_ASSET_A_ID ?? '0'),
    Number(process.env.ASSET_B_ID ?? process.env.NEXT_PUBLIC_ASSET_B_ID ?? '0'),
    Number(process.env.ASSET_C_ID ?? process.env.NEXT_PUBLIC_ASSET_C_ID ?? '0'),
  ].filter((id) => Number.isInteger(id) && id > 0)

  return ids
}

export async function POST(request: NextRequest) {
  try {
    const { receiver, assetId, amount } = (await request.json()) as {
      receiver?: string
      assetId?: number
      amount?: number
    }

    if (!receiver || !algosdk.isValidAddress(receiver)) {
      return NextResponse.json({ error: 'Invalid receiver address' }, { status: 400 })
    }

    const transferAmount = Number(amount)
    if (!Number.isInteger(transferAmount) || transferAmount <= 0) {
      return NextResponse.json({ error: 'Amount must be a positive integer' }, { status: 400 })
    }

    const transferAssetId = Number(assetId)
    const allowedAssetIds = configuredAssetIds()
    if (!allowedAssetIds.includes(transferAssetId)) {
      return NextResponse.json({ error: 'Asset is not allowed by faucet config' }, { status: 400 })
    }

    const algod = new algosdk.Algodv2(
      process.env.ALGOD_TOKEN ?? process.env.NEXT_PUBLIC_ALGOD_TOKEN ?? '',
      requiredEnv('ALGOD_SERVER'),
      process.env.ALGOD_PORT ?? process.env.NEXT_PUBLIC_ALGOD_PORT ?? '443',
    )

    const deployer = algosdk.mnemonicToSecretKey(requiredEnv('DEPLOYER_MNEMONIC'))
    const params = await algod.getTransactionParams().do()

    const transferTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: deployer.addr,
      receiver,
      amount: transferAmount,
      assetIndex: transferAssetId,
      suggestedParams: params,
    })

    const signedTxn = transferTxn.signTxn(deployer.sk)
    const { txid } = await algod.sendRawTransaction(signedTxn).do()
    await algosdk.waitForConfirmation(algod, txid, 4)

    return NextResponse.json({ txid })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Faucet transfer failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
