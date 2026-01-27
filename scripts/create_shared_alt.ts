import {
    Connection,
    Keypair,
    PublicKey,
    AddressLookupTableProgram,
    Transaction,
    sendAndConfirmTransaction,
    LAMPORTS_PER_SOL,
    SYSVAR_INSTRUCTIONS_PUBKEY,
    SYSVAR_RENT_PUBKEY,
    SYSVAR_CLOCK_PUBKEY
} from '@solana/web3.js';

const RPC_URL = 'https://api.devnet.solana.com';
const USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

async function airdropWithRetry(connection: Connection, publicKey: PublicKey, retries = 5) {
    for (let i = 0; i < retries; i++) {
        try {
            console.log(`Requesting Airdrop (Attempt ${i + 1})...`);
            const sig = await connection.requestAirdrop(publicKey, 2 * LAMPORTS_PER_SOL);
            await connection.confirmTransaction(sig);
            console.log("Airdrop confirmed.");
            return true;
        } catch (e) {
            console.error(`Airdrop attempt ${i + 1} failed.`, e);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    return false;
}

async function main() {
    const connection = new Connection(RPC_URL, 'confirmed');
    const payer = Keypair.generate();
    console.log("Local Payer:", payer.publicKey.toBase58());

    if (!await airdropWithRetry(connection, payer.publicKey)) {
        console.error("Could not fund payer. Aborting.");
        return;
    }

    const currentSlot = await connection.getSlot();

    // 1. Create ALT
    const [createIx, altAddress] = AddressLookupTableProgram.createLookupTable({
        authority: payer.publicKey,
        payer: payer.publicKey,
        recentSlot: currentSlot,
    });

    console.log("Creating ALT at:", altAddress.toBase58());

    const createTx = new Transaction().add(createIx);
    await sendAndConfirmTransaction(connection, createTx, [payer]);

    console.log("ALT Created.");

    // 2. Extend ALT
    const addresses = [
        PublicKey.default, // System Program
        new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), // Token Program
        new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'), // ATA Program
        new PublicKey('ComputeBudget111111111111111111111111111111'), // Compute Budget

        // Use constants
        SYSVAR_INSTRUCTIONS_PUBKEY,
        SYSVAR_RENT_PUBKEY,
        SYSVAR_CLOCK_PUBKEY,

        USDC_MINT
    ];

    console.log(`Extending ALT with ${addresses.length} addresses...`);

    const extendIx = AddressLookupTableProgram.extendLookupTable({
        payer: payer.publicKey,
        authority: payer.publicKey,
        lookupTable: altAddress,
        addresses: addresses,
    });

    const extendTx = new Transaction().add(extendIx);
    await sendAndConfirmTransaction(connection, extendTx, [payer]);

    console.log("ALT Extended.");
    console.log("FINAL ALT ADDRESS:", altAddress.toBase58());
}

main().catch(console.error);
