# STRIDE Wallet

A self-custodial multi-chain wallet built on [Tether's Wallet Development Kit (WDK)](https://docs.wdk.tether.io). Runs as a local web app — no cloud, no custody, your keys never leave your machine.

---

## Supported chains

| Chain | Type | Network |
|---|---|---|
| Ethereum | Native ETH + USDT | Mainnet |
| Ethereum | Native ETH + USDT (ERC-4337 smart account) | Sepolia testnet |
| TRON | Native TRX | Mainnet |
| Bitcoin | Native BTC | Mainnet |

---

## Prerequisites

- [Node.js](https://nodejs.org) v20 or later
- npm (comes with Node.js)

---

## Getting started

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start
```

Then open **http://localhost:3000** in your browser.

For development with auto-reload on file changes:

```bash
npm run dev
```

---

## Usage

### Create a new wallet

Click **Create New Wallet**. A fresh 12-word BIP-39 seed phrase is generated and shown once — write it down before continuing. The wallet derives accounts for all four chains from that single phrase.

### Import an existing wallet

Click **Import Existing Wallet**, paste your seed phrase, and click **Import**.

### Check balances

Balances load automatically after the wallet is ready. Hit **Refresh balances** at any time to fetch the latest on-chain state.

### Send

Click **↑ Send** on any chain card to open the send panel:

1. Select the asset (native coin or a token like USDT)
2. Paste the recipient address
3. Enter the amount in human-readable units (e.g. `0.5` ETH, `10` USDT)
4. Click **Send** — the transaction hash appears on success

### Receive

Click **⬛ Receive** on any chain card to open a QR code you can scan with another wallet.

---

## Trying it on Sepolia (no real funds needed)

The Sepolia card uses an ERC-4337 smart account (account abstraction) with gas sponsored via Pimlico's public paymaster. You can get free test tokens from either faucet:

- **Test ETH** — https://faucets.chain.link/sepolia or https://sepoliafaucet.com
- **Test USDT** — https://dashboard.pimlico.io/test-erc20-faucet or https://dashboard.candide.dev/faucet

Fund the Sepolia address shown on the card, then hit Refresh to see your balance.

---

## Adding tokens

Open `server.js` and add entries to the `CHAIN_TOKENS` object:

```js
const CHAIN_TOKENS = {
  sepolia: [
    { address: '0xd077a400968890eacc75cdc901f0356c943e4fdb', symbol: 'USDT', decimals: 6 },
    { address: '0x...', symbol: 'USDC', decimals: 6 }, // add here
  ],
  ethereum: [
    { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6 },
  ]
}
```

Then mirror the same entry in `CHAIN_TOKENS_UI` at the top of the `<script>` block in `public/index.html` so the Send modal knows the token's decimals.

No other changes needed — token rows render automatically.

---

## Project structure

```
wdk-quickstart/
├── server.js          # Express server — WDK wallet logic + API endpoints
├── public/
│   └── index.html     # Single-page wallet UI (vanilla JS, no build step)
├── app.js             # Original CLI quickstart (Node.js only, no UI)
└── package.json
```

### API endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/create` | Generate a new seed phrase and initialize all wallets |
| `POST` | `/api/import` | Load wallets from an existing seed phrase |
| `GET` | `/api/balances` | Fetch native + token balances for all chains |
| `GET` | `/api/qr/:chain` | Return an SVG QR code for a chain address |
| `POST` | `/api/send` | Send native or ERC-20 tokens |
| `DELETE` | `/api/wallet` | Clear the in-memory wallet state |

`/api/send` body:

```json
{
  "chain": "sepolia",
  "to": "0xRecipientAddress",
  "amount": "1.5",
  "tokenAddress": "0xd077a400968890eacc75cdc901f0356c943e4fdb"
}
```

`tokenAddress` is optional — omit it to send the native coin.

---

## Security notes

- The seed phrase and private keys exist **only in Node.js process memory** for the lifetime of the server session. They are never written to disk and never sent to any third party.
- This is a local development wallet. Do not expose the server port to the internet.
- Always back up your seed phrase before using the wallet with real funds.

---

## Built with

- [WDK by Tether](https://docs.wdk.tether.io) — multi-chain self-custodial wallet SDK
- [Express](https://expressjs.com) — HTTP server
- [qrcode](https://github.com/soldair/node-qrcode) — QR code generation
