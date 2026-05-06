import express from 'express'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { scryptSync, createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import QRCode from 'qrcode'
import WDK from '@tetherto/wdk'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import WalletManagerEvmErc4337 from '@tetherto/wdk-wallet-evm-erc-4337'
import WalletManagerTron from '@tetherto/wdk-wallet-tron'
import WalletManagerBtc from '@tetherto/wdk-wallet-btc'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WALLET_FILE = join(__dirname, 'wallet.enc')

// ── Chain config ─────────────────────────────────────────────────────────────

const SEPOLIA_CONFIG = {
  chainId: 11155111,
  provider: 'https://sepolia.drpc.org',
  bundlerUrl: 'https://public.pimlico.io/v2/11155111/rpc',
  paymasterUrl: 'https://public.pimlico.io/v2/11155111/rpc',
  paymasterAddress: '0x777777777777AeC03fd955926DbF81597e66834C',
  entryPointAddress: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  safeModulesVersion: '0.3.0',
  paymasterToken: { address: '0xd077a400968890eacc75cdc901f0356c943e4fdb' }
}

const CHAIN_TOKENS = {
  sepolia:  [{ address: '0xd077a400968890eacc75cdc901f0356c943e4fdb', symbol: 'USDT', decimals: 6 }],
  ethereum: [{ address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6 }]
}

const NATIVE_DECIMALS = { ethereum: 18, sepolia: 18, tron: 6, bitcoin: 8 }
const CHAINS = ['ethereum', 'sepolia', 'tron', 'bitcoin']

// ── Encryption ────────────────────────────────────────────────────────────────

function encryptSeed(seedPhrase, password) {
  const salt = randomBytes(32)
  const key  = scryptSync(password, salt, 32)
  const iv   = randomBytes(16)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(seedPhrase, 'utf8'), cipher.final()])
  return JSON.stringify({
    salt:       salt.toString('hex'),
    iv:         iv.toString('hex'),
    authTag:    cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex')
  })
}

function decryptSeed(password) {
  const { salt, iv, authTag, ciphertext } = JSON.parse(readFileSync(WALLET_FILE, 'utf8'))
  const key      = scryptSync(password, Buffer.from(salt, 'hex'), 32)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'))
  decipher.setAuthTag(Buffer.from(authTag, 'hex'))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'hex')),
    decipher.final()
  ]).toString('utf8')
}

// ── Wallet builder ────────────────────────────────────────────────────────────

async function buildWallet(seedPhrase) {
  const wdk = new WDK(seedPhrase)
    .registerWallet('ethereum', WalletManagerEvm,       { provider: 'https://eth.drpc.org' })
    .registerWallet('sepolia',  WalletManagerEvmErc4337, SEPOLIA_CONFIG)
    .registerWallet('tron',     WalletManagerTron,       { provider: 'https://api.trongrid.io' })
    .registerWallet('bitcoin',  WalletManagerBtc,        { network: 'mainnet', host: 'electrum.blockstream.info', port: 50001 })

  const accounts  = { 0: {}, 1: {} }
  const addresses = { 0: {}, 1: {} }

  await Promise.all(
    [0, 1].flatMap(idx =>
      CHAINS.map(async chain => {
        const account = await wdk.getAccount(chain, idx)
        accounts[idx][chain]  = account
        addresses[idx][chain] = await account.getAddress()
      })
    )
  )

  return { wdk, accounts, addresses }
}

// ── Safe Transaction Service (EVM history for Safe/ERC-4337 accounts) ────────
// Only Sepolia uses ERC-4337 (Safe-based) — Ethereum mainnet uses a plain HD wallet

const SAFE_SERVICE = {
  sepolia: 'https://safe-transaction-sepolia.safe.global/api/v1'
}

async function fetchEvmTransfers(chain, address, limit = 15) {
  const base = SAFE_SERVICE[chain]
  if (!base) return null
  const url = `${base}/safes/${address}/transfers/?limit=${limit}`
  const res  = await fetch(url)
  if (res.status === 404) return []   // Safe not yet deployed / no history
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.error(`[safe-service] HTTP ${res.status} for ${chain} ${address}:`, body.slice(0, 300))
    throw new Error(`Safe service HTTP ${res.status}`)
  }
  const data = await res.json()
  return (data.results ?? [])
    .filter(t => t.type === 'ERC20_TRANSFER' || t.type === 'ETHER_TRANSFER')
    .map(t => ({
      hash:          t.transactionHash ?? '',
      value:         t.value ?? '0',
      fee:           '0',
      direction:     t.from?.toLowerCase() === address.toLowerCase() ? 'outgoing' : 'incoming',
      height:        t.blockNumber ?? null,
      recipient:     t.to ?? null,
      tokenSymbol:   t.tokenInfo?.symbol ?? (t.type === 'ETHER_TRANSFER' ? 'ETH' : null),
      tokenDecimals: t.tokenInfo?.decimals ?? 18
    }))
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toBaseUnits(humanAmount, decimals) {
  const [whole = '0', frac = ''] = String(humanAmount).split('.')
  const fracPadded = frac.padEnd(decimals, '0').slice(0, decimals)
  const cleanWhole = whole.replace(/^0+/, '') || '0'
  return BigInt(cleanWhole + fracPadded)
}

// ── Server ────────────────────────────────────────────────────────────────────

const app = express()
app.use(express.json())
app.use(express.static(join(__dirname, 'public')))

let walletState = null

// ── Wallet lifecycle ──────────────────────────────────────────────────────────

app.get('/api/wallet/status', (_req, res) => {
  res.json({ hasStoredWallet: existsSync(WALLET_FILE), isLoaded: walletState !== null })
})

app.post('/api/wallet/unlock', async (req, res) => {
  const { password } = req.body
  if (!password)               return res.status(400).json({ error: 'Password required' })
  if (!existsSync(WALLET_FILE)) return res.status(404).json({ error: 'No stored wallet' })
  try {
    const seedPhrase = decryptSeed(password)
    walletState = await buildWallet(seedPhrase)
    res.json({ success: true, addresses: walletState.addresses })
  } catch {
    res.status(401).json({ error: 'Incorrect password' })
  }
})

app.post('/api/create', async (req, res) => {
  const { password } = req.body
  if (!password) return res.status(400).json({ error: 'Password required' })
  try {
    const seedPhrase = WDK.getRandomSeedPhrase()
    walletState = await buildWallet(seedPhrase)
    writeFileSync(WALLET_FILE, encryptSeed(seedPhrase, password))
    res.json({ success: true, seedPhrase, addresses: walletState.addresses })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/import', async (req, res) => {
  const { seedPhrase, password } = req.body
  if (!seedPhrase || !password) return res.status(400).json({ error: 'Seed phrase and password required' })
  try {
    walletState = await buildWallet(seedPhrase.trim())
    writeFileSync(WALLET_FILE, encryptSeed(seedPhrase.trim(), password))
    res.json({ success: true, addresses: walletState.addresses })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Lock (keeps wallet.enc), or forget (deletes wallet.enc)
app.delete('/api/wallet', (req, res) => {
  walletState = null
  if (req.query.forget === 'true' && existsSync(WALLET_FILE)) unlinkSync(WALLET_FILE)
  res.json({ success: true })
})

// ── Balances ──────────────────────────────────────────────────────────────────

app.get('/api/balances', async (_req, res) => {
  if (!walletState) return res.status(400).json({ error: 'No wallet loaded' })
  try {
    const balances = { 0: {}, 1: {} }
    const tokens   = { 0: {}, 1: {} }

    await Promise.all(
      [0, 1].flatMap(idx =>
        CHAINS.map(async chain => {
          const account = walletState.accounts[idx][chain]

          try {
            balances[idx][chain] = (await account.getBalance()).toString()
          } catch {
            balances[idx][chain] = '0'
          }

          const list = CHAIN_TOKENS[chain]
          if (list) {
            try {
              const raw = await account.getTokenBalances(list.map(t => t.address))
              tokens[idx][chain] = list.map(t => ({ ...t, balance: (raw[t.address] ?? 0n).toString() }))
            } catch {
              tokens[idx][chain] = list.map(t => ({ ...t, balance: '0' }))
            }
          }
        })
      )
    )

    res.json({ balances, tokens })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Quote (fee estimate) ──────────────────────────────────────────────────────

app.post('/api/quote', async (req, res) => {
  if (!walletState) return res.status(400).json({ error: 'No wallet loaded' })
  const { chain, to, amount, tokenAddress, accountIndex = 0 } = req.body
  const account = walletState.accounts[accountIndex]?.[chain]
  if (!account) return res.status(400).json({ error: 'Unknown chain or account' })
  try {
    let fee
    if (tokenAddress) {
      const token    = CHAIN_TOKENS[chain]?.find(t => t.address.toLowerCase() === tokenAddress.toLowerCase())
      const decimals = token?.decimals ?? 18
      const result   = await account.quoteTransfer({ token: tokenAddress, recipient: to, amount: toBaseUnits(amount, decimals) })
      fee = result.fee
    } else {
      const result = await account.quoteSendTransaction({ to, value: toBaseUnits(amount, NATIVE_DECIMALS[chain] ?? 18) })
      fee = result.fee
    }
    res.json({ fee: fee.toString() })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Send ──────────────────────────────────────────────────────────────────────

app.post('/api/send', async (req, res) => {
  if (!walletState) return res.status(400).json({ error: 'No wallet loaded' })
  const { chain, to, amount, tokenAddress, accountIndex = 0 } = req.body
  if (!chain || !to || !amount) return res.status(400).json({ error: 'chain, to, and amount are required' })
  const account = walletState.accounts[accountIndex]?.[chain]
  if (!account) return res.status(400).json({ error: 'Unknown chain or account' })
  try {
    let result
    if (tokenAddress) {
      const token    = CHAIN_TOKENS[chain]?.find(t => t.address.toLowerCase() === tokenAddress.toLowerCase())
      const decimals = token?.decimals ?? 18
      result = await account.transfer({ token: tokenAddress, recipient: to, amount: toBaseUnits(amount, decimals) })
    } else {
      result = await account.sendTransaction({ to, value: toBaseUnits(amount, NATIVE_DECIMALS[chain] ?? 18) })
    }
    res.json({ hash: result.hash })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Transfer history ──────────────────────────────────────────────────────────

app.get('/api/transfers/:chain', async (req, res) => {
  if (!walletState) return res.status(400).json({ error: 'No wallet loaded' })
  const { chain } = req.params
  const accountIndex = parseInt(req.query.accountIndex ?? '0')
  const account = walletState.accounts[accountIndex]?.[chain]
  if (!account) return res.status(404).json({ error: 'Unknown chain or account' })

  // Bitcoin: use native WDK getTransfers
  if (typeof account.getTransfers === 'function') {
    try {
      const raw = await account.getTransfers({ limit: 15 })
      const transfers = raw.map(t => ({
        hash:      t.txid ?? t.hash ?? '',
        value:     (t.value ?? t.amount ?? 0n).toString(),
        fee:       (t.fee ?? 0n).toString(),
        direction: t.direction ?? 'outgoing',
        height:    t.height ?? null,
        recipient: t.recipient ?? t.to ?? null
      }))
      return res.json({ transfers })
    } catch (e) {
      return res.json({ transfers: [], error: e.message })
    }
  }

  // EVM chains: fetch token transfers from Blockscout
  const address = walletState.addresses[accountIndex]?.[chain]
  if (!address) return res.json({ transfers: [] })
  try {
    const transfers = await fetchEvmTransfers(chain, address)
    if (transfers === null) return res.json({ transfers: [], unavailable: true })
    res.json({ transfers })
  } catch (e) {
    res.json({ transfers: [], error: e.message })
  }
})

// ── QR code ───────────────────────────────────────────────────────────────────

app.get('/api/qr', async (req, res) => {
  const { address } = req.query
  if (!address) return res.status(400).json({ error: 'address query param required' })
  const svg = await QRCode.toString(address, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 })
  res.type('image/svg+xml').send(svg)
})

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`STRIDE Wallet running at http://localhost:${PORT}`))
