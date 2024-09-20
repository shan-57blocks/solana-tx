import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

function base58ToKeypair(base58PrivateKey: string): Keypair {
  try {
    const privateKeyBuffer = bs58.decode(base58PrivateKey);
    return Keypair.fromSecretKey(privateKeyBuffer);
  } catch (error) {
    throw new Error('Invalid base58 private key.');
  }
}

(async () => {
  const base58PrivateKey =
    '2gb5e548tgv65HprKYEqZNspr6LGdmitJe7Jqs8Qsw2MwbP2LDcedBxopKZ9TpUB5kaCzpgVNATGBuYRMYijkR4J'; // Replace with actual base58 private key
  const keypair = base58ToKeypair(base58PrivateKey);
  console.log(`Public Key: ${keypair.publicKey.toBase58()}`); //prints the base58-encoded public key
  // @ts-ignore
  console.log(`Secret: [${keypair.secretKey.toString()}]`); // prints the base58-encoded private key
})();
