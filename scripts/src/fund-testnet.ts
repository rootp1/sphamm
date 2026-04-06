import { algos, AlgorandClient } from '@algorandfoundation/algokit-utils'
import algosdk from 'algosdk'
import { execSync } from 'node:child_process'

async function main() {
  const deployerMnemonic = process.env.DEPLOYER_MNEMONIC
  if (!deployerMnemonic) throw new Error('DEPLOYER_MNEMONIC is required in .env')

  const deployer = algosdk.mnemonicToSecretKey(deployerMnemonic)
  const deployerAddress = deployer.addr.toString()

  const cliFundMicroAlgos = Number(process.env.CLI_FUND_MICROALGOS ?? '20000000')

  const algod = new algosdk.Algodv2(
    process.env.ALGOD_TOKEN ?? '',
    process.env.ALGOD_SERVER ?? 'https://testnet-api.algonode.cloud',
    process.env.ALGOD_PORT ?? '443',
  )

  if (!process.env.ALGOKIT_DISPENSER_ACCESS_TOKEN) {
    console.log('ALGOKIT_DISPENSER_ACCESS_TOKEN not set; using AlgoKit CLI dispenser funding fallback')
    const before = Number((await algod.accountInformation(deployerAddress).do()).amount ?? 0)
    execSync(`algokit dispenser fund --receiver ${deployerAddress} --amount ${cliFundMicroAlgos}`, {
      stdio: 'inherit',
    })
    const after = Number((await algod.accountInformation(deployerAddress).do()).amount ?? 0)
    if (after <= before) {
      throw new Error('Funding did not succeed. Run `algokit dispenser login` and complete device auth, then retry `npm run fund:testnet`.')
    }
    console.log(`CLI fund completed: ${cliFundMicroAlgos} microAlgos`)
    return
  }

  const algorand = AlgorandClient.fromConfig({
    algodConfig: {
      server: process.env.ALGOD_SERVER ?? 'https://testnet-api.algonode.cloud',
      token: process.env.ALGOD_TOKEN ?? '',
      port: process.env.ALGOD_PORT ?? '443',
    },
    indexerConfig: {
      server: process.env.INDEXER_SERVER ?? 'https://testnet-idx.algonode.cloud',
      token: process.env.INDEXER_TOKEN ?? '',
      port: process.env.INDEXER_PORT ?? '443',
    },
  })

  const dispenserClient = algorand.client.getTestNetDispenserFromEnvironment()

  await algorand.account.ensureFundedFromTestNetDispenserApi(
    deployerAddress,
    dispenserClient,
    algos(20),
  )
  console.log(`ensureFundedFromTestNetDispenserApi completed for ${deployerAddress}`)

  const topUpMicroAlgos = Number(process.env.TOP_UP_MICROALGOS ?? '0')
  if (topUpMicroAlgos > 0) {
    await dispenserClient.fund(deployerAddress, topUpMicroAlgos)
    console.log(`Direct fund completed: ${topUpMicroAlgos} microAlgos`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
