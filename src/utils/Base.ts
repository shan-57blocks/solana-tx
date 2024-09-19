import * as anchor from '@coral-xyz/anchor';
import { BN, Program, web3 } from '@coral-xyz/anchor';
import { MPL_CORE_PROGRAM_ID } from '@metaplex-foundation/mpl-core';
import { toWeb3JsPublicKey } from '@metaplex-foundation/umi-web3js-adapters';
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  unpackMint
} from '@solana/spl-token';
import {
  AccountInfo,
  Keypair,
  PublicKey,
  SystemProgram
} from '@solana/web3.js';
import { assert, expect } from 'chai';
import crypto from 'crypto';
import { Clock, startAnchor } from 'solana-bankrun';
import IDL from '../target/idl/huma.json';
import TransferHookIDL from '../target/idl/tranche_token_hook.json';
import { Huma } from '../target/types/huma';
import { TrancheTokenHook } from '../target/types/tranche_token_hook';
import { BankrunProvider } from './anchor-bankrun';
import { CONSTANTS } from './Constants';
import {
  assertCloseTo,
  convertToBN,
  createAssociatedTokenAccount,
  createMint,
  getTokenAccount,
  mintTo,
  mintToUsers,
  toToken
} from './CommonUtils';
import { calcAssetsAfterPnlForRiskAdjustedPolicy } from './utils/PnLUtils';

export enum PDAKey {
  HUMA_CONFIG,
  PAUSER_CONFIG,
  LIQUIDITY_ASSET,
  POOL_AUTHORITY,
  POOL_CONFIG,
  POOL_STATE,
  SENIOR_TRANCHE_MINT,
  JUNIOR_TRANCHE_MINT,
  POOL_UNDERLYING_TOKEN,
  POOL_JUNIOR_TOKEN,
  POOL_SENIOR_TOKEN,
  POOL_JUNIOR_STATE,
  POOL_SENIOR_STATE,
  POOL_OPERATOR_CONFIG,
  HUMA_PROGRAM_AUTHORITY
}

const HUMA_OWNER = 0;
const HUMA_TREASURY = 1;
const SENTINEL = 2;
const PAUSER = 3;
const POOL_OWNER = 4;
const POOL_TREASURY = 5;
const EVALUATION_AGENT = 6;
const POOL_OPERATOR = 7;

const LENDER_STARTING_INDEX = 12;
const NUM_LENDERS = 6;

const BORROWER_STARTING_INDEX = 18;
const NUM_BORROWERS = 4;

const TEMP_USER_STARTING_INDEX = 22;

export const USER_DEFAULT_USDC_AMOUNT = toToken(1_000_000_000);

export const WalletAccountKey = {
  HUMA_OWNER,
  HUMA_TREASURY,
  SENTINEL,
  PAUSER,
  POOL_OWNER,
  POOL_TREASURY,
  EVALUATION_AGENT,
  POOL_OPERATOR
};

export const PoolStatus = {
  Off: { off: {} },
  On: { on: {} },
  Closed: { closed: {} }
};

export const TranchesPolicy = {
  FixedSeniorYield: { fixedSeniorYield: {} },
  RiskAdjusted: { riskAdjusted: {} }
};

export type CreditType =
  | { creditLine: {} }
  | { receivableBackedCreditLine: {} };
export const Credit = {
  CreditLine: { creditLine: {} },
  ReceivableBackedCreditLine: { receivableBackedCreditLine: {} }
};

export type PayPeriodDurationType =
  | { monthly: {} }
  | { quarterly: {} }
  | { semiAnnually: {} };
export const PayPeriodDuration = {
  Monthly: { monthly: {} },
  Quarterly: { quarterly: {} },
  SemiAnnually: { semiAnnually: {} }
};

export function convertToPayPeriodDuration(input: PayPeriodDurationType) {
  switch (Object.keys(input)[0]) {
    case 'monthly':
      return PayPeriodDuration.Monthly;
    case 'quarterly':
      return PayPeriodDuration.Quarterly;
    case 'semiAnnually':
      return PayPeriodDuration.SemiAnnually;
    default:
      throw new Error('Invalid pay period duration');
  }
}

export type CreditStatusType =
  | { deleted: {} }
  | { approved: {} }
  | { goodStanding: {} }
  | { delayed: {} }
  | { defaulted: {} };

export function convertToCreditStatus(input: CreditStatusType) {
  switch (Object.keys(input)[0]) {
    case 'deleted':
      return CreditStatus.Deleted;
    case 'approved':
      return CreditStatus.Approved;
    case 'goodStanding':
      return CreditStatus.GoodStanding;
    case 'delayed':
      return CreditStatus.Delayed;
    case 'defaulted':
      return CreditStatus.Defaulted;
    default:
      throw new Error('Invalid credit state');
  }
}

export const CreditStatus = {
  Deleted: { deleted: {} },
  Approved: { approved: {} },
  GoodStanding: { goodStanding: {} },
  Delayed: { delayed: {} },
  Defaulted: { defaulted: {} }
};

export interface PaymentRecord {
  principalDuePaid: anchor.BN;
  yieldDuePaid: anchor.BN;
  unbilledPrincipalPaid: anchor.BN;
  principalPastDuePaid: anchor.BN;
  yieldPastDuePaid: anchor.BN;
  lateFeePaid: anchor.BN;
}

export interface FeeStructure {
  frontLoadingFeeFlat: anchor.BN;
  frontLoadingFeeBps: number;
  yieldBps: number;
  lateFeeBps: number;
}

export interface CreateReceivableArgs {
  name: string;
  uri: string;
  currencyCode: string;
  receivableAmount: anchor.BN;
  maturityDate: anchor.BN;
  referenceId: string;
}

export class Context {
  provider!: BankrunProvider;
  program!: Program;
  transferHookProgram!: Program;
  accounts: Map = new Map();
  walletAccounts: Keypair[] = [];
  mint: Keypair;

  humaConfigContext: HumaConfigContext;
  poolContext: PoolContext;
  trancheVaultContext: TrancheVaultContext;
  creditContext: CreditContext;
  transferHookContext: TransferHookContext;

  constructor() {
    this.mint = Keypair.generate();
    this.humaConfigContext = new HumaConfigContext(this);
    this.poolContext = new PoolContext(this);
    this.trancheVaultContext = new TrancheVaultContext(this);
    this.creditContext = new CreditContext(this);
    this.transferHookContext = new TransferHookContext(this);
  }

  async start(numAccounts = 25) {
    const accounts = [];
    for (let i = 0; i < numAccounts; i++) {
      const account = Keypair.generate();
      this.walletAccounts.push(account);
      accounts.push({
        address: account.publicKey,
        info: {
          lamports: 100_000_000_000,
          data: Buffer.alloc(0),
          owner: SystemProgram.programId,
          executable: false
        }
      });
    }

    const programPath = require('path').resolve(__dirname, '..');
    const context = await startAnchor(
      programPath,
      [{ name: 'mpl_core', programId: toWeb3JsPublicKey(MPL_CORE_PROGRAM_ID) }],
      accounts
    );
    this.provider = new BankrunProvider(context);
    const idl = IDL as Huma;
    this.program = new Program<Huma>(idl, this.provider);
    const transferHookIDL = TransferHookIDL as TrancheTokenHook;
    this.transferHookProgram = new Program<TrancheTokenHook>(
      transferHookIDL,
      this.provider
    );
  }

  async initHumaConfig(protocolFeeBps = 500) {
    await this.humaConfigContext.createHumaConfigAccount(protocolFeeBps);
    await this.humaConfigContext.addPauser();
    await this.humaConfigContext.addLiquidityAsset();
    await this.initLenders();

    const underlyingMintAddr = this.assetMint().publicKey;
    await createAssociatedTokenAccount(
      this.provider.context,
      underlyingMintAddr,
      this.humaConfigContext.humaTreasury().publicKey
    );
  }

  async initPool(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tranchePolicy: any = TranchesPolicy.RiskAdjusted,
    isUniTranche = false
  ) {
    await this.poolContext.createPoolConfig('test pool', tranchePolicy);
    await this.poolContext.initPoolConfigByDefault();
    await this.poolContext.setPoolSettings({
      maxCreditLine: toToken(10_000_000),
      minDepositAmount: toToken(10),
      payPeriodDuration: PayPeriodDuration.Monthly,
      latePaymentGracePeriodDays: 5,
      defaultGracePeriodDays: 90,
      advanceRateBps: 10000,
      receivableAutoApproval: true,
      principalOnlyPaymentAllowed: true
    });
    await this.poolContext.createPoolAccounts(isUniTranche);
    await this.transferHookContext.initializeExtraAccountMetaList(
      this.poolContext.juniorTrancheMintPDA()
    );
    if (!isUniTranche) {
      await this.transferHookContext.initializeExtraAccountMetaList(
        this.poolContext.seniorTrancheMintPDA()
      );
    } else {
      await this.poolContext.setLpConfig({
        maxSeniorJuniorRatio: 0
      });
    }
  }

  async enablePool(isUniTranche = false) {
    const juniorTrancheMintPDA = this.poolContext.juniorTrancheMintPDA();
    let seniorTrancheMintPDA = null;
    if (!isUniTranche) {
      seniorTrancheMintPDA = this.poolContext.seniorTrancheMintPDA();
    }
    let depositor = this.poolContext.poolOwnerTreasury();
    let minAmount =
      await this.poolContext.getMinLiquidityRequirementsForPoolOwner(
        CONSTANTS.JUNIOR_TRANCHE
      );
    await this.trancheVaultContext.createLenderAccounts(
      depositor,
      juniorTrancheMintPDA
    );
    if (!minAmount.isZero()) {
      await this.trancheVaultContext.makeInitialDeposit(
        depositor,
        this.poolContext.juniorTrancheMintPDA(),
        minAmount
      );
    }
    if (seniorTrancheMintPDA) {
      minAmount =
        await this.poolContext.getMinLiquidityRequirementsForPoolOwner(
          CONSTANTS.SENIOR_TRANCHE
        );
      await this.trancheVaultContext.createLenderAccounts(
        depositor,
        seniorTrancheMintPDA
      );
      if (!minAmount.isZero()) {
        await this.trancheVaultContext.makeInitialDeposit(
          depositor,
          this.poolContext.seniorTrancheMintPDA(),
          minAmount
        );
      }
    }

    depositor = this.poolContext.evaluationAgent();
    minAmount = await this.poolContext.getMinLiquidityRequirementsForEA(
      CONSTANTS.JUNIOR_TRANCHE
    );
    await this.trancheVaultContext.createLenderAccounts(
      depositor,
      juniorTrancheMintPDA
    );
    if (!minAmount.isZero()) {
      await this.trancheVaultContext.makeInitialDeposit(
        depositor,
        this.poolContext.juniorTrancheMintPDA(),
        minAmount
      );
    }
    if (seniorTrancheMintPDA) {
      minAmount = await this.poolContext.getMinLiquidityRequirementsForEA(
        CONSTANTS.SENIOR_TRANCHE
      );
      await this.trancheVaultContext.createLenderAccounts(
        depositor,
        seniorTrancheMintPDA
      );
      if (!minAmount.isZero()) {
        await this.trancheVaultContext.makeInitialDeposit(
          depositor,
          this.poolContext.seniorTrancheMintPDA(),
          minAmount
        );
      }
    }

    await this.poolContext.enablePool(isUniTranche);
    await this.poolContext.addPoolOperator();
  }

  async createAssetMint(decimals = 6) {
    const owner = this.humaConfigContext.humaOwner();
    const mint = Keypair.generate();
    await createMint(
      this.provider.context,
      owner.publicKey,
      owner.publicKey,
      decimals,
      mint
    );

    return mint;
  }

  async initLenders() {
    const lenders = this.lenders();
    lenders.push(this.poolContext.poolOwner());
    lenders.push(this.poolContext.poolOwnerTreasury());
    lenders.push(this.poolContext.evaluationAgent());
    await mintToUsers(this, lenders, USER_DEFAULT_USDC_AMOUNT);
  }

  async initBorrowers(borrowers: Keypair[] = this.borrowers()) {
    const underlyingMintAddr = this.assetMint().publicKey;
    const maxCreditLine = toToken(1_000_000_000);
    await this.poolContext.setPoolSettings({ maxCreditLine });
    for (const borrower of borrowers) {
      await this.creditContext.approveCredit(
        borrower,
        maxCreditLine,
        12,
        1217,
        new anchor.BN(0)
      );
      await createAssociatedTokenAccount(
        this.provider.context,
        underlyingMintAddr,
        borrower.publicKey
      );
    }
  }

  setAssetMint(mint: Keypair) {
    this.mint = mint;
  }

  assetMint() {
    return this.mint;
  }

  tempUsers(num: number) {
    return this.walletAccounts.slice(
      TEMP_USER_STARTING_INDEX,
      TEMP_USER_STARTING_INDEX + num
    );
  }

  async currentTimestamp() {
    const clock = await this.provider.context.banksClient.getClock();
    return Number(clock.unixTimestamp);
  }

  async futureBlockTimestamp(offsetSecs: number) {
    const currentTS = await this.currentTimestamp();
    return currentTS + offsetSecs;
  }

  async setNextBlockTimestamp(timestamp: number) {
    const clock = await this.provider.context.banksClient.getClock();
    this.provider.context.setClock(
      new Clock(
        clock.slot,
        clock.epochStartTimestamp,
        clock.epoch,
        clock.leaderScheduleEpoch,
        BigInt(timestamp)
      )
    );
  }

  lender() {
    return this.lenders()[0];
  }

  lenders() {
    return this.walletAccounts.slice(
      LENDER_STARTING_INDEX,
      LENDER_STARTING_INDEX + NUM_LENDERS
    );
  }

  borrower() {
    return this.borrowers()[0];
  }

  borrowers() {
    return this.walletAccounts.slice(
      BORROWER_STARTING_INDEX,
      BORROWER_STARTING_INDEX + NUM_BORROWERS
    );
  }

  getUserUnderlyingATA(user: PublicKey, allowOwnerOffCurve = false) {
    return getAssociatedTokenAddressSync(
      this.mint.publicKey,
      user,
      allowOwnerOffCurve,
      TOKEN_2022_PROGRAM_ID
    );
  }

  async getUnderlyingBalanceOf(
    user: PublicKey,
    allowOwnerOffCurve = false
  ): Promise {
    return convertToBN(
      (
        await getTokenAccount(
          this,
          this.getUserUnderlyingATA(user, allowOwnerOffCurve)
        )
      ).amount
    );
  }

  async getPoolUnderlyingBalance() {
    return convertToBN(
      (await getTokenAccount(this, this.poolContext.poolUnderlyingTokenPDA()))
        .amount
    );
  }

  humaProgramAuthority() {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('huma_program_authority')],
      this.program.programId
    )[0];
  }
}

export class HumaConfigContext {
  ctx: Context;
  id: Keypair;

  constructor(ctx: Context) {
    this.ctx = ctx;
    this.id = Keypair.generate();
  }

  async createHumaConfigAccount(
    protocolFeeBps: number,
    id: Keypair = Keypair.generate(),
    skipStore = false
  ) {
    const [humaConfigPDA] = PublicKey.findProgramAddressSync(
      [anchor.utils.bytes.utf8.encode('huma_config'), id.publicKey.toBuffer()],
      this.ctx.program.programId
    );
    const owner = this.humaOwner();
    const treasury = this.humaTreasury();
    const sentinel = this.sentinel();
    const tx = await this.ctx.program.methods
      .createHumaConfig(
        id.publicKey,
        treasury.publicKey,
        sentinel.publicKey,
        protocolFeeBps
      )
      .accountsPartial({
        owner: owner.publicKey,
        humaConfig: humaConfigPDA
      })
      .signers([owner])
      .rpc();

    if (!skipStore) {
      this.id = id;
      this.ctx.accounts.set(PDAKey.HUMA_CONFIG, humaConfigPDA);
    }

    return { tx, humaConfigPDA };
  }

  async addPauser(
    pauser: Keypair = this.ctx.walletAccounts[WalletAccountKey.PAUSER]
  ) {
    const pauserConfigPDA = await this.genPauserConfigPDA(pauser.publicKey);
    const owner = this.humaOwner();
    const tx = await this.ctx.program.methods
      .addPauser(pauser.publicKey)
      .accountsPartial({
        owner: owner.publicKey,
        humaConfig: this.humaConfigPDA(),
        pauserConfig: pauserConfigPDA
      })
      .signers([owner])
      .rpc();
    this.ctx.accounts.set(PDAKey.PAUSER_CONFIG, pauserConfigPDA);

    return tx;
  }

  async removePauser() {
    const owner = this.humaOwner();
    const pauser = this.pauser();

    const tx = await this.ctx.program.methods
      .removePauser(pauser.publicKey)
      .accountsPartial({
        owner: owner.publicKey,
        humaConfig: this.humaConfigPDA(),
        pauserConfig: this.pauserConfigPDA()
      })
      .signers([owner])
      .rpc();
    this.ctx.accounts.delete(PDAKey.PAUSER_CONFIG);

    return tx;
  }

  async addLiquidityAsset(mint?: web3.Keypair) {
    if (!mint) {
      mint = await this.ctx.createAssetMint();
    }

    const owner = this.humaOwner();
    const humaConfigPDA = this.humaConfigPDA();

    const liquidityAssetPDA = await this.genLiquidityAssetPDA(mint.publicKey);
    const tx = await this.ctx.program.methods
      .addLiquidityAsset()
      .accountsPartial({
        owner: owner.publicKey,
        humaConfig: humaConfigPDA,
        mint: mint.publicKey,
        liquidityAsset: liquidityAssetPDA
      })
      .signers([owner])
      .rpc();
    this.ctx.accounts.set(PDAKey.LIQUIDITY_ASSET, liquidityAssetPDA);
    this.ctx.setAssetMint(mint);

    return tx;
  }

  async removeLiquidityAsset() {
    const owner = this.humaOwner();
    const tx = await this.ctx.program.methods
      .removeLiquidityAsset()
      .accountsPartial({
        owner: owner.publicKey,
        humaConfig: this.humaConfigPDA(),
        mint: this.ctx.assetMint().publicKey,
        liquidityAsset: this.liquidityAssetPDA()
      })
      .signers([owner])
      .rpc();
    this.ctx.accounts.delete(PDAKey.LIQUIDITY_ASSET);

    return tx;
  }

  async pauseProtocol() {
    const pauser = this.pauser();
    return await this.ctx.program.methods
      .pauseProtocol()
      .accountsPartial({
        pauser: pauser.publicKey,
        humaConfig: this.humaConfigPDA(),
        pauserConfig: this.pauserConfigPDA()
      })
      .signers([pauser])
      .rpc();
  }

  async unpauseProtocol() {
    const owner = this.humaOwner();
    return await this.ctx.program.methods
      .unpauseProtocol()
      .accountsPartial({
        owner: owner.publicKey,
        humaConfig: this.humaConfigPDA()
      })
      .signers([owner])
      .rpc();
  }

  async updateHumaConfig(
    treasury: PublicKey,
    sentinel: PublicKey,
    protocolFeeBps: number
  ) {
    const owner = this.humaOwner();
    return await this.ctx.program.methods
      .updateHumaConfig(treasury, sentinel, protocolFeeBps)
      .accountsPartial({
        owner: owner.publicKey,
        humaConfig: this.humaConfigPDA()
      })
      .signers([owner])
      .rpc();
  }

  humaOwner() {
    return this.ctx.walletAccounts[WalletAccountKey.HUMA_OWNER];
  }

  humaTreasury() {
    return this.ctx.walletAccounts[WalletAccountKey.HUMA_TREASURY];
  }

  sentinel() {
    return this.ctx.walletAccounts[WalletAccountKey.SENTINEL];
  }

  humaConfigPDA() {
    return this.ctx.accounts.get(PDAKey.HUMA_CONFIG)!;
  }

  async humaConfig() {
    return this.ctx.program.account.humaConfig.fetch(this.humaConfigPDA());
  }

  pauser() {
    return this.ctx.walletAccounts[WalletAccountKey.PAUSER];
  }

  pauserConfigPDA() {
    return this.ctx.accounts.get(PDAKey.PAUSER_CONFIG)!;
  }

  async genPauserConfigPDA(pauserKey: web3.PublicKey) {
    const [pauserConfigPDA] = PublicKey.findProgramAddressSync(
      [
        anchor.utils.bytes.utf8.encode('pauser'),
        this.humaConfigPDA().toBuffer(),
        pauserKey.toBuffer()
      ],
      this.ctx.program.programId
    );
    return pauserConfigPDA;
  }

  liquidityAssetPDA() {
    return this.ctx.accounts.get(PDAKey.LIQUIDITY_ASSET)!;
  }

  async genLiquidityAssetPDA(mintKey: web3.PublicKey) {
    const [liquidityAssetPDA] = PublicKey.findProgramAddressSync(
      [
        anchor.utils.bytes.utf8.encode('liquidity_asset'),
        this.humaConfigPDA().toBuffer(),
        mintKey.toBuffer()
      ],
      this.ctx.program.programId
    );
    return liquidityAssetPDA;
  }
}

export interface PoolBasicData {
  poolName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tranchesPolicyType: any;
}

export type PoolSettings = {
  maxCreditLine: anchor.BN;
  minDepositAmount: anchor.BN;
  payPeriodDuration: PayPeriodDurationType;
  latePaymentGracePeriodDays: number;
  defaultGracePeriodDays: number;
  advanceRateBps: number;
  receivableAutoApproval: boolean;
  principalOnlyPaymentAllowed: boolean;
  creditType: CreditType;
};

export type LPConfig = {
  liquidityCap: anchor.BN;
  maxSeniorJuniorRatio: number;
  fixedSeniorYieldBps: number;
  tranchesRiskAdjustmentBps: number;
  withdrawalLockupPeriodDays: number;
};

export type AdminRnR = {
  rewardRateBpsForEa: number;
  rewardRateBpsForPoolOwner: number;
  liquidityRateBpsForEa: number;
  liquidityRateBpsForPoolOwner: number;
};

export interface AccruedIncomes {
  protocolIncome: BN;
  poolOwnerIncome: BN;
  eaIncome: BN;
}

export interface SeniorYieldTracker {
  totalAssets: anchor.BN;
  unpaidYield: anchor.BN;
  lastUpdatedDate: anchor.BN;
}

export class PoolContext {
  ctx: Context;
  id: Keypair;

  constructor(ctx: Context) {
    this.ctx = ctx;
    this.id = Keypair.generate();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async createPoolConfig(
    name: string,
    tranchesPolicy: any,
    id = Keypair.generate()
  ) {
    const [poolConfigPDA] = PublicKey.findProgramAddressSync(
      [anchor.utils.bytes.utf8.encode('pool_config'), id.publicKey.toBuffer()],
      this.ctx.program.programId
    );
    const [poolStatePDA] = PublicKey.findProgramAddressSync(
      [anchor.utils.bytes.utf8.encode('pool_state'), poolConfigPDA.toBuffer()],
      this.ctx.program.programId
    );
    const underlyingMintAddr = this.ctx.assetMint().publicKey;

    const [poolAuthorityPDA] = PublicKey.findProgramAddressSync(
      [
        anchor.utils.bytes.utf8.encode('pool_authority'),
        poolConfigPDA.toBuffer()
      ],
      this.ctx.program.programId
    );
    const poolUnderlyingTokenPDA = getAssociatedTokenAddressSync(
      underlyingMintAddr,
      poolAuthorityPDA,
      true,
      TOKEN_2022_PROGRAM_ID
    );

    const poolOwner = this.poolOwner();
    const poolOwnerTreasury = this.poolOwnerTreasury();
    const evaluationAgent = this.evaluationAgent();
    const tx = await this.ctx.program.methods
      .createPool(
        id.publicKey,
        name,
        poolOwnerTreasury.publicKey,
        evaluationAgent.publicKey,
        tranchesPolicy
      )
      .accountsPartial({
        owner: poolOwner.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        underlyingMint: underlyingMintAddr,
        liquidityAsset: this.ctx.humaConfigContext.liquidityAssetPDA(),
        poolConfig: poolConfigPDA,
        poolState: poolStatePDA,
        poolAuthority: poolAuthorityPDA,
        poolUnderlyingToken: poolUnderlyingTokenPDA,
        tokenProgram: TOKEN_2022_PROGRAM_ID
      })
      .signers([poolOwner])
      .rpc({ skipPreflight: true });
    this.ctx.accounts.set(PDAKey.POOL_CONFIG, poolConfigPDA);
    this.ctx.accounts.set(PDAKey.POOL_STATE, poolStatePDA);
    this.ctx.accounts.set(PDAKey.POOL_AUTHORITY, poolAuthorityPDA);
    this.ctx.accounts.set(PDAKey.POOL_UNDERLYING_TOKEN, poolUnderlyingTokenPDA);
    this.id = id;

    return tx;
  }

  async createPoolAccounts(isUniTranche = false) {
    const poolOwner = this.poolOwner();
    const poolConfigPDA = this.poolConfigPDA();
    const [poolAuthorityPDA] = PublicKey.findProgramAddressSync(
      [
        anchor.utils.bytes.utf8.encode('pool_authority'),
        poolConfigPDA.toBuffer()
      ],
      this.ctx.program.programId
    );
    const [juniorTrancheMintPDA] = PublicKey.findProgramAddressSync(
      [
        anchor.utils.bytes.utf8.encode('junior_tranche_mint'),
        poolConfigPDA.toBuffer()
      ],
      this.ctx.program.programId
    );
    const underlyingMintAddr = this.ctx.assetMint().publicKey;
    const poolJuniorTokenPDA = getAssociatedTokenAddressSync(
      juniorTrancheMintPDA,
      poolAuthorityPDA,
      true,
      TOKEN_2022_PROGRAM_ID
    );
    const [juniorTrancheStatePDA] = PublicKey.findProgramAddressSync(
      [
        anchor.utils.bytes.utf8.encode('tranche_state'),
        juniorTrancheMintPDA.toBuffer()
      ],
      this.ctx.program.programId
    );
    const remainingAccounts = [
      {
        pubkey: poolJuniorTokenPDA,
        isWritable: true,
        isSigner: false
      },
      {
        pubkey: juniorTrancheStatePDA,
        isWritable: true,
        isSigner: false
      }
    ];
    let seniorTrancheMintPDA = null;
    let poolSeniorTokenPDA = null;
    let seniorTrancheStatePDA = null;
    if (!isUniTranche) {
      [seniorTrancheMintPDA] = PublicKey.findProgramAddressSync(
        [
          anchor.utils.bytes.utf8.encode('senior_tranche_mint'),
          poolConfigPDA.toBuffer()
        ],
        this.ctx.program.programId
      );
      poolSeniorTokenPDA = getAssociatedTokenAddressSync(
        seniorTrancheMintPDA,
        poolAuthorityPDA,
        true,
        TOKEN_2022_PROGRAM_ID
      );
      [seniorTrancheStatePDA] = PublicKey.findProgramAddressSync(
        [
          anchor.utils.bytes.utf8.encode('tranche_state'),
          seniorTrancheMintPDA.toBuffer()
        ],
        this.ctx.program.programId
      );
      remainingAccounts.push({
        pubkey: poolSeniorTokenPDA,
        isWritable: true,
        isSigner: false
      });
      remainingAccounts.push({
        pubkey: seniorTrancheStatePDA,
        isWritable: true,
        isSigner: false
      });
    }
    const tx = await this.ctx.program.methods
      .createPoolAccounts()
      .accountsPartial({
        poolOwner: poolOwner.publicKey,
        underlyingMint: underlyingMintAddr,
        poolConfig: poolConfigPDA,
        poolAuthority: poolAuthorityPDA,
        seniorMint: seniorTrancheMintPDA,
        juniorMint: juniorTrancheMintPDA,
        tokenProgram: TOKEN_2022_PROGRAM_ID
      })
      .remainingAccounts(remainingAccounts)
      .signers([poolOwner])
      .rpc();

    this.ctx.accounts.set(PDAKey.JUNIOR_TRANCHE_MINT, juniorTrancheMintPDA);
    this.ctx.accounts.set(PDAKey.POOL_JUNIOR_TOKEN, poolJuniorTokenPDA);
    this.ctx.accounts.set(PDAKey.POOL_JUNIOR_STATE, juniorTrancheStatePDA);
    this.ctx.accounts.set(PDAKey.SENIOR_TRANCHE_MINT, seniorTrancheMintPDA);
    this.ctx.accounts.set(PDAKey.POOL_SENIOR_TOKEN, poolSeniorTokenPDA);
    this.ctx.accounts.set(PDAKey.POOL_SENIOR_STATE, seniorTrancheStatePDA);

    return tx;
  }

  async initPoolConfigByDefault() {
    await this.setPoolSettings({
      maxCreditLine: toToken(1_000_000_000),
      minDepositAmount: toToken(10),
      payPeriodDuration: PayPeriodDuration.Monthly,
      latePaymentGracePeriodDays: 5,
      defaultGracePeriodDays: 90,
      advanceRateBps: 8000,
      receivableAutoApproval: true,
      principalOnlyPaymentAllowed: true,
      creditType: Credit.CreditLine
    });
    await this.setLpConfig({
      liquidityCap: toToken(1_000_000_000),
      maxSeniorJuniorRatio: 4,
      fixedSeniorYieldBps: 0,
      tranchesRiskAdjustmentBps: 0,
      withdrawalLockupPeriodDays: 90
    });
    await this.setAdminRnR({
      rewardRateBpsForEa: 300,
      rewardRateBpsForPoolOwner: 200,
      liquidityRateBpsForEa: 200,
      liquidityRateBpsForPoolOwner: 200
    });
    await this.setFeeStructure({
      frontLoadingFeeFlat: toToken(0),
      frontLoadingFeeBps: 0,
      yieldBps: 0,
      lateFeeBps: 1000
    });
  }

  async enablePool(isUniTranche = false) {
    const poolOwner = this.poolOwner();
    let seniorTrancheMintPDA = null;
    let seniorStatePDA = null;
    let poolOwnerTreasurySeniorToken = null;
    let eaSeniorToken = null;
    if (!isUniTranche) {
      seniorTrancheMintPDA = this.seniorTrancheMintPDA();
      seniorStatePDA = this.seniorTrancheStatePDA();
      poolOwnerTreasurySeniorToken = this.getUserSeniorTrancheATA(
        this.poolOwnerTreasury().publicKey
      );
      eaSeniorToken = this.getUserSeniorTrancheATA(
        this.evaluationAgent().publicKey
      );
    }

    return await this.ctx.program.methods
      .enablePool()
      .accountsPartial({
        signer: poolOwner.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.poolConfigPDA(),
        poolOwnerTreasuryJuniorToken: this.getUserJuniorTrancheATA(
          this.poolOwnerTreasury().publicKey
        ),
        eaJuniorToken: this.getUserJuniorTrancheATA(
          this.evaluationAgent().publicKey
        ),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        seniorMint: seniorTrancheMintPDA,
        seniorState: seniorStatePDA,
        poolOwnerTreasurySeniorToken,
        eaSeniorToken
      })
      .signers([poolOwner])
      .rpc();
  }

  async disablePool() {
    const poolOperator = this.poolOperator();
    return await this.ctx.program.methods
      .disablePool()
      .accountsPartial({
        operator: poolOperator.publicKey,
        poolConfig: this.poolConfigPDA(),
        poolOperatorConfig: this.poolOperatorConfigPDA()
      })
      .signers([poolOperator])
      .rpc();
  }

  async closePool(hasSeniorTranche = true) {
    const poolOwner = this.poolOwner();

    let seniorMint = null;
    let seniorState = null;
    let poolSeniorToken = null;
    if (hasSeniorTranche) {
      seniorMint = this.seniorTrancheMintPDA();
      seniorState = this.seniorTrancheStatePDA();
      poolSeniorToken = this.ctx.poolContext.poolSeniorTokenPDA();
    }

    return await this.ctx.program.methods
      .closePool()
      .accountsPartial({
        signer: poolOwner.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.poolConfigPDA(),
        underlyingMint: this.ctx.assetMint().publicKey,
        poolUnderlyingToken: this.poolUnderlyingTokenPDA(),
        seniorMint,
        seniorState,
        poolSeniorToken,
        poolJuniorToken: this.poolJuniorTokenPDA(),
        tokenProgram: TOKEN_2022_PROGRAM_ID
      })
      .signers([poolOwner])
      .rpc();
  }

  async updatePoolBasicConfig(
    newData: Partial,
    signer: Keypair = this.poolOwner()
  ) {
    const poolConfig = await this.poolConfig();
    const poolBasicData = {
      ...{
        poolName: poolConfig.poolName,
        tranchesPolicyType: poolConfig.tranchesPolicyType
      },
      ...newData
    };

    return await this.ctx.program.methods
      .updatePoolBasicConfig(
        poolBasicData.poolName,
        poolBasicData.tranchesPolicyType
      )
      .accountsPartial({
        signer: signer.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.poolConfigPDA()
      })
      .signers([signer])
      .rpc();
  }

  async setPoolSettings(
    newPoolSettings: Partial,
    signer: Keypair = this.poolOwner()
  ) {
    const poolConfig = await this.poolConfig();
    const poolSettings = {
      ...poolConfig.poolSettings,
      ...newPoolSettings
    };

    return await this.ctx.program.methods
      .setPoolSettings(poolSettings)
      .accountsPartial({
        signer: signer.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.poolConfigPDA(),
        underlyingMint: this.ctx.assetMint().publicKey
      })
      .signers([signer])
      .rpc();
  }

  async setLpConfig(newLpConfig: Partial) {
    const poolConfig = await this.poolConfig();
    const lpConfig = {
      ...poolConfig.lpConfig,
      ...newLpConfig
    };

    const poolOwner = this.poolOwner();
    return await this.ctx.program.methods
      .setLpConfig(lpConfig)
      .accountsPartial({
        signer: poolOwner.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.poolConfigPDA(),
        poolState: this.poolStatePDA()
      })
      .signers([poolOwner])
      .rpc();
  }

  async setAdminRnR(newAdminRnR: Partial, signer: Keypair = this.poolOwner()) {
    const poolConfig = await this.poolConfig();
    const adminRnR = {
      ...poolConfig.adminRnr,
      ...newAdminRnR
    };

    return await this.ctx.program.methods
      .setAdminRnr(adminRnR)
      .accountsPartial({
        signer: signer.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.poolConfigPDA()
      })
      .signers([signer])
      .rpc();
  }

  async setFeeStructure(
    newFeeStructure: Partial,
    signer: Keypair = this.poolOwner()
  ) {
    const poolConfig = await this.poolConfig();
    const feeStructure = {
      ...poolConfig.feeStructure,
      ...newFeeStructure
    };

    return await this.ctx.program.methods
      .setFeeStructure(feeStructure)
      .accountsPartial({
        signer: signer.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.poolConfigPDA()
      })
      .signers([signer])
      .rpc();
  }

  async setPoolOwnerTreasury(
    newTreasury: Keypair,
    signer: Keypair = this.poolOwner()
  ) {
    return await this.ctx.program.methods
      .setPoolOwnerTreasury(newTreasury.publicKey)
      .accountsPartial({
        signer: signer.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.poolConfigPDA(),
        underlyingMint: this.ctx.assetMint().publicKey,
        newTreasuryJuniorToken: this.getUserJuniorTrancheATA(
          newTreasury.publicKey
        ),
        newTreasurySeniorToken: this.getUserSeniorTrancheATA(
          newTreasury.publicKey
        ),
        poolUnderlyingToken: this.poolUnderlyingTokenPDA(),
        poolOwnerTreasuryUnderlyingToken: this.ctx.getUserUnderlyingATA(
          this.poolOwnerTreasury().publicKey
        ),
        tokenProgram: TOKEN_2022_PROGRAM_ID
      })
      .signers([signer])
      .rpc();
  }

  async setEvaluationAgent(newEA: Keypair, signer: Keypair = this.poolOwner()) {
    return await this.ctx.program.methods
      .setEvaluationAgent(newEA.publicKey)
      .accountsPartial({
        signer: signer.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.poolConfigPDA(),
        underlyingMint: this.ctx.assetMint().publicKey,
        newEaJuniorToken: this.getUserJuniorTrancheATA(newEA.publicKey),
        poolUnderlyingToken: this.poolUnderlyingTokenPDA(),
        eaUnderlyingToken: this.ctx.getUserUnderlyingATA(
          this.evaluationAgent().publicKey
        ),
        tokenProgram: TOKEN_2022_PROGRAM_ID
      })
      .signers([signer])
      .rpc();
  }

  async withdrawProtocolFees(amount: anchor.BN) {
    const humaTreasury = this.ctx.humaConfigContext.humaTreasury();
    return await this.ctx.program.methods
      .withdrawProtocolFees(amount)
      .accountsPartial({
        signer: humaTreasury.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.poolConfigPDA(),
        poolState: this.ctx.poolContext.poolStatePDA(),
        poolAuthority: this.ctx.poolContext.poolAuthorityPDA(),
        underlyingMint: this.ctx.assetMint().publicKey,
        poolUnderlyingToken: this.ctx.poolContext.poolUnderlyingTokenPDA(),
        signerUnderlyingToken: this.ctx.getUserUnderlyingATA(
          humaTreasury.publicKey
        ),
        tokenProgram: TOKEN_2022_PROGRAM_ID
      })
      .signers([humaTreasury])
      .rpc();
  }

  async withdrawPoolOwnerFees(amount: anchor.BN) {
    const poolOwnerTreasury = this.poolOwnerTreasury();
    return await this.ctx.program.methods
      .withdrawPoolOwnerFees(amount)
      .accountsPartial({
        signer: poolOwnerTreasury.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.poolConfigPDA(),
        poolState: this.ctx.poolContext.poolStatePDA(),
        poolAuthority: this.ctx.poolContext.poolAuthorityPDA(),
        underlyingMint: this.ctx.assetMint().publicKey,
        poolUnderlyingToken: this.ctx.poolContext.poolUnderlyingTokenPDA(),
        signerUnderlyingToken: this.ctx.getUserUnderlyingATA(
          poolOwnerTreasury.publicKey
        ),
        tokenProgram: TOKEN_2022_PROGRAM_ID
      })
      .signers([poolOwnerTreasury])
      .rpc();
  }

  async withdrawEAFees(
    amount: anchor.BN,
    signer: Keypair = this.evaluationAgent()
  ) {
    const evaluationAgent = this.evaluationAgent();

    return await this.ctx.program.methods
      .withdrawEaFees(amount)
      .accountsPartial({
        signer: signer.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.poolConfigPDA(),
        poolState: this.ctx.poolContext.poolStatePDA(),
        poolAuthority: this.ctx.poolContext.poolAuthorityPDA(),
        underlyingMint: this.ctx.assetMint().publicKey,
        poolUnderlyingToken: this.ctx.poolContext.poolUnderlyingTokenPDA(),
        eaUnderlyingToken: this.ctx.getUserUnderlyingATA(
          evaluationAgent.publicKey
        ),
        tokenProgram: TOKEN_2022_PROGRAM_ID
      })
      .signers([signer])
      .rpc();
  }

  async closeEpoch(hasSeniorTranche = true) {
    let seniorMint = null;
    let seniorState = null;
    let poolSeniorToken = null;
    if (hasSeniorTranche) {
      seniorMint = this.seniorTrancheMintPDA();
      seniorState = this.seniorTrancheStatePDA();
      poolSeniorToken = this.ctx.poolContext.poolSeniorTokenPDA();
    }

    return await this.ctx.program.methods
      .closeEpoch()
      .accountsPartial({
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.poolConfigPDA(),
        underlyingMint: this.ctx.assetMint().publicKey,
        poolUnderlyingToken: this.poolUnderlyingTokenPDA(),
        seniorMint,
        seniorState,
        poolSeniorToken,
        poolJuniorToken: this.ctx.trancheVaultContext.trancheTokenPDA(
          this.juniorTrancheMintPDA()
        ),
        tokenProgram: TOKEN_2022_PROGRAM_ID
      })
      .rpc();
  }

  poolOwner() {
    return this.ctx.walletAccounts[WalletAccountKey.POOL_OWNER];
  }

  poolOwnerTreasury() {
    return this.ctx.walletAccounts[WalletAccountKey.POOL_TREASURY];
  }

  evaluationAgent() {
    return this.ctx.walletAccounts[WalletAccountKey.EVALUATION_AGENT];
  }

  poolAuthorityPDA() {
    return this.ctx.accounts.get(PDAKey.POOL_AUTHORITY)!;
  }

  poolConfigPDA() {
    return this.ctx.accounts.get(PDAKey.POOL_CONFIG)!;
  }

  poolStatePDA() {
    return this.ctx.accounts.get(PDAKey.POOL_STATE)!;
  }

  juniorTrancheStatePDA() {
    return this.ctx.accounts.get(PDAKey.POOL_JUNIOR_STATE)!;
  }

  seniorTrancheStatePDA() {
    return this.ctx.accounts.get(PDAKey.POOL_SENIOR_STATE)!;
  }

  async poolConfig() {
    return await this.ctx.program.account.poolConfig.fetch(
      this.poolConfigPDA()
    );
  }

  async poolState() {
    return await this.ctx.program.account.poolState.fetch(this.poolStatePDA());
  }

  async juniorTrancheState() {
    return await this.ctx.program.account.trancheState.fetch(
      this.juniorTrancheStatePDA()
    );
  }

  async seniorTrancheState() {
    return await this.ctx.program.account.trancheState.fetch(
      this.seniorTrancheStatePDA()
    );
  }

  poolUnderlyingTokenPDA() {
    return this.ctx.accounts.get(PDAKey.POOL_UNDERLYING_TOKEN)!;
  }

  poolJuniorTokenPDA() {
    return this.ctx.accounts.get(PDAKey.POOL_JUNIOR_TOKEN)!;
  }

  poolSeniorTokenPDA() {
    return this.ctx.accounts.get(PDAKey.POOL_SENIOR_TOKEN)!;
  }

  seniorTrancheMintPDA() {
    return this.ctx.accounts.get(PDAKey.SENIOR_TRANCHE_MINT)!;
  }

  async seniorTrancheMint() {
    return await this.getTrancheMint(this.seniorTrancheMintPDA());
  }

  juniorTrancheMintPDA() {
    return this.ctx.accounts.get(PDAKey.JUNIOR_TRANCHE_MINT)!;
  }

  async getTrancheMint(trancheMintPDA: PublicKey) {
    const info =
      await this.ctx.provider.context.banksClient.getAccount(trancheMintPDA);

    return unpackMint(
      trancheMintPDA,
      {
        ...info,
        data: Buffer.from(info!.data)
      } as AccountInfo,
      TOKEN_2022_PROGRAM_ID
    );
  }

  async juniorTrancheMint() {
    return await this.getTrancheMint(this.juniorTrancheMintPDA());
  }

  async addPoolOperator(poolOperator: Keypair = this.poolOperator()) {
    const poolOwner = this.poolOwner();
    const poolConfigPDA = this.poolConfigPDA();
    const [poolOperatorConfigPDA] = PublicKey.findProgramAddressSync(
      [
        anchor.utils.bytes.utf8.encode('pool_operator'),
        poolConfigPDA.toBuffer(),
        poolOperator.publicKey.toBuffer()
      ],
      this.ctx.program.programId
    );

    const tx = await this.ctx.program.methods
      .addPoolOperator(poolOperator.publicKey)
      .accountsPartial({
        poolOwner: poolOwner.publicKey,
        poolConfig: poolConfigPDA,
        poolOperatorConfig: poolOperatorConfigPDA
      })
      .signers([poolOwner])
      .rpc();
    this.ctx.accounts.set(PDAKey.POOL_OPERATOR_CONFIG, poolOperatorConfigPDA);

    return tx;
  }

  async mockDistributeProfit(profit: anchor.BN) {
    return await this.ctx.program.methods
      .mockDistributeProfit(profit)
      .accountsPartial({
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        poolState: this.ctx.poolContext.poolStatePDA()
      })
      .rpc();
  }

  async mockDistributeLoss(loss: anchor.BN) {
    return await this.ctx.program.methods
      .mockDistributeLoss(loss)
      .accountsPartial({
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        poolState: this.ctx.poolContext.poolStatePDA()
      })
      .rpc();
  }

  async mockDistributeLossRecovery(lossRecovery: anchor.BN) {
    return await this.ctx.program.methods
      .mockDistributeLossRecovery(lossRecovery)
      .accountsPartial({
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        poolState: this.ctx.poolContext.poolStatePDA()
      })
      .rpc();
  }

  async mockDistributePnL(
    profit: anchor.BN,
    loss: anchor.BN,
    lossRecovery: anchor.BN
  ) {
    await this.mockDistributeProfit(profit);
    await this.mockDistributeLoss(loss);
    await this.mockDistributeLossRecovery(lossRecovery);
  }

  async mockDistributeProfitToTranches(profit: anchor.BN) {
    return await this.ctx.program.methods
      .mockDistributeProfitToTranches(profit)
      .accountsPartial({
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        poolState: this.ctx.poolContext.poolStatePDA()
      })
      .rpc();
  }

  async removeAssetsFromPool(amount: anchor.BN) {
    const borrower = this.ctx.humaConfigContext.sentinel();
    await this.ctx.creditContext.drawdown(borrower, amount);
  }

  async moveAssetsIntoPool(amount: anchor.BN) {
    await mintTo(
      this.ctx.provider.context,
      this.ctx.assetMint().publicKey,
      this.ctx.humaConfigContext.humaOwner(),
      this.poolUnderlyingTokenPDA(),
      BigInt(amount.toString())
    );
  }

  poolOperator() {
    return this.ctx.walletAccounts[WalletAccountKey.POOL_OPERATOR];
  }

  poolOperatorConfigPDA() {
    return this.ctx.accounts.get(PDAKey.POOL_OPERATOR_CONFIG)!;
  }

  getUserJuniorTrancheATA(user: PublicKey) {
    return getAssociatedTokenAddressSync(
      this.juniorTrancheMintPDA(),
      user,
      false,
      TOKEN_2022_PROGRAM_ID
    );
  }

  getUserSeniorTrancheATA(user: PublicKey) {
    return getAssociatedTokenAddressSync(
      this.seniorTrancheMintPDA(),
      user,
      false,
      TOKEN_2022_PROGRAM_ID
    );
  }

  async getMinLiquidityRequirementsForPoolOwner(tranche: number) {
    const poolConfig = await this.poolConfig();
    const lpConfig = poolConfig.lpConfig;
    const poolSettings = poolConfig.poolSettings;
    if (tranche === CONSTANTS.JUNIOR_TRANCHE) {
      const minRelativeBalance = lpConfig.liquidityCap
        .mul(new anchor.BN(poolConfig.adminRnr.liquidityRateBpsForPoolOwner))
        .div(CONSTANTS.HUNDRED_PERCENT_BPS);
      return anchor.BN.max(minRelativeBalance, poolSettings.minDepositAmount);
    } else {
      assert(tranche === CONSTANTS.SENIOR_TRANCHE);

      return poolConfig.lpConfig.maxSeniorJuniorRatio === 0
        ? toToken(0)
        : poolSettings.minDepositAmount;
    }
  }

  async getMinLiquidityRequirementsForEA(tranche: number) {
    const poolConfig = await this.poolConfig();
    if (tranche === CONSTANTS.JUNIOR_TRANCHE) {
      const minRelativeBalance = poolConfig.lpConfig.liquidityCap
        .mul(new anchor.BN(poolConfig.adminRnr.liquidityRateBpsForEa))
        .div(CONSTANTS.HUNDRED_PERCENT_BPS);
      return anchor.BN.max(
        minRelativeBalance,
        poolConfig.poolSettings.minDepositAmount
      );
    } else {
      assert(tranche === CONSTANTS.SENIOR_TRANCHE);

      return new anchor.BN(0);
    }
  }

  async getTrancheSupply(trancheMintPDA: PublicKey): Promise {
    return convertToBN((await this.getTrancheMint(trancheMintPDA)).supply);
  }

  async availableAdminFees() {
    const poolState = await this.poolState();
    const totalIncomeAccrued = poolState.accruedIncomes.protocolIncome
      .add(poolState.accruedIncomes.poolOwnerIncome)
      .add(poolState.accruedIncomes.eaIncome);
    const totalIncomeWithdrawn =
      poolState.incomeWithdrawn.protocolIncomeWithdrawn
        .add(poolState.incomeWithdrawn.poolOwnerIncomeWithdrawn)
        .add(poolState.incomeWithdrawn.eaIncomeWithdrawn);
    return totalIncomeAccrued.sub(totalIncomeWithdrawn);
  }

  async getPoolAvailableUnderlyingBalance() {
    const totalBalance = await this.ctx.getPoolUnderlyingBalance();
    const adminFees = await this.availableAdminFees();
    const poolState = await this.poolState();
    return totalBalance.sub(adminFees).sub(poolState.disbursementReserve);
  }
}

export class TrancheVaultContext {
  ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  async makeInitialDeposit(
    depositor: Keypair,
    trancheAddr: PublicKey,
    amount: anchor.BN
  ) {
    const underlyingMintAddr = this.ctx.assetMint().publicKey;
    const depositUnderlyingATA = this.ctx.getUserUnderlyingATA(
      depositor.publicKey
    );
    const depositorAccountTrancheATA = getAssociatedTokenAddressSync(
      trancheAddr,
      depositor.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    return await this.ctx.program.methods
      .makeInitialDeposit(amount)
      .accountsPartial({
        depositor: depositor.publicKey,
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        underlyingMint: underlyingMintAddr,
        trancheMint: trancheAddr,
        poolAuthority: this.ctx.poolContext.poolAuthorityPDA(),
        poolUnderlyingToken: this.ctx.poolContext.poolUnderlyingTokenPDA(),
        depositorUnderlyingToken: depositUnderlyingATA,
        depositorTrancheToken: depositorAccountTrancheATA,
        tokenProgram: TOKEN_2022_PROGRAM_ID
      })
      .signers([depositor])
      .rpc();
  }

  async addApprovedLender(
    lender: PublicKey,
    trancheMint: PublicKey,
    poolOperator?: Keypair
  ) {
    if (!poolOperator) {
      poolOperator = this.ctx.poolContext.poolOperator();
    }
    const poolConfigPDA = this.ctx.poolContext.poolConfigPDA();
    const [poolOperatorConfigPDA] = PublicKey.findProgramAddressSync(
      [
        anchor.utils.bytes.utf8.encode('pool_operator'),
        poolConfigPDA.toBuffer(),
        poolOperator.publicKey.toBuffer()
      ],
      this.ctx.program.programId
    );
    const [, lenderTrancheTokenPDA] =
      this.ctx.transferHookContext.approvedDestinationPDA(trancheMint, lender);
    return await this.ctx.program.methods
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
          pubkey: lenderTrancheTokenPDA,
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
            this.ctx.program.programId
          )[0],
          isWritable: true,
          isSigner: false
        }
      ])
      .signers([poolOperator])
      .rpc();
  }

  async removeApprovedLender(
    lender: PublicKey,
    trancheMint: PublicKey,
    poolOperator?: Keypair
  ) {
    if (!poolOperator) {
      poolOperator = this.ctx.poolContext.poolOperator();
    }
    const poolConfigPDA = this.ctx.poolContext.poolConfigPDA();
    const [poolOperatorConfigPDA] = PublicKey.findProgramAddressSync(
      [
        anchor.utils.bytes.utf8.encode('pool_operator'),
        poolConfigPDA.toBuffer(),
        poolOperator.publicKey.toBuffer()
      ],
      this.ctx.program.programId
    );

    return await this.ctx.program.methods
      .removeApprovedLender(lender)
      .accountsPartial({
        poolOperator: poolOperator.publicKey,
        poolConfig: poolConfigPDA,
        poolOperatorConfig: poolOperatorConfigPDA,
        trancheMint
      })
      .signers([poolOperator])
      .rpc();
  }

  async createLenderAccounts(lender: Keypair, trancheMint: PublicKey) {
    return await this.ctx.program.methods
      .createLenderAccounts()
      .accountsPartial({
        lender: lender.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        approvedLender: this.approvedLenderPDA(lender.publicKey, trancheMint),
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

  async deposit(depositor: Keypair, trancheMint: PublicKey, amount: anchor.BN) {
    const underlyingMintAddr = this.ctx.assetMint().publicKey;
    const depositUnderlyingATA = this.ctx.getUserUnderlyingATA(
      depositor.publicKey
    );
    const depositorAccountTrancheATA = getAssociatedTokenAddressSync(
      trancheMint,
      depositor.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    return await this.ctx.program.methods
      .deposit(amount)
      .accountsPartial({
        depositor: depositor.publicKey,
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        underlyingMint: underlyingMintAddr,
        trancheMint: trancheMint,
        poolUnderlyingToken: this.ctx.poolContext.poolUnderlyingTokenPDA(),
        depositorUnderlyingToken: depositUnderlyingATA,
        depositorTrancheToken: depositorAccountTrancheATA,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        tokenProgram: TOKEN_2022_PROGRAM_ID
      })
      .signers([depositor])
      .rpc();
  }

  async addRedemptionRequest(
    lender: Keypair,
    trancheAddr: PublicKey,
    shares: anchor.BN
  ) {
    const poolAuthority = this.ctx.poolContext.poolAuthorityPDA();
    const [, poolTrancheToken] =
      this.ctx.transferHookContext.approvedDestinationPDA(
        trancheAddr,
        poolAuthority,
        true
      );
    return await this.ctx.program.methods
      .addRedemptionRequest(shares)
      .accountsPartial({
        lender: lender.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        trancheMint: trancheAddr,
        poolTrancheToken,
        lenderTrancheToken: getAssociatedTokenAddressSync(
          trancheAddr,
          lender.publicKey,
          false,
          TOKEN_2022_PROGRAM_ID
        ),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        poolAuthority: this.ctx.poolContext.poolAuthorityPDA(),
        hookProgram: this.ctx.transferHookProgram.programId,
        extraAccountMetaList:
          this.ctx.transferHookContext.extraAccountMetaListPDA(trancheAddr)
      })
      .signers([lender])
      .rpc();
  }

  async cancelRedemptionRequest(
    lender: Keypair,
    trancheAddr: PublicKey,
    shares: anchor.BN
  ) {
    const [, lenderTrancheToken] =
      this.ctx.transferHookContext.approvedDestinationPDA(
        trancheAddr,
        lender.publicKey
      );
    return await this.ctx.program.methods
      .cancelRedemptionRequest(shares)
      .accountsPartial({
        lender: lender.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        trancheMint: trancheAddr,
        poolTrancheToken: getAssociatedTokenAddressSync(
          trancheAddr,
          this.ctx.poolContext.poolAuthorityPDA(),
          true,
          TOKEN_2022_PROGRAM_ID
        ),
        lenderTrancheToken,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        poolAuthority: this.ctx.poolContext.poolAuthorityPDA(),
        hookProgram: this.ctx.transferHookProgram.programId,
        extraAccountMetaList:
          this.ctx.transferHookContext.extraAccountMetaListPDA(trancheAddr)
      })
      .signers([lender])
      .rpc();
  }

  async disburse(lender: Keypair, trancheAddr: PublicKey) {
    const underlyingMintAddr = this.ctx.assetMint().publicKey;
    return await this.ctx.program.methods
      .disburse()
      .accountsPartial({
        lender: lender.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        underlyingMint: underlyingMintAddr,
        trancheMint: trancheAddr,
        poolUnderlyingToken: this.ctx.poolContext.poolUnderlyingTokenPDA(),
        lenderUnderlyingToken: getAssociatedTokenAddressSync(
          underlyingMintAddr,
          lender.publicKey,
          false,
          TOKEN_2022_PROGRAM_ID
        ),
        tokenProgram: TOKEN_2022_PROGRAM_ID
      })
      .signers([lender])
      .rpc();
  }

  async updateToLatestRedemptionRecord(lender: PublicKey, tranche: PublicKey) {
    return await this.ctx.program.methods
      .updateToLatestRedemptionRecord(lender)
      .accountsPartial({
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        trancheMint: tranche
      })
      .rpc();
  }

  async withdrawAfterPoolClosure(lender: Keypair, trancheAddr: PublicKey) {
    const underlyingMintAddr = this.ctx.assetMint().publicKey;
    return await this.ctx.program.methods
      .withdrawAfterPoolClosure()
      .accountsPartial({
        lender: lender.publicKey,
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        underlyingMint: underlyingMintAddr,
        trancheMint: trancheAddr,
        poolUnderlyingToken: this.ctx.poolContext.poolUnderlyingTokenPDA(),
        lenderUnderlyingToken: getAssociatedTokenAddressSync(
          underlyingMintAddr,
          lender.publicKey,
          false,
          TOKEN_2022_PROGRAM_ID
        ),
        lenderTrancheToken: getAssociatedTokenAddressSync(
          trancheAddr,
          lender.publicKey,
          false,
          TOKEN_2022_PROGRAM_ID
        ),
        tokenProgram: TOKEN_2022_PROGRAM_ID
      })
      .signers([lender])
      .rpc();
  }

  async closeLenderAccounts(lender: Keypair, trancheMint: PublicKey) {
    return await this.ctx.program.methods
      .closeLenderAccounts()
      .accountsPartial({
        lender: lender.publicKey,
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
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

  approvedLenderPDA(lender: PublicKey, trancheMint: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [
        anchor.utils.bytes.utf8.encode('approved_lender'),
        trancheMint.toBuffer(),
        lender.toBuffer()
      ],
      this.ctx.program.programId
    )[0];
  }

  trancheTokenPDA(trancheMint: PublicKey) {
    return getAssociatedTokenAddressSync(
      trancheMint,
      this.ctx.poolContext.poolAuthorityPDA(),
      true,
      TOKEN_2022_PROGRAM_ID
    );
  }

  async getTrancheBalanceOf(tranche: PublicKey, user: PublicKey): Promise {
    return convertToBN(
      (
        await getTokenAccount(
          this.ctx,
          getAssociatedTokenAddressSync(
            tranche,
            user,
            false,
            TOKEN_2022_PROGRAM_ID
          )
        )
      ).amount
    );
  }

  async getTrancheAssetsOf(tranche: PublicKey, user: Keypair): Promise {
    const balance = await this.getTrancheBalanceOf(tranche, user.publicKey);
    return await this.convertToAssets(tranche, balance);
  }

  async getLenderState(tranche: PublicKey, lender: PublicKey) {
    return await this.ctx.program.account.lenderState.fetch(
      PublicKey.findProgramAddressSync(
        [
          anchor.utils.bytes.utf8.encode('lender_state'),
          tranche.toBuffer(),
          lender.toBuffer()
        ],
        this.ctx.program.programId
      )[0]
    );
  }

  async withdrawableAssets(tranche: PublicKey, lender: Keypair) {
    const lenderState = await this.getLenderState(tranche, lender.publicKey);
    return lenderState.redemptionRecord.totalAmountProcessed.sub(
      lenderState.redemptionRecord.totalAmountWithdrawn
    );
  }

  async getRedemptionSummary(tranche: PublicKey, epoch_id: anchor.BN) {
    const trancheStatePDA = PublicKey.findProgramAddressSync(
      [anchor.utils.bytes.utf8.encode('tranche_state'), tranche.toBuffer()],
      this.ctx.program.programId
    )[0];
    const items = (
      await this.ctx.program.account.trancheState.fetch(trancheStatePDA)
    ).epochRedemptionSummaries;
    let item = items.find((item) => item.epochId.eq(epoch_id));
    if (!item) {
      item = {
        epochId: new anchor.BN(0),
        totalSharesRequested: new anchor.BN(0),
        totalSharesProcessed: new anchor.BN(0),
        totalAmountProcessed: new anchor.BN(0)
      };
    }
    return item;
  }

  async convertToShares(tranche: PublicKey, assets: BN): Promise {
    const poolState = await this.ctx.poolContext.poolState();
    const index = poolState.trancheAddrs.addrs.findIndex((addr) =>
      addr?.equals(tranche)
    );
    const totalAssets = poolState.trancheAssets.assets[index];
    const totalSupply = await this.ctx.poolContext.getTrancheSupply(tranche);
    return totalSupply.isZero()
      ? assets
      : assets.mul(totalSupply).div(totalAssets);
  }

  async convertToAssets(tranche: PublicKey, shares: BN) {
    const poolState = await this.ctx.poolContext.poolState();
    const index = poolState.trancheAddrs.addrs.findIndex((addr) =>
      addr?.equals(tranche)
    );
    const totalAssets = poolState.trancheAssets.assets[index];
    const totalSupply = await this.ctx.poolContext.getTrancheSupply(tranche);
    return totalSupply.isZero()
      ? shares
      : shares.mul(totalAssets).div(totalSupply);
  }
}

export class CreditContext {
  ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  async drawdown(borrower: Keypair, amount: anchor.BN) {
    return await this.ctx.program.methods
      .drawdown(amount)
      .accountsPartial({
        borrower: borrower.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        poolState: this.ctx.poolContext.poolStatePDA(),
        creditConfig: this.ctx.creditContext.creditConfigPDA(borrower),
        creditState: this.ctx.creditContext.creditStatePDA(borrower),
        poolAuthority: this.ctx.poolContext.poolAuthorityPDA(),
        underlyingMint: this.ctx.assetMint().publicKey,
        poolUnderlyingToken: this.ctx.poolContext.poolUnderlyingTokenPDA(),
        borrowerUnderlyingToken: this.ctx.getUserUnderlyingATA(
          borrower.publicKey
        ),
        tokenProgram: TOKEN_2022_PROGRAM_ID
      })
      .signers([borrower])
      .rpc();
  }

  async makePayment(
    borrower: Keypair,
    amount: anchor.BN,
    signer: Keypair = borrower
  ) {
    return await this.ctx.program.methods
      .makePayment(amount)
      .accountsPartial({
        signer: signer.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        poolState: this.ctx.poolContext.poolStatePDA(),
        creditConfig: this.ctx.creditContext.creditConfigPDA(borrower),
        creditState: this.ctx.creditContext.creditStatePDA(borrower),
        poolAuthority: this.ctx.poolContext.poolAuthorityPDA(),
        underlyingMint: this.ctx.assetMint().publicKey,
        poolUnderlyingToken: this.ctx.poolContext.poolUnderlyingTokenPDA(),
        borrowerUnderlyingToken: this.ctx.getUserUnderlyingATA(
          borrower.publicKey
        ),
        tokenProgram: TOKEN_2022_PROGRAM_ID
      })
      .signers([signer])
      .rpc();
  }

  async makePrincipalPayment(borrower: Keypair, amount: anchor.BN) {
    return await this.ctx.program.methods
      .makePrincipalPayment(amount)
      .accountsPartial({
        borrower: borrower.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        poolState: this.ctx.poolContext.poolStatePDA(),
        creditConfig: this.ctx.creditContext.creditConfigPDA(borrower),
        creditState: this.ctx.creditContext.creditStatePDA(borrower),
        poolAuthority: this.ctx.poolContext.poolAuthorityPDA(),
        underlyingMint: this.ctx.assetMint().publicKey,
        poolUnderlyingToken: this.ctx.poolContext.poolUnderlyingTokenPDA(),
        borrowerUnderlyingToken: this.ctx.getUserUnderlyingATA(
          borrower.publicKey
        ),
        tokenProgram: TOKEN_2022_PROGRAM_ID
      })
      .signers([borrower])
      .rpc();
  }

  async approveCredit(
    borrower: Keypair = this.ctx.borrower(),
    creditLimit: anchor.BN = toToken(10_000),
    numPeriods = 1,
    yieldBps = 1217,
    committedAmount: anchor.BN = toToken(10_000),
    designatedStartDate: anchor.BN = new anchor.BN(0),
    resolving = true
  ) {
    const evaluationAgent = this.ctx.poolContext.evaluationAgent();

    await this.ctx.program.methods
      .approveCredit(
        borrower.publicKey,
        creditLimit,
        numPeriods,
        yieldBps,
        committedAmount,
        designatedStartDate,
        resolving
      )
      .accountsPartial({
        evaluationAgent: evaluationAgent.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.ctx.poolContext.poolConfigPDA()
      })
      .signers([evaluationAgent])
      .rpc();
  }

  async startCommittedCredit(
    borrower: Keypair,
    signer: Keypair = this.ctx.poolContext.evaluationAgent()
  ) {
    return await this.ctx.program.methods
      .startCommittedCredit()
      .accountsPartial({
        signer: signer.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        poolState: this.ctx.poolContext.poolStatePDA(),
        creditConfig: this.ctx.creditContext.creditConfigPDA(borrower),
        creditState: this.ctx.creditContext.creditStatePDA(borrower)
      })
      .signers([signer])
      .rpc();
  }

  async refreshCredit(borrower: Keypair) {
    return await this.ctx.program.methods
      .refreshCredit()
      .accountsPartial({
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        poolState: this.ctx.poolContext.poolStatePDA(),
        creditConfig: this.ctx.creditContext.creditConfigPDA(borrower),
        creditState: this.ctx.creditContext.creditStatePDA(borrower)
      })
      .rpc();
  }

  async extendRemainingPeriods(borrower: Keypair, numPeriods: number) {
    const evaluationAgent = this.ctx.poolContext.evaluationAgent();

    return await this.ctx.program.methods
      .extendRemainingPeriods(numPeriods)
      .accountsPartial({
        evaluationAgent: evaluationAgent.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        poolState: this.ctx.poolContext.poolStatePDA(),
        creditConfig: this.ctx.creditContext.creditConfigPDA(borrower),
        creditState: this.ctx.creditContext.creditStatePDA(borrower)
      })
      .signers([evaluationAgent])
      .rpc();
  }

  async updateLimitAndCommitment(
    borrower: Keypair,
    creditLimit: anchor.BN,
    committedAmount: anchor.BN
  ) {
    const evaluationAgent = this.ctx.poolContext.evaluationAgent();

    return await this.ctx.program.methods
      .updateLimitAndCommitment(creditLimit, committedAmount)
      .accountsPartial({
        evaluationAgent: evaluationAgent.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        poolState: this.ctx.poolContext.poolStatePDA(),
        creditConfig: this.ctx.creditContext.creditConfigPDA(borrower),
        creditState: this.ctx.creditContext.creditStatePDA(borrower)
      })
      .signers([evaluationAgent])
      .rpc();
  }

  async updateYield(borrower: Keypair, newYieldBps: number) {
    const evaluationAgent = this.ctx.poolContext.evaluationAgent();

    return await this.ctx.program.methods
      .updateYield(newYieldBps)
      .accountsPartial({
        evaluationAgent: evaluationAgent.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        poolState: this.ctx.poolContext.poolStatePDA(),
        creditConfig: this.ctx.creditContext.creditConfigPDA(borrower),
        creditState: this.ctx.creditContext.creditStatePDA(borrower)
      })
      .signers([evaluationAgent])
      .rpc();
  }

  async waiveLateFee(borrower: Keypair, amount: anchor.BN) {
    const evaluationAgent = this.ctx.poolContext.evaluationAgent();

    return await this.ctx.program.methods
      .waiveLateFee(amount)
      .accountsPartial({
        evaluationAgent: evaluationAgent.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        poolState: this.ctx.poolContext.poolStatePDA(),
        creditConfig: this.ctx.creditContext.creditConfigPDA(borrower),
        creditState: this.ctx.creditContext.creditStatePDA(borrower)
      })
      .signers([evaluationAgent])
      .rpc();
  }

  async triggerDefault(borrower: Keypair) {
    const evaluationAgent = this.ctx.poolContext.evaluationAgent();

    return await this.ctx.program.methods
      .triggerDefault()
      .accountsPartial({
        evaluationAgent: evaluationAgent.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        poolState: this.ctx.poolContext.poolStatePDA(),
        creditConfig: this.ctx.creditContext.creditConfigPDA(borrower),
        creditState: this.ctx.creditContext.creditStatePDA(borrower)
      })
      .signers([evaluationAgent])
      .rpc();
  }

  async closeCredit(
    borrower: Keypair,
    signer: Keypair = this.ctx.poolContext.evaluationAgent()
  ) {
    return await this.ctx.program.methods
      .closeCredit()
      .accountsPartial({
        signer: signer.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        poolState: this.ctx.poolContext.poolStatePDA(),
        creditConfig: this.ctx.creditContext.creditConfigPDA(borrower),
        creditState: this.ctx.creditContext.creditStatePDA(borrower)
      })
      .signers([signer])
      .rpc();
  }

  async createReceivable(
    owner: Keypair,
    args: CreateReceivableArgs,
    asset: Keypair = Keypair.generate()
  ) {
    const receivableReferencePDA = this.receivableReferencePDA(
      owner,
      args.referenceId
    );
    const remainingAccounts = [
      {
        pubkey: receivableReferencePDA,
        isWritable: true,
        isSigner: false
      }
    ];
    return await this.ctx.program.methods
      .createReceivable(args)
      .accountsPartial({
        asset: asset.publicKey,
        owner: owner.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        poolState: this.ctx.poolContext.poolStatePDA(),
        mplCore: MPL_CORE_PROGRAM_ID,
        logWrapper: null
      })
      .remainingAccounts(remainingAccounts)
      .signers([asset, owner])
      .rpc();
  }

  async declarePayment(
    owner: Keypair,
    paymentAmount: BN,
    assetAddr: Keypair,
    authority: Keypair = owner
  ) {
    return await this.ctx.program.methods
      .declarePayment(paymentAmount)
      .accountsPartial({
        authority: authority.publicKey,
        asset: assetAddr.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        poolState: this.ctx.poolContext.poolStatePDA(),
        mplCore: MPL_CORE_PROGRAM_ID,
        logWrapper: null
      })
      .signers([authority])
      .rpc();
  }

  async updateReceivableMetadataURI(
    authority: Keypair,
    uri: string,
    assetAddr: Keypair
  ) {
    return await this.ctx.program.methods
      .updateReceivableMetadataUri(uri)
      .accountsPartial({
        authority: authority.publicKey,
        asset: assetAddr.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        poolState: this.ctx.poolContext.poolStatePDA(),
        mplCore: MPL_CORE_PROGRAM_ID,
        logWrapper: null
      })
      .signers([authority])
      .rpc();
  }

  async approveReceivable(borrower: Keypair, assetAddr: Keypair) {
    const evaluationAgent = this.ctx.poolContext.evaluationAgent();

    return await this.ctx.program.methods
      .approveReceivable()
      .accountsPartial({
        evaluationAgent: evaluationAgent.publicKey,
        asset: assetAddr.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        poolState: this.ctx.poolContext.poolStatePDA(),
        creditConfig: this.ctx.creditContext.creditConfigPDA(borrower),
        creditState: this.ctx.creditContext.creditStatePDA(borrower),
        receivableInfo: this.ctx.creditContext.receivableInfoPDA(
          assetAddr.publicKey
        ),
        mplCore: MPL_CORE_PROGRAM_ID,
        logWrapper: null
      })
      .signers([evaluationAgent])
      .rpc();
  }

  async submitReceivable(borrower: Keypair, assetAddr: Keypair) {
    return await this.ctx.program.methods
      .submitReceivable()
      .accountsPartial({
        borrower: borrower.publicKey,
        asset: assetAddr.publicKey,
        humaConfig: this.ctx.humaConfigContext.humaConfigPDA(),
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        poolState: this.ctx.poolContext.poolStatePDA(),
        creditConfig: this.ctx.creditContext.creditConfigPDA(borrower),
        creditState: this.ctx.creditContext.creditStatePDA(borrower),
        mplCore: MPL_CORE_PROGRAM_ID,
        logWrapper: null
      })
      .signers([borrower])
      .rpc();
  }

  creditConfigPDA(borrower: Keypair) {
    return PublicKey.findProgramAddressSync(
      [
        anchor.utils.bytes.utf8.encode('credit_config'),
        this.ctx.poolContext.poolConfigPDA().toBuffer(),
        borrower.publicKey.toBuffer()
      ],
      this.ctx.program.programId
    )[0];
  }

  creditStatePDA(borrower: Keypair) {
    return PublicKey.findProgramAddressSync(
      [
        anchor.utils.bytes.utf8.encode('credit_state'),
        this.ctx.poolContext.poolConfigPDA().toBuffer(),
        borrower.publicKey.toBuffer()
      ],
      this.ctx.program.programId
    )[0];
  }

  receivableInfoPDA(asset: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [anchor.utils.bytes.utf8.encode('receivable_info'), asset.toBuffer()],
      this.ctx.program.programId
    )[0];
  }

  receivableReferencePDA(owner: Keypair, referenceId: string) {
    const referenceIdHash = crypto
      .createHash('sha256')
      .update(referenceId)
      .digest('hex');
    const referenceIdSeed = Buffer.from(referenceIdHash, 'hex');
    return PublicKey.findProgramAddressSync(
      [
        anchor.utils.bytes.utf8.encode('receivable_reference'),
        owner.publicKey.toBuffer(),
        referenceIdSeed
      ],
      this.ctx.program.programId
    )[0];
  }

  async creditConfig(borrower: Keypair) {
    return await this.ctx.program.account.creditConfig.fetch(
      this.creditConfigPDA(borrower)
    );
  }

  async creditState(borrower: Keypair) {
    return await this.ctx.program.account.creditState.fetch(
      this.creditStatePDA(borrower)
    );
  }

  async creditRecord(borrower: Keypair) {
    return (await this.creditState(borrower)).creditRecord;
  }

  async dueDetail(borrower: Keypair) {
    return (await this.creditState(borrower)).dueDetail;
  }
}

export class TransferHookContext {
  ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  async initializeExtraAccountMetaList(trancheMint: PublicKey) {
    const [extraAccountMetaListPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('extra-account-metas'), trancheMint.toBuffer()],
      this.ctx.transferHookProgram.programId
    );
    const poolOwner = this.ctx.poolContext.poolOwner();
    return await this.ctx.program.methods
      .initializeExtraAccountMetaList()
      .accountsPartial({
        poolOwner: poolOwner.publicKey,
        humaProgramAuthority: this.ctx.humaProgramAuthority(),
        poolConfig: this.ctx.poolContext.poolConfigPDA(),
        poolState: this.ctx.poolContext.poolStatePDA(),
        hookProgram: this.ctx.transferHookProgram.programId,
        poolAuthority: this.ctx.poolContext.poolAuthorityPDA(),
        extraAccountMetaList: extraAccountMetaListPDA,
        trancheMint,
        tokenProgram: TOKEN_2022_PROGRAM_ID
      })
      .signers([poolOwner])
      .rpc();
  }

  extraAccountMetaListPDA(trancheMint: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('extra-account-metas'), trancheMint.toBuffer()],
      this.ctx.transferHookProgram.programId
    )[0];
  }

  approvedDestinationPDA(
    trancheMint: PublicKey,
    lender: PublicKey,
    allowOwnerOffCurve = false
  ) {
    const lenderTrancheTokenPDA = getAssociatedTokenAddressSync(
      trancheMint,
      lender,
      allowOwnerOffCurve,
      TOKEN_2022_PROGRAM_ID
    );
    const approvedDestinationPDA = PublicKey.findProgramAddressSync(
      [
        anchor.utils.bytes.utf8.encode('approved_destination'),
        trancheMint.toBuffer(),
        lenderTrancheTokenPDA.toBuffer()
      ],
      this.ctx.transferHookProgram.programId
    )[0];

    return [approvedDestinationPDA, lenderTrancheTokenPDA];
  }
}

export type EpochRedemptionSummary = {
  epochId: anchor.BN;
  totalSharesRequested: anchor.BN;
  totalSharesProcessed: anchor.BN;
  totalAmountProcessed: anchor.BN;
};

export class EpochChecker {
  ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  async checkSeniorRedemptionSummaryById(
    epochId: BN,
    sharesRequested: BN = new BN(0),
    sharesProcessed: BN = new BN(0),
    amountProcessed: BN = new BN(0),
    delta = 0
  ) {
    await this.checkRedemptionSummaryById(
      this.ctx.poolContext.seniorTrancheMintPDA(),
      epochId,
      sharesRequested,
      sharesProcessed,
      amountProcessed,
      delta
    );
  }

  async checkSeniorCurrentRedemptionSummaryEmpty() {
    return await this.checkCurrentRedemptionSummaryEmpty(
      this.ctx.poolContext.seniorTrancheMintPDA()
    );
  }

  async checkSeniorCurrentRedemptionSummary(
    sharesRequested: BN = new BN(0),
    sharesProcessed: BN = new BN(0),
    amountProcessed: BN = new BN(0),
    delta = 0
  ) {
    return await this.checkCurrentRedemptionSummary(
      this.ctx.poolContext.seniorTrancheMintPDA(),
      sharesRequested,
      sharesProcessed,
      amountProcessed,
      delta
    );
  }

  async checkJuniorRedemptionSummaryById(
    epochId: BN,
    sharesRequested: BN = new BN(0),
    sharesProcessed: BN = new BN(0),
    amountProcessed: BN = new BN(0),
    delta = 0
  ) {
    await this.checkRedemptionSummaryById(
      this.ctx.poolContext.juniorTrancheMintPDA(),
      epochId,
      sharesRequested,
      sharesProcessed,
      amountProcessed,
      delta
    );
  }

  async checkJuniorCurrentRedemptionSummaryEmpty() {
    return await this.checkCurrentRedemptionSummaryEmpty(
      this.ctx.poolContext.juniorTrancheMintPDA()
    );
  }

  async checkJuniorCurrentRedemptionSummary(
    sharesRequested: BN = new BN(0),
    sharesProcessed: BN = new BN(0),
    amountProcessed: BN = new BN(0),
    delta = 0
  ) {
    return await this.checkCurrentRedemptionSummary(
      this.ctx.poolContext.juniorTrancheMintPDA(),
      sharesRequested,
      sharesProcessed,
      amountProcessed,
      delta
    );
  }

  private async checkCurrentRedemptionSummaryEmpty(tranche: PublicKey) {
    const epochId = (await this.ctx.poolContext.poolState()).currentEpoch.id;
    await this.checkRedemptionSummaryById(tranche, new BN(0));
    return epochId;
  }

  private async checkCurrentRedemptionSummary(
    tranche: PublicKey,
    sharesRequested: BN = new BN(0),
    sharesProcessed: BN = new BN(0),
    amountProcessed: BN = new BN(0),
    delta = 0
  ) {
    const epochId = (await this.ctx.poolContext.poolState()).currentEpoch.id;
    await this.checkRedemptionSummaryById(
      tranche,
      epochId,
      sharesRequested,
      sharesProcessed,
      amountProcessed,
      delta
    );
    return epochId;
  }

  private async checkRedemptionSummaryById(
    tranche: PublicKey,
    epochId: BN,
    sharesRequested: BN = new BN(0),
    sharesProcessed: BN = new BN(0),
    amountProcessed: BN = new BN(0),
    delta = 0
  ) {
    const redemptionSummary =
      await this.ctx.trancheVaultContext.getRedemptionSummary(tranche, epochId);
    checkRedemptionSummary(
      redemptionSummary,
      epochId,
      sharesRequested,
      sharesProcessed,
      amountProcessed,
      delta
    );
  }
}

export function checkRedemptionSummary(
  redemptionSummary: EpochRedemptionSummary,
  epochId: BN,
  totalSharesRequested: BN,
  totalSharesProcessed: BN = new BN(0),
  totalAmountProcessed: BN = new BN(0),
  delta = 0
): void {
  expect(redemptionSummary.epochId.eq(epochId)).to.be.true;
  assertCloseTo(
    redemptionSummary.totalSharesRequested,
    totalSharesRequested,
    delta
  );
  assertCloseTo(
    redemptionSummary.totalSharesProcessed,
    totalSharesProcessed,
    delta
  );
  assertCloseTo(
    redemptionSummary.totalAmountProcessed,
    totalAmountProcessed,
    delta
  );
}

export type LenderRedemptionRecord = {
  nextEpochIdToProcess: anchor.BN;
  numSharesRequested: anchor.BN;
  principalRequested: anchor.BN;
  totalAmountProcessed: anchor.BN;
  totalAmountWithdrawn: anchor.BN;
};

export function checkLenderRedemptionRecord(
  redemptionRecord: LenderRedemptionRecord,
  nextEpochIdToProcess: BN,
  numSharesRequested: BN,
  principalRequested: BN,
  totalAmountProcessed: BN,
  totalAmountWithdrawn: BN,
  delta = 0
): void {
  expect(redemptionRecord.nextEpochIdToProcess.eq(nextEpochIdToProcess)).to.be
    .true;
  assertCloseTo(redemptionRecord.numSharesRequested, numSharesRequested, delta);
  assertCloseTo(redemptionRecord.principalRequested, principalRequested, delta);
  assertCloseTo(
    redemptionRecord.totalAmountProcessed,
    totalAmountProcessed,
    delta
  );
  assertCloseTo(
    redemptionRecord.totalAmountWithdrawn,
    totalAmountWithdrawn,
    delta
  );
}

export async function calcAmountToRedeem(
  ctx: Context,
  profit: BN,
  loss: BN,
  lossRecovery: BN,
  seniorSharesRedeemed: BN,
  juniorSharesRedeemed: BN
) {
  const poolState = await ctx.poolContext.poolState();
  const assets = poolState.trancheAssets.assets;
  const losses = poolState.trancheLosses.losses;
  const poolConfig = await ctx.poolContext.poolConfig();
  const humaConfig = await ctx.humaConfigContext.humaConfig();
  const {
    assets: [juniorAssets, seniorAssets]
  } = calcAssetsAfterPnlForRiskAdjustedPolicy(
    profit,
    loss,
    lossRecovery,
    assets,
    losses,
    poolConfig.adminRnr,
    poolConfig.lpConfig,
    humaConfig.protocolFeeBps
  );

  let seniorAmountProcessed = new BN(0);
  let seniorPrice = new BN(0);
  if (seniorSharesRedeemed.gtn(0)) {
    const seniorSupply = await ctx.poolContext.getTrancheSupply(
      ctx.poolContext.seniorTrancheMintPDA()
    );
    seniorPrice = seniorAssets
      .mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR)
      .div(seniorSupply);
    seniorAmountProcessed = seniorSharesRedeemed
      .mul(seniorPrice)
      .div(CONSTANTS.DEFAULT_DECIMALS_FACTOR);
  }
  const juniorSupply = await ctx.poolContext.getTrancheSupply(
    ctx.poolContext.juniorTrancheMintPDA()
  );
  const juniorPrice = juniorAssets
    .mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR)
    .div(juniorSupply);
  const juniorAmountProcessed = juniorSharesRedeemed
    .mul(juniorPrice)
    .div(CONSTANTS.DEFAULT_DECIMALS_FACTOR);

  return {
    juniorAmountProcessed,
    seniorAmountProcessed,
    juniorPrice,
    seniorPrice
  };
}
