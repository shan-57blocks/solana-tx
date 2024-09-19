/* eslint-disable @typescript-eslint/no-explicit-any */
import { BN } from '@coral-xyz/anchor';
import {
  AdminRnR,
  Context,
  FeeStructure,
  LPConfig,
  SeniorYieldTracker
} from './Base';
import { CONSTANTS } from './Constants';
import { getDaysDiff, getStartOfNextDay } from './CalendarUtils';

export function calcBorrowAmountDistribution(
  amount: BN,
  feeStructure: FeeStructure,
  adminRnR: AdminRnR,
  protocolFeeBps: number
): BN[] {
  const platformFees = feeStructure.frontLoadingFeeFlat.add(
    amount
      .mul(new BN(feeStructure.frontLoadingFeeBps))
      .div(CONSTANTS.HUNDRED_PERCENT_BPS)
  );
  const poolFees = calcPoolFees(platformFees, adminRnR, protocolFeeBps);
  const amountToBorrower = amount.sub(platformFees);
  return [poolFees[0], poolFees[1], poolFees[2], poolFees[3], amountToBorrower];
}

export function calcPoolFees(
  profit: BN,
  adminRnR: AdminRnR,
  protocolFeeBps: number
): BN[] {
  const protocolFee = profit
    .mul(new BN(protocolFeeBps))
    .div(CONSTANTS.HUNDRED_PERCENT_BPS);

  const remaining = profit.sub(protocolFee);
  const poolOwnerFee = remaining
    .mul(new BN(adminRnR.rewardRateBpsForPoolOwner))
    .div(CONSTANTS.HUNDRED_PERCENT_BPS);
  const eaFee = remaining
    .mul(new BN(adminRnR.rewardRateBpsForEa))
    .div(CONSTANTS.HUNDRED_PERCENT_BPS);
  return [
    protocolFee,
    poolOwnerFee,
    eaFee,
    remaining.sub(poolOwnerFee).sub(eaFee)
  ];
}

export function calcLatestSeniorTracker(
  currentTS: number,
  fixedSeniorYieldBps: number,
  currentTracker: SeniorYieldTracker
) {
  const startOfNextDay = getStartOfNextDay(currentTS);
  const daysDiff = getDaysDiff(currentTracker.lastUpdatedDate, startOfNextDay);
  if (daysDiff > 0) {
    const newUnpaidYield = currentTracker.unpaidYield.add(
      currentTracker.totalAssets
        .mul(new BN(daysDiff * fixedSeniorYieldBps))
        .div(
          new BN(CONSTANTS.DAYS_IN_A_YEAR).mul(CONSTANTS.HUNDRED_PERCENT_BPS)
        )
    );

    return {
      totalAssets: currentTracker.totalAssets,
      unpaidYield: newUnpaidYield,
      lastUpdatedDate: startOfNextDay
    };
  }

  return currentTracker;
}

export function calcProfitsForRiskAdjustedPolicy(
  profit: BN,
  assets: BN[],
  lpConfig: LPConfig
): BN[] {
  const seniorProfit = profit
    .mul(assets[CONSTANTS.SENIOR_TRANCHE])
    .mul(
      CONSTANTS.HUNDRED_PERCENT_BPS.sub(
        new BN(lpConfig.tranchesRiskAdjustmentBps)
      )
    )
    .div(
      assets
        .reduce((a, b) => a.add(b), new BN(0))
        .mul(CONSTANTS.HUNDRED_PERCENT_BPS)
    );

  return [
    assets[CONSTANTS.JUNIOR_TRANCHE].add(profit).sub(seniorProfit),
    assets[CONSTANTS.SENIOR_TRANCHE].add(seniorProfit)
  ];
}

export function calcProfitsForFixedSeniorYieldPolicy(
  currentTS: number,
  profit: BN,
  assets: BN[],
  fixedSeniorYieldBps: number,
  currentTracker: SeniorYieldTracker
): { tracker: SeniorYieldTracker; assets: BN[]; updated: boolean } {
  const newTracker = calcLatestSeniorTracker(
    currentTS,
    fixedSeniorYieldBps,
    currentTracker
  );

  const seniorProfit = newTracker.unpaidYield.gt(profit)
    ? profit
    : newTracker.unpaidYield;
  const juniorProfit = profit.sub(seniorProfit);
  const updatedTracker = {
    totalAssets: assets[CONSTANTS.SENIOR_TRANCHE].add(seniorProfit),
    unpaidYield: newTracker.unpaidYield.sub(seniorProfit),
    lastUpdatedDate: newTracker.lastUpdatedDate
  };

  return {
    tracker: updatedTracker,
    assets: [
      assets[CONSTANTS.JUNIOR_TRANCHE].add(juniorProfit),
      assets[CONSTANTS.SENIOR_TRANCHE].add(seniorProfit)
    ],
    updated: newTracker.lastUpdatedDate !== currentTracker.lastUpdatedDate
  };
}

export function calcLoss(loss: BN, assets: BN[]): BN[][] {
  const juniorLoss = loss.lt(assets[CONSTANTS.JUNIOR_TRANCHE])
    ? loss
    : assets[CONSTANTS.JUNIOR_TRANCHE];
  const seniorLoss = loss.sub(juniorLoss).lt(assets[CONSTANTS.SENIOR_TRANCHE])
    ? loss.sub(juniorLoss)
    : assets[CONSTANTS.SENIOR_TRANCHE];

  return [
    [
      assets[CONSTANTS.JUNIOR_TRANCHE].sub(juniorLoss),
      assets[CONSTANTS.SENIOR_TRANCHE].sub(seniorLoss)
    ],
    [juniorLoss, seniorLoss]
  ];
}

export function calcLossRecovery(
  lossRecovery: BN,
  assets: BN[],
  losses: BN[]
): BN[][] {
  const seniorRecovery = lossRecovery.lt(losses[CONSTANTS.SENIOR_TRANCHE])
    ? lossRecovery
    : losses[CONSTANTS.SENIOR_TRANCHE];
  const juniorRecovery = lossRecovery
    .sub(seniorRecovery)
    .lt(losses[CONSTANTS.JUNIOR_TRANCHE])
    ? lossRecovery.sub(seniorRecovery)
    : losses[CONSTANTS.JUNIOR_TRANCHE];

  return [
    [
      assets[CONSTANTS.JUNIOR_TRANCHE].add(juniorRecovery),
      assets[CONSTANTS.SENIOR_TRANCHE].add(seniorRecovery)
    ],
    [
      losses[CONSTANTS.JUNIOR_TRANCHE].sub(juniorRecovery),
      losses[CONSTANTS.SENIOR_TRANCHE].sub(seniorRecovery)
    ]
  ];
}

export function calcAssetsAfterPnlForRiskAdjustedPolicy(
  profit: BN,
  loss: BN,
  lossRecovery: BN,
  assets: BN[],
  losses: BN[],
  adminRnR: AdminRnR,
  lpConfig: LPConfig,
  protocolFeeBps: number
): { assets: BN[]; losses: BN[]; lossRecovery: BN } {
  const profitLessFees = calcPoolFees(profit, adminRnR, protocolFeeBps)[3];

  assets = calcProfitsForRiskAdjustedPolicy(profitLessFees, assets, lpConfig);
  const [newAssets, newLosses] = calcLoss(loss, assets);
  const totalLosses = [new BN(0), new BN(0)];
  losses.forEach((existingLoss: BN, i: number) => {
    totalLosses[i] = existingLoss.add(newLosses[i]);
  });
  const [finalAssets, finalLosses] = calcLossRecovery(
    lossRecovery,
    newAssets,
    totalLosses
  );
  return { assets: finalAssets, losses: finalLosses, lossRecovery };
}

export async function calcAssetsAfterPnlForFixedSeniorYieldPolicy(
  ctx: Context,
  profit: BN,
  loss: BN,
  lossRecovery: BN,
  assets: BN[],
  losses: BN[],
  adminRnR: AdminRnR,
  lpConfig: LPConfig,
  protocolFeeBps: number
): Promise<any> {
  const profitLessFees = calcPoolFees(profit, adminRnR, protocolFeeBps)[3];

  const currentTS = await ctx.currentTimestamp();
  const poolState = await ctx.poolContext.poolState();
  const { tracker, assets: updatedAssets } =
    calcProfitsForFixedSeniorYieldPolicy(
      currentTS,
      profitLessFees,
      assets,
      lpConfig.fixedSeniorYieldBps,
      poolState.seniorYieldTracker
    );
  const [newAssets, newLosses] = calcLoss(loss, updatedAssets);
  const totalLosses = [new BN(0), new BN(0)];
  losses.forEach((existingLoss: BN, i: number) => {
    totalLosses[i] = existingLoss.add(newLosses[i]);
  });
  const [finalAssets, finalLosses] = calcLossRecovery(
    lossRecovery,
    newAssets,
    totalLosses
  );
  const finalTracker = {
    totalAssets: finalAssets[CONSTANTS.SENIOR_TRANCHE],
    unpaidYield: tracker.unpaidYield,
    lastUpdatedDate: tracker.lastUpdatedDate
  };
  return {
    assets: finalAssets,
    losses: finalLosses,
    lossRecovery,
    tracker: finalTracker
  };
}
