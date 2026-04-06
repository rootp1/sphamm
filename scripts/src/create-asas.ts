import algosdk from 'algosdk'
import { getAccountFromMnemonic, getAlgodClient, getSuggestedParams, waitFor } from './common.ts'

async function createSingleAsa(
  algod: algosdk.Algodv2,
  creator: algosdk.Account,
  unitName: string,
  assetName: string,
): Promise<number> {
  const suggestedParams = await getSuggestedParams(algod)

  const txn = algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
    sender: creator.addr,
    total: 10_000_000,
    decimals: 0,
    defaultFrozen: false,
    unitName,
    assetName,
    manager: creator.addr,
    reserve: creator.addr,
    freeze: creator.addr,
    clawback: creator.addr,
    suggestedParams,
  })

  const signed = txn.signTxn(creator.sk)
  const { txid } = await algod.sendRawTransaction(signed).do()
  const confirmed = await waitFor(algod, txid)
  if (!confirmed.assetIndex) throw new Error(`ASA creation failed for ${assetName}`)
  return Number(confirmed.assetIndex)
}

async function main() {
  const algod = getAlgodClient()
  const deployer = getAccountFromMnemonic('DEPLOYER_MNEMONIC')

  const assetA = await createSingleAsa(algod, deployer, 'ASTA', 'Asset A')
  const assetB = await createSingleAsa(algod, deployer, 'ASTB', 'Asset B')
  const assetC = await createSingleAsa(algod, deployer, 'ASTC', 'Asset C')

  console.log('Created ASAs')
  console.log(`ASSET_A_ID=${assetA}`)
  console.log(`ASSET_B_ID=${assetB}`)
  console.log(`ASSET_C_ID=${assetC}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
