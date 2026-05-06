import WDK from '@tetherto/wdk'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import WalletManagerTron from '@tetherto/wdk-wallet-tron'
import WalletManagerBtc from '@tetherto/wdk-wallet-btc'

console.log('Starting WDK App...')

try {
    const seedPhrase = WDK.getRandomSeedPhrase()
    console.log('Generated seed phrase:', seedPhrase)

    console.log('Registering wallets...')

    const wdkWithWallets = new WDK(seedPhrase)
        .registerWallet('ethereum', WalletManagerEvm, {
            provider: 'https://eth.drpc.org'
        })
        .registerWallet('tron', WalletManagerTron, {
            provider: 'https://api.trongrid.io'
        })
        .registerWallet('bitcoin', WalletManagerBtc, {
            network: 'mainnet',
            host: 'electrum.blockstream.info',
            port: 50001
        })

    console.log('Wallets registered for Ethereum, TRON, and Bitcoin')

    const accounts = {
        ethereum: await wdkWithWallets.getAccount('ethereum', 0),
        tron: await wdkWithWallets.getAccount('tron', 0),
        bitcoin: await wdkWithWallets.getAccount('bitcoin', 0)
    }

    console.log('Resolving addresses:')

    for (const [chain, account] of Object.entries(accounts)) {
        const address = await account.getAddress()
        console.log(`   ${chain.toUpperCase()}: ${address}`)
    }

    console.log('Checking balances...')

    for (const [chain, account] of Object.entries(accounts)) {
        const balance = await account.getBalance()
        console.log(`   ${chain.toUpperCase()}: ${balance.toString()} units`)
    }

    console.log('Application completed successfully!')
    process.exit(0)
} catch (error) {
    console.error('Application error:', error.message)
    process.exit(1)
}