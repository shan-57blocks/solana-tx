/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/ban-types */
import { AnchorError, BN, BorshCoder, EventParser } from '@coral-xyz/anchor';
import {
  approveInstructionData,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createTransferCheckedInstruction,
  freezeAccountInstructionData,
  getAssociatedTokenAddressSync,
  getExtraAccountMetaAddress,
  getTransferHook,
  initializeMint2InstructionData,
  mintToInstructionData,
  MINT_SIZE,
  thawAccountInstructionData,
  TokenInstruction,
  TOKEN_2022_PROGRAM_ID,
  unpackAccount,
  unpackMint
} from '@solana/spl-token';
import {
  AccountInfo,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction
} from '@solana/web3.js';
import * as borsh from 'borsh';
import { assert, expect } from 'chai';
import { ProgramTestContext } from 'solana-bankrun';
import { Context as TestContext } from './Base';

export function toToken(number: string | number, decimals = 6): BN {
  return new BN(number).mul(new BN(10).pow(new BN(decimals)));
}

export function stringify(obj: Object) {
  return JSON.stringify(obj, (_, v) =>
    typeof v === 'bigint' ? v.toString() : v
  );
}

export function sumBNArray(arr: BN[]): BN {
  return arr.reduce((acc, currValue) => acc.add(currValue), new BN(0));
}

export function ceilDiv(x: BN, y: BN): BN {
  if (y.eq(new BN(0))) {
    return x.div(y);
  }
  return x.eq(new BN(0)) ? new BN(0) : x.sub(new BN(1)).div(y).add(new BN(1));
}

export async function processOneNewTransaction(ctx: ProgramTestContext) {
  const tx = new Transaction();
  const latestBlockhash = await ctx.banksClient.getLatestBlockhash();
  if (!latestBlockhash) throw new Error('Could not get latest blockhash');
  tx.recentBlockhash = latestBlockhash[0];
  tx.add(
    SystemProgram.transfer({
      fromPubkey: ctx.payer.publicKey,
      toPubkey: ctx.payer.publicKey,
      lamports: 1
    })
  ).sign(ctx.payer);

  await ctx.banksClient.processTransaction(tx);
}

export async function expectAccountInfoNotFound(
  func: Function,
  accountKey: PublicKey
) {
  try {
    await func();
    assert.ok(false);
  } catch (e) {
    const err = e as Error;
    expect(err.toString()).to.include(`Could not find ${accountKey}`);
  }
}

export async function expectInitAgainError(
  func: Function,
  accountKey: PublicKey
) {
  try {
    await func();
    assert.ok(false);
  } catch (e) {
    expect(JSON.stringify(e)).to.include(
      `Allocate: account Address { address: ${accountKey}, base: None } already in use`
    );
  }
}

export function expectTransferHookError(
  logs: string[] | undefined,
  error: TransferHookErrors
) {
  if (!logs || logs.length === 0) {
    assert.fail('No log messages found in transaction response');
  }
  expect(JSON.stringify(logs)).to.include(
    `Error Code: ${TransferHookErrors[error]}. Error Number: ${error}.`
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function expectError(
  func: Function,
  errorType: any,
  errorValue: any
) {
  try {
    await func();
    assert.fail('Expected an error');
  } catch (e) {
    const err = e as AnchorError;
    assert.strictEqual(err.error.errorCode.code, errorType[errorValue]);
    assert.strictEqual(err.error.errorCode.number, errorValue);
  }
}

export async function expectEvent(
  ctx: TestContext,
  txSignature: string,
  expectedEvent: { data: Object; name: string },
  delta = 0
) {
  await expectEvents(ctx, txSignature, [expectedEvent], delta);
}

// The following events can be emitted multiple times in a single instruction, so we need to match on
// indices in addition to event names.
const MULTI_EMIT_EVENTS = ['epochProcessedEvent', 'lenderFundDisbursedEvent'];
const MULTI_EMIT_EVENTS_INDICES = {
  epochProcessedEvent: ['tranche', 'epochId'],
  lenderFundDisbursedEvent: ['tranche', 'lender']
};

export async function expectEvents(
  ctx: TestContext,
  txSignature: string,
  expectedEvents: { data: Object; name: string }[],
  delta = 0
) {
  if (expectedEvents.length === 0) {
    return;
  }

  const logs = ctx.provider.getTransactionLogs(txSignature);
  if (logs.length === 0) {
    assert.fail('No log messages found in transaction response');
  }

  const eventParser = new EventParser(
    ctx.program.programId,
    new BorshCoder(ctx.program.idl)
  );
  const eventGenerator = eventParser.parseLogs(logs);
  const events = [];
  for (const event of eventGenerator) {
    events.push(event);
  }
  let found = false;
  for (const expectedEvent of expectedEvents) {
    found = true;
    const res = events.find((event) => {
      if (event.name === expectedEvent.name) {
        if (MULTI_EMIT_EVENTS.includes(expectedEvent.name)) {
          const indices =
            MULTI_EMIT_EVENTS_INDICES[
              expectedEvent.name as keyof typeof MULTI_EMIT_EVENTS_INDICES
            ];
          let multiEmitEventFound = true;
          for (const index of indices) {
            const actual = event.data[index as keyof typeof event.data];
            const expected =
              expectedEvent.data[index as keyof typeof expectedEvent.data];
            let expectedIndexFound = false;
            if (BN.isBN(actual) && BN.isBN(expected) && actual.eq(expected)) {
              expectedIndexFound = true;
            } else if (
              actual instanceof PublicKey &&
              expected instanceof PublicKey &&
              actual.equals(expected)
            ) {
              expectedIndexFound = true;
            } else if (actual === expected) {
              expectedIndexFound = true;
            }
            if (!expectedIndexFound) {
              multiEmitEventFound = false;
              break;
            }
          }
          if (multiEmitEventFound) {
            expectStructsEqual(event.data, expectedEvent.data, delta);
            return true;
          }
        } else {
          expectStructsEqual(event.data, expectedEvent.data, delta);
          return true;
        }
      }
      return false;
    });
    if (!res) {
      assert.fail(`Can't find event: ${stringify(expectedEvent)}`);
    }
  }
  if (!found) {
    assert.fail('No events found in transaction response');
  }
}

export enum AnchorErrors {
  AccountDiscriminatorMismatch = 3002,
  AccountOwnedByWrongProgram = 3007,
  AccountNotInitialized = 3012,
  ConstraintSeeds = 2006,
  ConstraintTokenOwner = 2015
}

export async function expectAnchorError(func: Function, error: AnchorErrors) {
  await expectError(func, AnchorErrors, error);
}

export async function getTokenAccount(ctx: TestContext, accountKey: PublicKey) {
  const info = await ctx.provider.context.banksClient.getAccount(accountKey);
  return unpackAccount(
    accountKey,
    {
      ...info,
      data: Buffer.from(info!.data)
    } as any,
    TOKEN_2022_PROGRAM_ID
  );
}

export async function createMint(
  ctx: ProgramTestContext,
  mintAuthority: PublicKey,
  freezeAuthority: PublicKey,
  decimals: number,
  mint: Keypair
) {
  const data = Buffer.alloc(initializeMint2InstructionData.span);
  initializeMint2InstructionData.encode(
    {
      instruction: TokenInstruction.InitializeMint2,
      decimals,
      mintAuthority,
      freezeAuthority
    },
    data
  );

  const ix1 = SystemProgram.createAccount({
    fromPubkey: ctx.payer.publicKey,
    newAccountPubkey: mint.publicKey,
    space: MINT_SIZE,
    lamports: LAMPORTS_PER_SOL,
    programId: TOKEN_2022_PROGRAM_ID
  });

  const ix2 = new TransactionInstruction({
    keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }],
    programId: TOKEN_2022_PROGRAM_ID,
    data
  });

  const tx = new Transaction();
  const latestBlockhash = await ctx.banksClient.getLatestBlockhash();
  if (!latestBlockhash) throw new Error('Could not get latest blockhash');
  tx.recentBlockhash = latestBlockhash[0];
  tx.add(ix1).add(ix2).sign(ctx.payer, mint);

  await ctx.banksClient.processTransaction(tx);
}

export async function createAssociatedTokenAccount(
  ctx: ProgramTestContext,
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = false
) {
  const associatedTokenAddr = getAssociatedTokenAddressSync(
    mint,
    owner,
    allowOwnerOffCurve,
    TOKEN_2022_PROGRAM_ID
  );

  const keys = [
    { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: associatedTokenAddr, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }
  ];

  const ix = new TransactionInstruction({
    keys,
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    data: Buffer.alloc(0)
  });

  const tx = new Transaction();
  const latestBlockhash = await ctx.banksClient.getLatestBlockhash();
  if (!latestBlockhash) throw new Error('Could not get latest blockhash');
  tx.recentBlockhash = latestBlockhash[0];
  tx.add(ix).sign(ctx.payer);

  await ctx.banksClient.processTransaction(tx);

  return associatedTokenAddr;
}

export async function mintTo(
  ctx: ProgramTestContext,
  mint: PublicKey,
  authority: Keypair,
  destination: PublicKey,
  amount: number | bigint
) {
  const keys = [
    { pubkey: mint, isSigner: false, isWritable: true },
    { pubkey: destination, isSigner: false, isWritable: true },
    { pubkey: authority.publicKey, isSigner: true, isWritable: false }
  ];
  const data = Buffer.alloc(mintToInstructionData.span);
  mintToInstructionData.encode(
    {
      instruction: TokenInstruction.MintTo,
      amount: BigInt(amount)
    },
    data
  );
  const ix = new TransactionInstruction({
    keys,
    programId: TOKEN_2022_PROGRAM_ID,
    data
  });

  const tx = new Transaction();
  const latestBlockhash = await ctx.banksClient.getLatestBlockhash();
  if (!latestBlockhash) throw new Error('Could not get latest blockhash');
  tx.recentBlockhash = latestBlockhash[0];
  tx.add(ix).sign(ctx.payer, authority);

  await ctx.banksClient.processTransaction(tx);
}

export async function approve(
  ctx: ProgramTestContext,
  source: PublicKey,
  authority: Keypair,
  delegate: Keypair,
  amount: BN | bigint
) {
  const keys = [
    { pubkey: source, isSigner: false, isWritable: true },
    { pubkey: delegate.publicKey, isSigner: false, isWritable: true },
    { pubkey: authority.publicKey, isSigner: true, isWritable: false }
  ];
  const data = Buffer.alloc(approveInstructionData.span);
  approveInstructionData.encode(
    {
      instruction: TokenInstruction.Approve,
      amount: BigInt(amount.toString())
    },
    data
  );
  const ix = new TransactionInstruction({
    keys,
    programId: TOKEN_2022_PROGRAM_ID,
    data
  });

  const tx = new Transaction();
  const latestBlockhash = await ctx.banksClient.getLatestBlockhash();
  if (!latestBlockhash) throw new Error('Could not get latest blockhash');
  tx.recentBlockhash = latestBlockhash[0];
  tx.add(ix).sign(ctx.payer, authority);

  await ctx.banksClient.processTransaction(tx);
}

export async function freezeAccount(
  ctx: ProgramTestContext,
  account: PublicKey,
  mint: Keypair,
  authority: Keypair
) {
  const keys = [
    { pubkey: account, isSigner: false, isWritable: true },
    { pubkey: mint.publicKey, isSigner: false, isWritable: true },
    { pubkey: authority.publicKey, isSigner: true, isWritable: false }
  ];
  const data = Buffer.alloc(freezeAccountInstructionData.span);
  freezeAccountInstructionData.encode(
    {
      instruction: TokenInstruction.FreezeAccount
    },
    data
  );
  const ix = new TransactionInstruction({
    keys,
    programId: TOKEN_2022_PROGRAM_ID,
    data
  });

  const tx = new Transaction();
  const latestBlockhash = await ctx.banksClient.getLatestBlockhash();
  if (!latestBlockhash) throw new Error('Could not get latest blockhash');
  tx.recentBlockhash = latestBlockhash[0];
  tx.add(ix).sign(ctx.payer, authority);

  await ctx.banksClient.processTransaction(tx);
}

export async function thawAccount(
  ctx: ProgramTestContext,
  account: PublicKey,
  mint: Keypair,
  authority: Keypair
) {
  const keys = [
    { pubkey: account, isSigner: false, isWritable: true },
    { pubkey: mint.publicKey, isSigner: false, isWritable: true },
    { pubkey: authority.publicKey, isSigner: true, isWritable: false }
  ];
  const data = Buffer.alloc(thawAccountInstructionData.span);
  thawAccountInstructionData.encode(
    {
      instruction: TokenInstruction.ThawAccount
    },
    data
  );
  const ix = new TransactionInstruction({
    keys,
    programId: TOKEN_2022_PROGRAM_ID,
    data
  });

  const tx = new Transaction();
  const latestBlockhash = await ctx.banksClient.getLatestBlockhash();
  if (!latestBlockhash) throw new Error('Could not get latest blockhash');
  tx.recentBlockhash = latestBlockhash[0];
  tx.add(ix).sign(ctx.payer, authority);

  await ctx.banksClient.processTransaction(tx);
}

export async function approveToUser(
  ctx: TestContext,
  user: Keypair,
  authority: Keypair,
  amount: BN
) {
  const ata = ctx.getUserUnderlyingATA(authority.publicKey);
  await approve(ctx.provider.context, ata, authority, user, amount);
}

export async function freezeUser(ctx: TestContext, user: Keypair) {
  const underlyingMintAddr = ctx.assetMint();
  const ata = ctx.getUserUnderlyingATA(user.publicKey);
  const humaOwner = ctx.humaConfigContext.humaOwner();
  await freezeAccount(ctx.provider.context, ata, underlyingMintAddr, humaOwner);
}

export async function thawUser(ctx: TestContext, user: Keypair) {
  const underlyingMintAddr = ctx.assetMint();
  const ata = ctx.getUserUnderlyingATA(user.publicKey);
  const humaOwner = ctx.humaConfigContext.humaOwner();
  await thawAccount(ctx.provider.context, ata, underlyingMintAddr, humaOwner);
}

export async function mintToUser(ctx: TestContext, user: Keypair, amount: BN) {
  return await mintToUsers(ctx, [user], amount);
}

export async function mintToUsers(
  ctx: TestContext,
  users: Keypair[],
  amount: BN
) {
  const underlyingMintAddr = ctx.assetMint().publicKey;
  const humaOwner = ctx.humaConfigContext.humaOwner();
  for (const user of users) {
    const ataAddr = getAssociatedTokenAddressSync(
      underlyingMintAddr,
      user.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const accountInfo =
      await ctx.provider.context.banksClient.getAccount(ataAddr);
    if (!accountInfo) {
      await createAssociatedTokenAccount(
        ctx.provider.context,
        underlyingMintAddr,
        user.publicKey
      );
    }
    await mintTo(
      ctx.provider.context,
      underlyingMintAddr,
      humaOwner,
      ataAddr,
      BigInt(amount.toString())
    );
  }
}

export async function transferWithHook(
  ctx: ProgramTestContext,
  source: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  owner: Keypair,
  amount: BN,
  decimal: number,
  additionalAccounts: {
    pubkey: PublicKey;
    isSigner: boolean;
    isWritable: boolean;
  }[]
) {
  const ix1 = createTransferCheckedInstruction(
    source,
    mint,
    destination,
    owner.publicKey,
    BigInt(amount.toString()),
    decimal,
    [],
    TOKEN_2022_PROGRAM_ID
  );

  const info = await ctx.banksClient.getAccount(mint);
  const mintInfo = unpackMint(
    mint,
    {
      ...info,
      data: Buffer.from(info!.data)
    } as any,
    TOKEN_2022_PROGRAM_ID
  );
  const transferHook = getTransferHook(mintInfo);
  if (transferHook) {
    const validateStatePubkey = getExtraAccountMetaAddress(
      mint,
      transferHook.programId
    );
    const validateStateAccount =
      await ctx.banksClient.getAccount(validateStatePubkey);
    if (validateStateAccount != null) {
      for (const key of additionalAccounts) {
        ix1.keys.push(key);
      }
      ix1.keys.push({
        pubkey: transferHook.programId,
        isSigner: false,
        isWritable: false
      });
      ix1.keys.push({
        pubkey: validateStatePubkey,
        isSigner: false,
        isWritable: false
      });
    }
  }

  const tx = new Transaction();
  const latestBlockhash = await ctx.banksClient.getLatestBlockhash();
  if (!latestBlockhash) throw new Error('Could not get latest blockhash');
  tx.recentBlockhash = latestBlockhash[0];
  tx.add(ix1).sign(owner);

  const res = await ctx.banksClient.tryProcessTransaction(tx);
  return res.meta?.logMessages;
}

export enum ProgramErrors {
  // Common
  ZeroAmountProvided = 6001,
  InvalidBasisPointHigherThan10000 = 6002,
  InsufficientAmountForRequest = 6003,
  InsufficientSharesForRequest = 6004,
  ZeroSharesMinted = 6005,
  UnsupportedFunction = 6006,

  // Calendar
  StartDateLaterThanEndDate = 6101,

  // Access control
  HumaOwnerRequired = 6201,
  HumaTreasuryRequired = 6202,
  PoolOwnerRequired = 6203,
  PoolOwnerOrHumaOwnerRequired = 6204,
  PoolOwnerOrEARequired = 6205,
  PoolOwnerTreasuryRequired = 6206,
  PoolOperatorRequired = 6207,
  LenderRequired = 6208,
  BorrowerOrEARequired = 6209,
  BorrowerOrSentinelRequired = 6210,
  EvaluationAgentRequired = 6211,
  EAOrSentinelRequired = 6212,
  ReceivableUpdateAuthorityRequired = 6213,
  AuthorizedInitialDepositorRequired = 6214,

  // Huma config
  ProtocolFeeHigherThanUpperLimit = 6301,
  ProtocolIsPaused = 6302,
  InvalidHumaConfig = 6303,
  InvalidUnderlyingMint = 6304,
  InvalidNumberOfDecimalsForLiquidityAsset = 6305,

  // Pool
  InvalidTrancheStatePDA = 6401,
  InvalidTrancheMint = 6402,
  SeniorMintRequired = 6403,
  SeniorStateRequired = 6404,
  InvalidLenderTrancheToken = 6405,
  InvalidLenderStateAccount = 6406,
  PoolSeniorTokenRequired = 6407,
  TrancheTokenNotReadyToClose = 6408,
  LenderStateNotReadyToClose = 6409,
  AdminRewardRateTooHigh = 6410,
  PoolOwnerInsufficientLiquidity = 6411,
  EvaluationAgentInsufficientLiquidity = 6412,
  MinDepositAmountTooLow = 6413,
  LatePaymentGracePeriodTooLong = 6414,
  PoolIsNotOn = 6415,
  PoolIsOff = 6416,
  PoolIsNotClosed = 6417,
  PoolNameTooLong = 6418,

  // Tranche
  PreviousAssetsNotWithdrawn = 6501,
  TrancheLiquidityCapExceeded = 6502,
  DepositAmountTooLow = 6503,
  WithdrawTooEarly = 6504,
  EpochClosedTooEarly = 6505,

  // Credit
  ZeroPayPeriodsProvided = 6601,
  CreditNotInStateForApproval = 6602,
  CreditLimitTooHigh = 6603,
  CommittedAmountExceedsCreditLimit = 6604,
  PayPeriodsTooLowForCreditsWithDesignatedStartDate = 6605,
  CreditWithoutCommitmentShouldHaveNoDesignatedStartDate = 6606,
  DesignatedStartDateInThePast = 6607,
  CommittedCreditCannotBeStarted = 6608,
  CreditNotInStateForDrawdown = 6609,
  CreditLimitExceeded = 6610,
  FirstDrawdownTooEarly = 6611,
  AttemptedDrawdownOnNonRevolvingCredit = 6612,
  InsufficientPoolBalanceForDrawdown = 6613,
  BorrowAmountLessThanPlatformFees = 6614,
  DrawdownNotAllowedInFinalPeriodAndBeyond = 6615,
  DrawdownNotAllowedAfterDueDateWithUnpaidDue = 6616,
  CreditNotInStateForMakingPayment = 6617,
  CreditNotInStateForMakingPrincipalPayment = 6618,
  ZeroReceivableAmount = 6619,
  InvalidReceivableReferencePDA = 6620,
  ReceivableAlreadyMatured = 6621,
  InvalidReceivableState = 6622,
  ReceivableOwnershipMismatch = 6623,
  ReceivableAutoApprovalNotEnabled = 6624,
  DefaultHasAlreadyBeenTriggered = 6625,
  DefaultTriggeredTooEarly = 6626,
  CreditNotInStateForUpdate = 6627,
  CreditHasOutstandingBalance = 6628,
  CreditHasUnfulfilledCommitment = 6629,
  ReferenceIdTooLong = 6630
}

export enum TransferHookErrors {
  UnsupportedFunction = 7001
}

export async function expectProgramError(func: Function, error: ProgramErrors) {
  await expectError(func, ProgramErrors, error);
}

export function convertToBN(a: bigint): BN {
  return new BN(a.toString());
}

export function expectStructsEqual(
  actual: Object,
  expected: Object,
  delta = 0
) {
  expect(Object.keys(actual)).to.deep.equal(Object.keys(expected));
  for (const key of Object.keys(actual)) {
    const aValue = actual[key as keyof typeof actual];
    const eValue = expected[key as keyof typeof expected];

    if (aValue instanceof BN) {
      if (eValue instanceof BN) {
        assertCloseTo(aValue, eValue, delta);
      } else {
        assert.fail(`Expected ${stringify(eValue)}'s ${key} field to be a BN`);
      }
    } else if (aValue === null) {
      expect(eValue).to.be.null;
    } else if (
      isPrimitive(aValue) ||
      aValue instanceof PublicKey ||
      Object.keys(aValue).length === 0
    ) {
      expect(aValue).to.deep.equal(eValue);
    } else {
      // Nested struct comparison
      expectStructsEqual(aValue, eValue, delta);
    }
  }
}

export function expectBNEqual(actual: BN, expected: BN) {
  expect(actual.eq(expected), `Expected ${actual} to be equal to ${expected}`)
    .to.be.true;
}

export function assertCloseTo(a: BN, b: BN, delta: number) {
  assert(
    isCloseTo(a, b, delta),
    `Expected ${a} to be close to ${b} within ${delta}`
  );
}

function isCloseTo(a: BN, b: BN, delta: number): boolean {
  return a.sub(b).abs().lte(new BN(delta));
}

function isPrimitive(value: unknown): boolean {
  return value !== Object(value);
}

class Assignable {
  // @ts-ignore
  constructor(properties) {
    Object.keys(properties).map((key) => {
      // @ts-ignore
      this[key] = properties[key];
    });
  }
}

export function parseReturnObject<T>(
  ctx: TestContext,
  txSignature: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  classType: { new (args: any): T },
  fields: any
): T {
  const logs = ctx.provider.getTransactionLogs(txSignature);

  const prefix = 'Program return: ';
  let log = logs.find((log: any) => log.startsWith(prefix));
  log = log!.slice(prefix.length);
  const [key, data] = log.split(' ', 2);
  const buffer = Buffer.from(data, 'base64');

  const schema = new Map([
    [
      classType,
      {
        kind: 'struct',
        fields
      }
    ]
  ]);
  return borsh.deserialize(schema, classType, buffer);
}

export function parseMakePaymentResult(
  ctx: TestContext,
  txSignature: string
): MakePaymentResult {
  return parseReturnObject(ctx, txSignature, MakePaymentResult, [
    ['amountToCollect', 'u128'],
    ['paidOff', 'u8']
  ]);
}

export function parseDistributeProfitToTranchesResult(
  ctx: TestContext,
  txSignature: string
): DistributeProfitToTranchesResult {
  return parseReturnObject(ctx, txSignature, DistributeProfitToTranchesResult, [
    ['juniorProfits', 'u128'],
    ['seniorProfits', 'u128']
  ]);
}

export class MakePaymentResult extends Assignable {
  amountToCollect: BN | undefined;
  paidOff: number | undefined;

  // @ts-ignore
  constructor(properties) {
    super(properties);
  }

  getPaidOff(): boolean {
    return this.paidOff === 1;
  }
}

export class DistributeProfitToTranchesResult extends Assignable {
  juniorProfits: BN | undefined;
  seniorProfits: BN | undefined;

  // @ts-ignore
  constructor(properties) {
    super(properties);
  }
}
