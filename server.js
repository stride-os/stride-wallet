import express from 'express'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import WDK from '@tetherto/wdk'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import WalletManagerEvmErc4337 from '@tetherto/wdk-wallet-evm-erc-4337'
import WalletManagerTron from '@tetherto/wdk-wallet-tron'
import WalletManagerBtc from '@tetherto/wdk-wallet-btc'

const SEPOLIA_CONFIG = {
  chainId: 11155111,
  provider: 'https://sepolia.drpc.org',
  bundlerUrl: 'https://public.pimlico.io/v2/11155111/rpc',
  paymasterUrl: 'https://public.pimlico.io/v2/11155111/rpc',
  paymasterAddress: '0x777777777777AeC03fd955926DbF81597e66834C',
  entryPointAddress: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  safeModulesVersion: '0.3.0',
  paymasterToken: {
    address: '0xd077a400968890eacc75cdc901f0356c943e4fdb' // test USDT on Sepolia
  }
}

// Token lists per chain: { address, symbol, decimals }
const CHAIN_TOKENS = {
  sepolia: [
    { address: '0xd077a400968890eacc75cdc901f0356c943e4fdb', symbol: 'USDT', decimals: 6 }
  ],
  ethereum: [
    { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6 }
  ]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json())
app.use(express.static(join(__dirname, 'public')))

let walletState = null

async function buildWallet(seedPhrase) {
  const wdk = new WDK(seedPhrase)
    .registerWallet('ethereum', WalletManagerEvm, { provider: 'https://eth.drpc.org' })
    .registerWallet('sepolia', WalletManagerEvmErc4337, SEPOLIA_CONFIG)
    .registerWallet('tron', WalletManagerTron, { provider: 'https://api.trongrid.io' })
    .registerWallet('bitcoin', WalletManagerBtc, {
      network: 'mainnet',
      host: 'electrum.blockstream.info',
      port: 50001
    })

  const [ethAccount, sepoliaAccount, tronAccount, btcAccount] = await Promise.all([
    wdk.getAccount('ethereum', 0),
    wdk.getAccount('sepolia', 0),
    wdk.getAccount('tron', 0),
    wdk.getAccount('bitcoin', 0)
  ])

  const [ethAddr, sepoliaAddr, tronAddr, btcAddr] = await Promise.all([
    ethAccount.getAddress(),
    sepoliaAccount.getAddress(),
    tronAccount.getAddress(),
    btcAccount.getAddress()
  ])

  return {
    seedPhrase,
    wdk,
    accounts: { ethereum: ethAccount, sepolia: sepoliaAccount, tron: tronAccount, bitcoin: btcAccount },
    addresses: { ethereum: ethAddr, sepolia: sepoliaAddr, tron: tronAddr, bitcoin: btcAddr }
  }
}

app.post('/api/create', async (req, res) => {
  try {
    const seedPhrase = WDK.getRandomSeedPhrase()
    walletState = await buildWallet(seedPhrase)
    res.json({ success: true, seedPhrase, addresses: walletState.addresses })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

app.post('/api/import', async (req, res) => {
  try {
    const { seedPhrase } = req.body
    if (!seedPhrase || typeof seedPhrase !== 'string') {
      return res.status(400).json({ error: 'Seed phrase required' })
    }
    walletState = await buildWallet(seedPhrase.trim())
    res.json({ success: true, addresses: walletState.addresses })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

app.get('/api/balances', async (req, res) => {
  if (!walletState) return res.status(400).json({ error: 'No wallet loaded' })
  try {
    // Native balances
    const nativeResults = await Promise.allSettled(
      Object.entries(walletState.accounts).map(async ([chain, account]) => {
        const balance = await account.getBalance()
        return [chain, balance.toString()]
      })
    )
    const balances = {}
    for (const r of nativeResults) {
      if (r.status === 'fulfilled') balances[r.value[0]] = r.value[1]
    }

    // Token balances for chains that have a token list
    const tokens = {}
    const tokenResults = await Promise.allSettled(
      Object.entries(CHAIN_TOKENS).map(async ([chain, list]) => {
        const account = walletState.accounts[chain]
        if (!account) return [chain, []]
        const addresses = list.map(t => t.address)
        const rawBalances = await account.getTokenBalances(addresses)
        const entries = list.map(t => ({
          ...t,
          balance: (rawBalances[t.address] ?? 0n).toString()
        }))
        return [chain, entries]
      })
    )
    for (const r of tokenResults) {
      if (r.status === 'fulfilled') tokens[r.value[0]] = r.value[1]
    }

    res.json({ balances, tokens })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

app.delete('/api/wallet', (req, res) => {
  walletState = null
  res.json({ success: true })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`STRIDE Wallet running at http://localhost:${PORT}`)
})
