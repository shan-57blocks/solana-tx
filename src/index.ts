/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/ban-types */
import * as anchor from '@coral-xyz/anchor';
import { BN, Program } from '@coral-xyz/anchor';
import {
  createAssociatedTokenAccount,
  createMint,
  getAssociatedTokenAddressSync,
  mintTo,
  TOKEN_2022_PROGRAM_ID
} from '@solana/spl-token';
import { Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import fs from 'fs';
import { CONSTANTS } from './utils/Constants';
import { toToken } from './utils/CommonUtils';

const KEYPAIR_PATH = 'keypairs';

function loadKeypairFromFile(filename: string): Keypair {
  const filePath = `${__dirname}/${KEYPAIR_PATH}/${filename}.json`;
  // console.log(`Loading keypair from file: ${filePath}, root path: ${__dirname}`);
  const secret = JSON.parse(fs.readFileSync(filePath).toString()) as number[];
  const secretKey = Uint8Array.from(secret);
  return Keypair.fromSecretKey(secretKey);
}

const TranchesPolicy = {
  FixedSeniorYield: { fixedSeniorYield: {} },
  RiskAdjusted: { riskAdjusted: {} }
};

const PayPeriodDuration = {
  Monthly: { monthly: {} },
  Quarterly: { quarterly: {} },
  SemiAnnually: { semiAnnually: {} }
};

const Credit = {
  CreditLine: { creditLine: {} },
  ReceivableBackedCreditLine: { receivableBackedCreditLine: {} }
};

const PROTOCOL_FEE_BPS = 500;
const USER_DEFAULT_USDC_AMOUNT = toToken(100_000_000);

enum Tranche {
  JUNIOR,
  SENIOR
}

let provider: anchor.AnchorProvider;
let program: Program;
let transferHookProgram: Program;

let humaOwner: Keypair;
let humaTreasury: Keypair;
let sentinel: Keypair;
let pauser: Keypair;
let poolOwner: Keypair;
let poolTreasury: Keypair;
let poolOperator: Keypair;
let ea: Keypair;
let lender: Keypair;
let borrower: Keypair;

let humaConfigID: PublicKey;
let humaConfigPDA: PublicKey;
let assetMint: Keypair;
let liquidityAssetPDA: PublicKey;

let poolID: PublicKey;
let poolConfigPDA: PublicKey;
let poolStatePDA: PublicKey;
let poolAuthorityPDA: PublicKey;
let seniorTrancheMintPDA: PublicKey;
let juniorTrancheMintPDA: PublicKey;
let poolUnderlyingTokenPDA: PublicKey;
let poolSeniorTokenPDA: PublicKey;
let poolJuniorTokenPDA: PublicKey;
let seniorStatePDA: PublicKey;
let juniorStatePDA: PublicKey;
let poolOperatorConfigPDA: PublicKey;
let juniorExtraAccountMetaListPDA: PublicKey;
let seniorExtraAccountMetaListPDA: PublicKey;
let humaProgramAuthorityPDA: PublicKey;

function start() {
  provider = anchor.AnchorProvider.env();
  provider.opts.commitment = 'confirmed';
  anchor.setProvider(provider);
  program = anchor.workspace.Huma as Program;
  transferHookProgram = anchor.workspace.TrancheTokenHook as Program;
}

async function loadKeypairs() {
  humaOwner = loadKeypairFromFile('huma_owner');
  console.log(
    `humaOwner: ${humaOwner.publicKey}, balance: ${await provider.connection.getBalance(humaOwner.publicKey)}`
  );
  humaTreasury = loadKeypairFromFile('huma_treasury');
  console.log(
    `humaTreasury: ${humaTreasury.publicKey}, balance: ${await provider.connection.getBalance(humaTreasury.publicKey)}`
  );
  sentinel = loadKeypairFromFile('sentinel');
  console.log(
    `sentinel: ${sentinel.publicKey}, balance: ${await provider.connection.getBalance(sentinel.publicKey)}`
  );
  pauser = loadKeypairFromFile('pauser');
  console.log(
    `pauser: ${pauser.publicKey}, balance: ${await provider.connection.getBalance(pauser.publicKey)}`
  );
  poolOwner = loadKeypairFromFile('pool_owner');
  console.log(
    `poolOwner: ${poolOwner.publicKey}, balance: ${await provider.connection.getBalance(poolOwner.publicKey)}`
  );
  poolTreasury = loadKeypairFromFile('pool_treasury');
  console.log(
    `poolTreasury: ${poolTreasury.publicKey}, balance: ${await provider.connection.getBalance(poolTreasury.publicKey)}`
  );
  poolOperator = loadKeypairFromFile('pool_operator');
  console.log(
    `poolOperator: ${poolOperator.publicKey}, balance: ${await provider.connection.getBalance(poolOperator.publicKey)}`
  );
  ea = loadKeypairFromFile('ea');
  console.log(
    `ea: ${ea.publicKey}, balance: ${await provider.connection.getBalance(ea.publicKey)}`
  );
  lender = loadKeypairFromFile('lender');
  console.log(
    `lender: ${lender.publicKey}, balance: ${await provider.connection.getBalance(lender.publicKey)}`
  );
  borrower = loadKeypairFromFile('borrower');
  console.log(
    `borrower: ${borrower.publicKey}, balance: ${await provider.connection.getBalance(borrower.publicKey)}`
  );
}

async function createHumaConfig() {
  console.log('\nstart to create huma config...');

  humaConfigID = Keypair.generate().publicKey;
  [humaConfigPDA] = PublicKey.findProgramAddressSync(
    [anchor.utils.bytes.utf8.encode('huma_config'), humaConfigID.toBuffer()],
    program.programId
  );
  await program.methods
    .createHumaConfig(
      humaConfigID,
      humaTreasury.publicKey,
      sentinel.publicKey,
      PROTOCOL_FEE_BPS
    )
    .accountsPartial({
      owner: humaOwner.publicKey,
      humaConfig: humaConfigPDA
    })
    .signers([humaOwner])
    .rpc();
  console.log(
    `created huma config: humaConfigID: ${humaConfigID}, humaConfigPDA: ${humaConfigPDA}`
  );

  const [pauserConfigPDA] = PublicKey.findProgramAddressSync(
    [
      anchor.utils.bytes.utf8.encode('pauser'),
      humaConfigPDA.toBuffer(),
      pauser.publicKey.toBuffer()
    ],
    program.programId
  );
  await program.methods
    .addPauser(pauser.publicKey)
    .accountsPartial({
      owner: humaOwner.publicKey,
      humaConfig: humaConfigPDA,
      pauserConfig: pauserConfigPDA
    })
    .signers([humaOwner])
    .rpc();
  console.log(`added huma config pauser: ${pauser.publicKey}`);

  assetMint = Keypair.generate();
  await createMint(
    provider.connection,
    humaOwner,
    humaOwner.publicKey,
    humaOwner.publicKey,
    6,
    assetMint,
    undefined,
    TOKEN_2022_PROGRAM_ID
  );
  console.log(`created asset mint: ${assetMint.publicKey}`);

  [liquidityAssetPDA] = PublicKey.findProgramAddressSync(
    [
      anchor.utils.bytes.utf8.encode('liquidity_asset'),
      humaConfigPDA.toBuffer(),
      assetMint.publicKey.toBuffer()
    ],
    program.programId
  );
  await program.methods
    .addLiquidityAsset()
    .accountsPartial({
      owner: humaOwner.publicKey,
      humaConfig: humaConfigPDA,
      mint: assetMint.publicKey,
      liquidityAsset: liquidityAssetPDA
    })
    .signers([humaOwner])
    .rpc();
  console.log(`added asset mint: ${assetMint.publicKey}`);

  console.log('created huma config done');
}

async function createPool() {
  console.log('\nstart to create pool...');

  poolID = Keypair.generate().publicKey;

  [poolConfigPDA] = PublicKey.findProgramAddressSync(
    [anchor.utils.bytes.utf8.encode('pool_config'), poolID.toBuffer()],
    program.programId
  );
  [poolStatePDA] = PublicKey.findProgramAddressSync(
    [anchor.utils.bytes.utf8.encode('pool_state'), poolConfigPDA.toBuffer()],
    program.programId
  );
  [poolAuthorityPDA] = PublicKey.findProgramAddressSync(
    [
      anchor.utils.bytes.utf8.encode('pool_authority'),
      poolConfigPDA.toBuffer()
    ],
    program.programId
  );
  poolUnderlyingTokenPDA = getAssociatedTokenAddressSync(
    assetMint.publicKey,
    poolAuthorityPDA,
    true,
    TOKEN_2022_PROGRAM_ID
  );

  await program.methods
    .createPool(
      poolID,
      'test pool',
      poolTreasury.publicKey,
      ea.publicKey,
      TranchesPolicy.RiskAdjusted
    )
    .accountsPartial({
      owner: poolOwner.publicKey,
      humaConfig: humaConfigPDA,
      underlyingMint: assetMint.publicKey,
      liquidityAsset: liquidityAssetPDA,
      poolConfig: poolConfigPDA,
      poolState: poolStatePDA,
      poolAuthority: poolAuthorityPDA,
      poolUnderlyingToken: poolUnderlyingTokenPDA,
      tokenProgram: TOKEN_2022_PROGRAM_ID
    })
    .signers([poolOwner])
    .rpc({ skipPreflight: true });
  console.log(`created pool config: ${poolConfigPDA}`);

  await program.methods
    .setPoolSettings({
      maxCreditLine: toToken(10_000_000),
      minDepositAmount: toToken(10),
      payPeriodDuration: PayPeriodDuration.Monthly,
      latePaymentGracePeriodDays: 5,
      defaultGracePeriodDays: 90,
      advanceRateBps: 10000,
      receivableAutoApproval: true,
      principalOnlyPaymentAllowed: true,
      creditType: Credit.CreditLine
    })
    .accountsPartial({
      signer: poolOwner.publicKey,
      humaConfig: humaConfigPDA,
      poolConfig: poolConfigPDA,
      underlyingMint: assetMint.publicKey
    })
    .signers([poolOwner])
    .rpc();
  console.log(`set pool settings: ${poolConfigPDA}`);

  await program.methods
    .setLpConfig({
      liquidityCap: toToken(1_000_000_000),
      maxSeniorJuniorRatio: 4,
      fixedSeniorYieldBps: 0,
      tranchesRiskAdjustmentBps: 2000,
      withdrawalLockupPeriodDays: 90
    })
    .accountsPartial({
      signer: poolOwner.publicKey,
      humaConfig: humaConfigPDA,
      poolConfig: poolConfigPDA
    })
    .signers([poolOwner])
    .rpc();
  console.log(`set lp config: ${poolConfigPDA}`);

  await program.methods
    .setAdminRnr({
      rewardRateBpsForEa: 300,
      rewardRateBpsForPoolOwner: 200,
      liquidityRateBpsForEa: 200,
      liquidityRateBpsForPoolOwner: 200
    })
    .accountsPartial({
      signer: poolOwner.publicKey,
      humaConfig: humaConfigPDA,
      poolConfig: poolConfigPDA
    })
    .signers([poolOwner])
    .rpc();
  console.log(`set admin rnr: ${poolConfigPDA}`);

  await program.methods
    .setFeeStructure({
      frontLoadingFeeFlat: toToken(0),
      frontLoadingFeeBps: 0,
      yieldBps: 1000,
      lateFeeBps: 1000
    })
    .accountsPartial({
      signer: poolOwner.publicKey,
      humaConfig: humaConfigPDA,
      poolConfig: poolConfigPDA
    })
    .signers([poolOwner])
    .rpc();
  console.log(`set fee structure: ${poolConfigPDA}`);

  [seniorTrancheMintPDA] = PublicKey.findProgramAddressSync(
    [
      anchor.utils.bytes.utf8.encode('senior_tranche_mint'),
      poolConfigPDA.toBuffer()
    ],
    program.programId
  );
  [juniorTrancheMintPDA] = PublicKey.findProgramAddressSync(
    [
      anchor.utils.bytes.utf8.encode('junior_tranche_mint'),
      poolConfigPDA.toBuffer()
    ],
    program.programId
  );
  poolSeniorTokenPDA = getAssociatedTokenAddressSync(
    seniorTrancheMintPDA,
    poolAuthorityPDA,
    true,
    TOKEN_2022_PROGRAM_ID
  );
  poolJuniorTokenPDA = getAssociatedTokenAddressSync(
    juniorTrancheMintPDA,
    poolAuthorityPDA,
    true,
    TOKEN_2022_PROGRAM_ID
  );
  [seniorStatePDA] = PublicKey.findProgramAddressSync(
    [
      anchor.utils.bytes.utf8.encode('tranche_state'),
      seniorTrancheMintPDA.toBuffer()
    ],
    program.programId
  );
  [juniorStatePDA] = PublicKey.findProgramAddressSync(
    [
      anchor.utils.bytes.utf8.encode('tranche_state'),
      juniorTrancheMintPDA.toBuffer()
    ],
    program.programId
  );
  await program.methods
    .createPoolAccounts()
    .accountsPartial({
      poolOwner: poolOwner.publicKey,
      underlyingMint: assetMint.publicKey,
      poolConfig: poolConfigPDA,
      poolAuthority: poolAuthorityPDA,
      seniorMint: seniorTrancheMintPDA,
      juniorMint: juniorTrancheMintPDA,
      tokenProgram: TOKEN_2022_PROGRAM_ID
    })
    .remainingAccounts([
      {
        pubkey: poolJuniorTokenPDA,
        isWritable: true,
        isSigner: false
      },
      {
        pubkey: juniorStatePDA,
        isWritable: true,
        isSigner: false
      },
      {
        pubkey: poolSeniorTokenPDA,
        isWritable: true,
        isSigner: false
      },
      {
        pubkey: seniorStatePDA,
        isWritable: true,
        isSigner: false
      }
    ])
    .signers([poolOwner])
    .rpc();
  console.log(`created pool accounts: ${poolConfigPDA}`);

  [humaProgramAuthorityPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('huma_program_authority')],
    program.programId
  );
  [juniorExtraAccountMetaListPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('extra-account-metas'), juniorTrancheMintPDA.toBuffer()],
    transferHookProgram.programId
  );

  console.log(
    'transferHookProgram: ',
    transferHookProgram.programId.toBase58()
  );

  await program.methods
    .initializeExtraAccountMetaList()
    .accountsPartial({
      poolOwner: poolOwner.publicKey,
      humaProgramAuthority: humaProgramAuthorityPDA,
      poolConfig: poolConfigPDA,
      poolState: poolStatePDA,
      hookProgram: transferHookProgram.programId,
      poolAuthority: poolAuthorityPDA,
      extraAccountMetaList: juniorExtraAccountMetaListPDA,
      trancheMint: juniorTrancheMintPDA,
      tokenProgram: TOKEN_2022_PROGRAM_ID
    })
    .signers([poolOwner])
    .rpc();
  console.log(`initialized extra account meta list for junior tranche`);

  [seniorExtraAccountMetaListPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('extra-account-metas'), seniorTrancheMintPDA.toBuffer()],
    transferHookProgram.programId
  );

  await program.methods
    .initializeExtraAccountMetaList()
    .accountsPartial({
      poolOwner: poolOwner.publicKey,
      humaProgramAuthority: humaProgramAuthorityPDA,
      poolConfig: poolConfigPDA,
      poolState: poolStatePDA,
      hookProgram: transferHookProgram.programId,
      poolAuthority: poolAuthorityPDA,
      extraAccountMetaList: seniorExtraAccountMetaListPDA,
      trancheMint: seniorTrancheMintPDA,
      tokenProgram: TOKEN_2022_PROGRAM_ID
    })
    .signers([poolOwner])
    .rpc();
  console.log(`initialized extra account meta list for senior tranche`);

  console.log('created pool done');
}

async function createLenderAccounts(lender: Keypair, trancheMint: PublicKey) {
  await program.methods
    .createLenderAccounts()
    .accountsPartial({
      lender: lender.publicKey,
      humaConfig: humaConfigPDA,
      poolConfig: poolConfigPDA,
      approvedLender: PublicKey.findProgramAddressSync(
        [
          anchor.utils.bytes.utf8.encode('approved_lender'),
          trancheMint.toBuffer(),
          lender.publicKey.toBuffer()
        ],
        program.programId
      )[0],
      trancheMint,
      lenderTrancheToken: getAssociatedTokenAddressSync(
        trancheMint,
        lender.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      ),
      tokenProgram: TOKEN_2022_PROGRAM_ID
    })
    .signers([lender])
    .rpc();
}

async function makeIntialDeposit(
  tranche: PublicKey,
  depositor: Keypair,
  minAmount: BN
) {
  const depositorUnderlyingATA = getAssociatedTokenAddressSync(
    assetMint.publicKey,
    depositor.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  const depositorTrancheATA = getAssociatedTokenAddressSync(
    tranche,
    depositor.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  await program.methods
    .makeInitialDeposit(minAmount)
    .accountsPartial({
      depositor: depositor.publicKey,
      poolConfig: poolConfigPDA,
      underlyingMint: assetMint.publicKey,
      trancheMint: tranche,
      poolAuthority: poolAuthorityPDA,
      poolUnderlyingToken: poolUnderlyingTokenPDA,
      depositorUnderlyingToken: depositorUnderlyingATA,
      depositorTrancheToken: depositorTrancheATA,
      tokenProgram: TOKEN_2022_PROGRAM_ID
    })
    .signers([depositor])
    .rpc();
}

async function enablePool() {
  console.log('\nstart to enable pool...');

  await mintToUsers(poolTreasury);
  let depositor = poolTreasury;
  let minAmount = await getMinLiquidityRequirementsForPoolOwner(Tranche.JUNIOR);
  console.log(`pool owner minAmount: ${minAmount} for junior tranche`);
  await createLenderAccounts(depositor, juniorTrancheMintPDA);
  console.log(`created lender accounts in junior tranche for poolTreasury`);
  if (!minAmount.isZero()) {
    await makeIntialDeposit(juniorTrancheMintPDA, depositor, minAmount);
    console.log(
      `pool owner maked initial deposit ${minAmount} in junior tranche`
    );
  }
  minAmount = await getMinLiquidityRequirementsForPoolOwner(Tranche.SENIOR);
  console.log(`pool owner minAmount: ${minAmount} for senior tranche`);
  await createLenderAccounts(depositor, seniorTrancheMintPDA);
  console.log(`created lender accounts in senior tranche for poolTreasury`);
  if (!minAmount.isZero()) {
    await makeIntialDeposit(seniorTrancheMintPDA, depositor, minAmount);
    console.log(
      `pool owner maked initial deposit ${minAmount} in senior tranche`
    );
  }

  await mintToUsers(ea);
  depositor = ea;
  minAmount = await getMinLiquidityRequirementsForEa(Tranche.JUNIOR);
  console.log(`ea minAmount: ${minAmount} for senior tranche`);
  await createLenderAccounts(depositor, juniorTrancheMintPDA);
  console.log(`created lender accounts in junior tranche for ea`);
  if (!minAmount.isZero()) {
    await makeIntialDeposit(juniorTrancheMintPDA, depositor, minAmount);
    console.log(`ea maked initial deposit ${minAmount} in junior tranche`);
  }
  minAmount = await getMinLiquidityRequirementsForEa(Tranche.SENIOR);
  console.log(`ea minAmount: ${minAmount} for senior tranche`);
  await createLenderAccounts(depositor, seniorTrancheMintPDA);
  console.log(`created lender accounts in senior tranche for ea`);
  if (!minAmount.isZero()) {
    await makeIntialDeposit(seniorTrancheMintPDA, depositor, minAmount);
    console.log(`ea maked initial deposit ${minAmount} in senior tranche`);
  }

  await program.methods
    .enablePool()
    .accountsPartial({
      signer: poolOwner.publicKey,
      humaConfig: humaConfigPDA,
      poolConfig: poolConfigPDA,
      poolOwnerTreasuryJuniorToken: getAssociatedTokenAddressSync(
        juniorTrancheMintPDA,
        poolTreasury.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      ),
      poolOwnerTreasurySeniorToken: getAssociatedTokenAddressSync(
        seniorTrancheMintPDA,
        poolTreasury.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      ),
      eaJuniorToken: getAssociatedTokenAddressSync(
        juniorTrancheMintPDA,
        ea.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      ),
      eaSeniorToken: getAssociatedTokenAddressSync(
        seniorTrancheMintPDA,
        ea.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      ),
      tokenProgram: TOKEN_2022_PROGRAM_ID
    })
    .signers([poolOwner])
    .rpc();
  console.log(`enabled pool: ${poolConfigPDA}`);

  [poolOperatorConfigPDA] = PublicKey.findProgramAddressSync(
    [
      anchor.utils.bytes.utf8.encode('pool_operator'),
      poolConfigPDA.toBuffer(),
      poolOperator.publicKey.toBuffer()
    ],
    program.programId
  );
  await program.methods
    .addPoolOperator(poolOperator.publicKey)
    .accountsPartial({
      poolOwner: poolOwner.publicKey,
      poolConfig: poolConfigPDA,
      poolOperatorConfig: poolOperatorConfigPDA
    })
    .signers([poolOwner])
    .rpc();
  console.log(`added pool operator: ${poolConfigPDA}`);

  console.log('enabled pool done');
}

async function deposit(depositor: Keypair, tranche: PublicKey, amount: BN) {
  const depositorUnderlyingATA = getAssociatedTokenAddressSync(
    assetMint.publicKey,
    depositor.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );
  const depositorTrancheATA = getAssociatedTokenAddressSync(
    tranche,
    depositor.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  return await program.methods
    .deposit(amount)
    .accountsPartial({
      depositor: depositor.publicKey,
      poolConfig: poolConfigPDA,
      underlyingMint: assetMint.publicKey,
      trancheMint: tranche,
      poolUnderlyingToken: poolUnderlyingTokenPDA,
      depositorUnderlyingToken: depositorUnderlyingATA,
      depositorTrancheToken: depositorTrancheATA,
      humaConfig: humaConfigPDA,
      tokenProgram: TOKEN_2022_PROGRAM_ID
    })
    .signers([depositor])
    .rpc();
}

async function createDepositTransaction(
  depositor: Keypair,
  tranche: PublicKey,
  amount: BN
) {
  const depositorUnderlyingATA = getAssociatedTokenAddressSync(
    assetMint.publicKey,
    depositor.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );
  const depositorTrancheATA = getAssociatedTokenAddressSync(
    tranche,
    depositor.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  const tran = await program.methods
    .deposit(amount)
    .accountsPartial({
      depositor: depositor.publicKey,
      poolConfig: poolConfigPDA,
      underlyingMint: assetMint.publicKey,
      trancheMint: tranche,
      poolUnderlyingToken: poolUnderlyingTokenPDA,
      depositorUnderlyingToken: depositorUnderlyingATA,
      depositorTrancheToken: depositorTrancheATA,
      humaConfig: humaConfigPDA,
      tokenProgram: TOKEN_2022_PROGRAM_ID
    })
    .transaction();

  return tran;
}

async function addApprovedLender(lender: PublicKey, trancheMint: PublicKey) {
  await program.methods
    .addApprovedLender(lender)
    .accountsPartial({
      poolOperator: poolOperator.publicKey,
      poolConfig: poolConfigPDA,
      poolOperatorConfig: poolOperatorConfigPDA,
      trancheMint,
      tokenProgram: TOKEN_2022_PROGRAM_ID
    })
    .remainingAccounts([
      {
        pubkey: getAssociatedTokenAddressSync(
          trancheMint,
          lender,
          false,
          TOKEN_2022_PROGRAM_ID
        ),
        isWritable: true,
        isSigner: false
      },
      {
        pubkey: PublicKey.findProgramAddressSync(
          [
            anchor.utils.bytes.utf8.encode('lender_state'),
            trancheMint.toBuffer(),
            lender.toBuffer()
          ],
          program.programId
        )[0],
        isWritable: true,
        isSigner: false
      }
    ])
    .signers([poolOperator])
    .rpc();
}

async function addLiquidity() {
  console.log('\nstart to add liquidity...');

  await mintToUsers(lender);

  await addApprovedLender(lender.publicKey, juniorTrancheMintPDA);
  console.log(`added approved lender: ${lender.publicKey} in junior tranche`);
  await addApprovedLender(lender.publicKey, seniorTrancheMintPDA);
  console.log(`added approved lender: ${lender.publicKey} in senior tranche`);
  await createLenderAccounts(lender, juniorTrancheMintPDA);
  console.log(`created lender accounts in junior tranche for lender`);
  await createLenderAccounts(lender, seniorTrancheMintPDA);
  console.log(`created lender accounts in senior tranche for lender`);

  console.log(
    `lender balance: ${await provider.connection.getBalance(lender.publicKey)}, payer balance: ${await provider.connection.getBalance(provider.wallet.publicKey)}`
  );
  // await deposit(lender, juniorTrancheMintPDA, toToken(1_000_000));
  const tran = await createDepositTransaction(
    lender,
    juniorTrancheMintPDA,
    toToken(1_000_000)
  );
  await sendAndConfirmTransaction(provider.connection, tran, [lender]);

  console.log(`deposited 1m in junior tranche`);
  console.log(
    `lender balance: ${await provider.connection.getBalance(lender.publicKey)}, payer balance: ${await provider.connection.getBalance(provider.wallet.publicKey)}`
  );
  await deposit(lender, seniorTrancheMintPDA, toToken(500_000));
  console.log(`deposited 500k in senior tranche`);

  await mintToUsers(sentinel);

  await addApprovedLender(sentinel.publicKey, juniorTrancheMintPDA);
  console.log(`added approved lender: ${sentinel.publicKey} in junior tranche`);
  await createLenderAccounts(sentinel, juniorTrancheMintPDA);
  console.log(`created lender accounts in junior tranche for sentinel`);
  await deposit(sentinel, juniorTrancheMintPDA, toToken(100_000));
  console.log(`sentinel deposited 100k in junior tranche`);

  console.log('added liquidity done');
}

async function refreshCredit(borrower: PublicKey) {
  await program.methods
    .refreshCredit()
    .accountsPartial({
      humaConfig: humaConfigPDA,
      poolConfig: poolConfigPDA,
      poolState: poolStatePDA,
      creditConfig: PublicKey.findProgramAddressSync(
        [
          anchor.utils.bytes.utf8.encode('credit_config'),
          poolConfigPDA.toBuffer(),
          borrower.toBuffer()
        ],
        program.programId
      )[0],
      creditState: PublicKey.findProgramAddressSync(
        [
          anchor.utils.bytes.utf8.encode('credit_state'),
          poolConfigPDA.toBuffer(),
          borrower.toBuffer()
        ],
        program.programId
      )[0]
    })
    .rpc();
}

async function createRefreshCreditTransaction(borrower: PublicKey) {
  return await program.methods
    .refreshCredit()
    .accountsPartial({
      humaConfig: humaConfigPDA,
      poolConfig: poolConfigPDA,
      poolState: poolStatePDA,
      creditConfig: PublicKey.findProgramAddressSync(
        [
          anchor.utils.bytes.utf8.encode('credit_config'),
          poolConfigPDA.toBuffer(),
          borrower.toBuffer()
        ],
        program.programId
      )[0],
      creditState: PublicKey.findProgramAddressSync(
        [
          anchor.utils.bytes.utf8.encode('credit_state'),
          poolConfigPDA.toBuffer(),
          borrower.toBuffer()
        ],
        program.programId
      )[0]
    })
    .transaction();
}

async function handleCredit() {
  console.log('\nstart to handle credit...');

  await program.methods
    .approveCredit(
      borrower.publicKey,
      toToken(1_000_000),
      12,
      1217,
      new BN(0),
      new BN(0),
      true
    )
    .accountsPartial({
      evaluationAgent: ea.publicKey,
      humaConfig: humaConfigPDA,
      poolConfig: poolConfigPDA
    })
    .signers([ea])
    .rpc();
  console.log(`approved credit for borrower: ${borrower.publicKey}`);

  await createAssociatedTokenAccount(
    provider.connection,
    borrower,
    assetMint.publicKey,
    borrower.publicKey,
    undefined,
    TOKEN_2022_PROGRAM_ID
  );

  const [creditConfigPDA] = PublicKey.findProgramAddressSync(
    [
      anchor.utils.bytes.utf8.encode('credit_config'),
      poolConfigPDA.toBuffer(),
      borrower.publicKey.toBuffer()
    ],
    program.programId
  );
  const [creditStatePDA] = PublicKey.findProgramAddressSync(
    [
      anchor.utils.bytes.utf8.encode('credit_state'),
      poolConfigPDA.toBuffer(),
      borrower.publicKey.toBuffer()
    ],
    program.programId
  );
  const borrowerUnderlyingATA = getAssociatedTokenAddressSync(
    assetMint.publicKey,
    borrower.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );
  await program.methods
    .drawdown(toToken(1_000_000))
    .accountsPartial({
      borrower: borrower.publicKey,
      humaConfig: humaConfigPDA,
      poolConfig: poolConfigPDA,
      poolState: poolStatePDA,
      creditConfig: creditConfigPDA,
      creditState: creditStatePDA,
      poolAuthority: poolAuthorityPDA,
      underlyingMint: assetMint.publicKey,
      poolUnderlyingToken: poolUnderlyingTokenPDA,
      borrowerUnderlyingToken: borrowerUnderlyingATA,
      tokenProgram: TOKEN_2022_PROGRAM_ID
    })
    .signers([borrower])
    .rpc();
  console.log(`drawdown 1m for borrower: ${borrower.publicKey}`);

  // sleep for 5 second
  console.log('sleep for 5 seconds...');
  await new Promise((r) => setTimeout(r, 5000));

  console.log(
    `borrower balance: ${await provider.connection.getBalance(borrower.publicKey)}, payer balance: ${await provider.connection.getBalance(provider.wallet.publicKey)}`
  );
  // await refreshCredit(borrower.publicKey);
  const tran = await createRefreshCreditTransaction(borrower.publicKey);
  await sendAndConfirmTransaction(provider.connection, tran, [borrower]);
  console.log(`refresh credit`);
  console.log(
    `borrower balance: ${await provider.connection.getBalance(borrower.publicKey)}, payer balance: ${await provider.connection.getBalance(provider.wallet.publicKey)}`
  );

  await program.methods
    .makePayment(toToken(500_000))
    .accountsPartial({
      signer: borrower.publicKey,
      humaConfig: humaConfigPDA,
      poolConfig: poolConfigPDA,
      poolState: poolStatePDA,
      creditConfig: creditConfigPDA,
      creditState: creditStatePDA,
      poolAuthority: poolAuthorityPDA,
      underlyingMint: assetMint.publicKey,
      poolUnderlyingToken: poolUnderlyingTokenPDA,
      borrowerUnderlyingToken: borrowerUnderlyingATA,
      tokenProgram: TOKEN_2022_PROGRAM_ID
    })
    .signers([borrower])
    .rpc();
  console.log(`made payment 500k for borrower: ${borrower.publicKey}`);

  console.log('handled credit done');
}

async function removeLiquidity() {
  console.log('\nstart to remove liquidity...');
  // @ts-ignore
  const poolConfig = await program.account.poolConfig.fetch(poolConfigPDA);
  const lpConfig = {
    ...poolConfig.lpConfig,
    ...{ withdrawalLockupPeriodDays: 0 }
  };
  await program.methods
    .setLpConfig(lpConfig)
    .accountsPartial({
      signer: poolOwner.publicKey,
      humaConfig: humaConfigPDA,
      poolConfig: poolConfigPDA,
      poolState: poolStatePDA
    })
    .signers([poolOwner])
    .rpc();
  console.log(`set withdrawalLockupPeriodDays to 0`);

  await program.methods
    .addRedemptionRequest(toToken(20_000))
    .accountsPartial({
      lender: sentinel.publicKey,
      humaConfig: humaConfigPDA,
      poolConfig: poolConfigPDA,
      trancheMint: juniorTrancheMintPDA,
      poolTrancheToken: poolJuniorTokenPDA,
      lenderTrancheToken: getAssociatedTokenAddressSync(
        juniorTrancheMintPDA,
        sentinel.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      ),
      tokenProgram: TOKEN_2022_PROGRAM_ID
    })
    .signers([sentinel])
    .rpc();
  console.log(`sentinel added redemption request 20k for junior tranche`);

  await program.methods
    .closePool()
    .accountsPartial({
      signer: poolOwner.publicKey,
      humaConfig: humaConfigPDA,
      poolConfig: poolConfigPDA,
      underlyingMint: assetMint.publicKey,
      poolUnderlyingToken: poolUnderlyingTokenPDA,
      seniorMint: seniorTrancheMintPDA,
      seniorState: seniorStatePDA,
      poolSeniorToken: poolSeniorTokenPDA,
      poolJuniorToken: poolJuniorTokenPDA,
      tokenProgram: TOKEN_2022_PROGRAM_ID
    })
    .signers([poolOwner])
    .rpc();
  console.log(`closed pool: ${poolConfigPDA}`);

  await program.methods
    .withdrawAfterPoolClosure()
    .accountsPartial({
      lender: sentinel.publicKey,
      poolConfig: poolConfigPDA,
      underlyingMint: assetMint.publicKey,
      trancheMint: juniorTrancheMintPDA,
      poolUnderlyingToken: poolUnderlyingTokenPDA,
      lenderUnderlyingToken: getAssociatedTokenAddressSync(
        assetMint.publicKey,
        sentinel.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      ),
      lenderTrancheToken: getAssociatedTokenAddressSync(
        juniorTrancheMintPDA,
        sentinel.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      ),
      tokenProgram: TOKEN_2022_PROGRAM_ID
    })
    .signers([sentinel])
    .rpc();
  console.log(`sentinel withdrew all from junior tranche`);

  console.log('removed liquidity done');
}

async function getMinLiquidityRequirementsForPoolOwner(tranche: Tranche) {
  // @ts-ignore
  const poolConfig = await program.account.poolConfig.fetch(poolConfigPDA);
  const lpConfig = poolConfig.lpConfig;
  const poolSettings = poolConfig.poolSettings;
  if (tranche === Tranche.JUNIOR) {
    const minRelativeBalance = lpConfig.liquidityCap
      .mul(new BN(poolConfig.adminRnr.liquidityRateBpsForPoolOwner))
      .div(CONSTANTS.HUNDRED_PERCENT_BPS);
    return BN.max(minRelativeBalance, poolSettings.minDepositAmount);
  } else {
    return poolConfig.lpConfig.maxSeniorJuniorRatio === 0
      ? toToken(0)
      : poolSettings.minDepositAmount;
  }
}

async function getMinLiquidityRequirementsForEa(tranche: Tranche) {
  const poolConfig =
    // @ts-ignore
    await await program.account.poolConfig.fetch(poolConfigPDA);
  if (tranche === Tranche.JUNIOR) {
    const minRelativeBalance = poolConfig.lpConfig.liquidityCap
      .mul(new BN(poolConfig.adminRnr.liquidityRateBpsForEa))
      .div(CONSTANTS.HUNDRED_PERCENT_BPS);
    return BN.max(minRelativeBalance, poolConfig.poolSettings.minDepositAmount);
  } else {
    return new BN(0);
  }
}

async function mintToUsers(user: Keypair) {
  const ataAddr = await createAssociatedTokenAccount(
    provider.connection,
    user,
    assetMint.publicKey,
    user.publicKey,
    undefined,
    TOKEN_2022_PROGRAM_ID
  );
  await mintTo(
    provider.connection,
    user,
    assetMint.publicKey,
    ataAddr,
    humaOwner,
    BigInt(USER_DEFAULT_USDC_AMOUNT.toString()),
    [],
    undefined,
    TOKEN_2022_PROGRAM_ID
  );
}

(async () => {
  start();
  await loadKeypairs();
  humaConfigPDA = new PublicKey('eLiteCmDY2bsWbeaon4SswBW78yrUdrQZMZC4a42ssj');
  poolConfigPDA = new PublicKey('6x5UbXnyTsbXQ9sbr9PhetxYyxFzjP824vRjnjF81kht');
  await handleCredit();
})();
