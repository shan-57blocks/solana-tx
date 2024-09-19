import * as anchor from '@coral-xyz/anchor';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import {
  convertToPayPeriodDuration,
  PayPeriodDuration,
  PayPeriodDurationType
} from './Base';
import { CONSTANTS } from './Constants';

dayjs.extend(utc);

export function getTotalDaysInFullPeriod(
  periodDuration: PayPeriodDurationType
) {
  const duration = convertToPayPeriodDuration(periodDuration);
  if (duration === PayPeriodDuration.Monthly) {
    return CONSTANTS.DAYS_IN_A_MONTH;
  } else if (duration === PayPeriodDuration.Quarterly) {
    return CONSTANTS.DAYS_IN_A_QUARTER;
  } else if (duration === PayPeriodDuration.SemiAnnually) {
    return CONSTANTS.DAYS_IN_A_HALF_YEAR;
  }

  throw new Error('Invalid period duration');
}

export function getStartDateOfNextPeriod(
  periodDuration: PayPeriodDurationType,
  timestamp: number
) {
  let date;
  const duration = convertToPayPeriodDuration(periodDuration);
  if (duration === PayPeriodDuration.Monthly) {
    date = getStartOfNextMonth(timestamp);
  } else if (duration === PayPeriodDuration.Quarterly) {
    date = getStartOfNextQuarter(timestamp);
  } else if (duration === PayPeriodDuration.SemiAnnually) {
    date = getStartOfNextHalfYear(timestamp);
  } else {
    throw new Error('Invalid period duration');
  }
  return new anchor.BN(date);
}

export function getStartDateOfPeriod(
  periodDuration: PayPeriodDurationType,
  timestamp: number
) {
  let date;
  const duration = convertToPayPeriodDuration(periodDuration);
  if (duration === PayPeriodDuration.Monthly) {
    date = getStartOfMonth(timestamp);
  } else if (duration === PayPeriodDuration.Quarterly) {
    date = getStartOfQuarter(timestamp);
  } else if (duration === PayPeriodDuration.SemiAnnually) {
    date = getStartOfHalfYear(timestamp);
  } else {
    throw new Error('Invalid period duration');
  }
  return new anchor.BN(date);
}

export function getDaysDiff(
  startDate: number | anchor.BN,
  endDate: number | anchor.BN
): number {
  startDate = new anchor.BN(startDate);
  endDate = new anchor.BN(endDate);
  if (startDate.isZero()) {
    throw new Error('startDate cannot be 0');
  }
  if (startDate.gt(endDate)) {
    throw new Error(
      `startDate ${startDate} cannot be later than endDate ${endDate}`
    );
  }

  const start = dayjs.unix(startDate.toNumber()).utc();
  const end = dayjs.unix(endDate.toNumber()).utc();

  const startDay = Math.min(start.date(), CONSTANTS.DAYS_IN_A_MONTH);
  const endDay = Math.min(end.date(), CONSTANTS.DAYS_IN_A_MONTH);

  if (start.year() === end.year() && start.month() === end.month()) {
    return endDay - startDay;
  }

  // `dayjs` returns the number of whole months, so we need to use the start of the month of the start date
  // to get the correct number of months passed.
  const numMonthsPassed = end.diff(start.startOf('month'), 'month');

  // The final result is given by the sum of the following three components:
  // 1. The number of days between the start date and the end of the start month.
  // 2. The number of days in whole months passed.
  // 3. The number of days between the start of the end month and the end date.
  return numMonthsPassed * CONSTANTS.DAYS_IN_A_MONTH + endDay - startDay;
}

export function getStartOfNextDay(timestamp: number): anchor.BN {
  const startOfNextDay = dayjs
    .unix(timestamp)
    .utc()
    .add(1, 'day')
    .startOf('day');
  return new anchor.BN(startOfNextDay.unix());
}

export function getStartOfNextMonth(timestamp: number): number {
  const startOfNextMonth = dayjs
    .unix(timestamp)
    .utc()
    .add(1, 'month')
    .startOf('month');
  return startOfNextMonth.unix();
}

export function getMaturityDate(
  periodDuration: PayPeriodDurationType,
  numPeriods: number,
  timestamp: number
) {
  const startOfNextPeriod = getStartDateOfNextPeriod(
    periodDuration,
    timestamp
  ).toNumber();
  if (numPeriods === 0) {
    return new anchor.BN(startOfNextPeriod);
  }
  let monthCount = numPeriods;
  const duration = convertToPayPeriodDuration(periodDuration);
  if (duration === PayPeriodDuration.Quarterly) {
    monthCount *= 3;
  } else if (duration === PayPeriodDuration.SemiAnnually) {
    monthCount *= 6;
  }
  const maturityDate = dayjs
    .unix(startOfNextPeriod)
    .utc()
    .add(monthCount, 'months');
  return new anchor.BN(maturityDate.unix());
}

export function getStartOfDay(timestamp: number) {
  return dayjs.unix(timestamp).utc().startOf('day').unix();
}

export function getDateAfterPeriods(
  periodDuration: PayPeriodDurationType,
  numPeriods: number,
  timestamp: number
) {
  let monthCount = numPeriods;
  const duration = convertToPayPeriodDuration(periodDuration);
  if (duration === PayPeriodDuration.Quarterly) {
    monthCount *= 3;
  } else if (duration === PayPeriodDuration.SemiAnnually) {
    monthCount *= 6;
  }

  return dayjs.unix(timestamp).utc().add(monthCount, 'month').unix();
}

export function getNumPeriodsPassed(
  periodDuration: PayPeriodDurationType,
  startDate: number | anchor.BN,
  endDate: number | anchor.BN
) {
  startDate = new anchor.BN(startDate);
  endDate = new anchor.BN(endDate);
  if (startDate.gt(endDate)) {
    throw new Error(
      `startDate ${startDate} cannot be later than endDate ${endDate}`
    );
  }

  if (startDate.eq(endDate)) {
    return 0;
  }

  const periodStart = getStartDateOfPeriod(
    periodDuration,
    startDate.toNumber()
  );
  return Math.floor(
    getDaysDiff(periodStart, endDate) / getTotalDaysInFullPeriod(periodDuration)
  );
}

function getStartOfNextQuarter(timestamp: number): number {
  const date = dayjs.unix(timestamp);
  const year = date.year();
  const month = date.month() + 1; // Months are 0-based.

  let quarter = Math.floor((month - 1) / 3) + 1;
  if (quarter === 4) {
    quarter = 1;
    return dayjs(Date.UTC(year + 1, (quarter - 1) * 3, 1))
      .utc()
      .startOf('day')
      .unix();
  } else {
    quarter++;
    return dayjs(Date.UTC(year, (quarter - 1) * 3, 1))
      .utc()
      .startOf('day')
      .unix();
  }
}

function getStartOfNextHalfYear(timestamp: number): number {
  const date = dayjs.unix(timestamp);
  const year = date.year();
  const month = date.month() + 1;

  if (month > 6) {
    return dayjs(Date.UTC(year + 1, 0, 1))
      .utc()
      .startOf('day')
      .unix();
  } else {
    return dayjs(Date.UTC(year, 6, 1))
      .utc()
      .startOf('day')
      .unix();
  }
}

function getStartOfMonth(timestamp: number): number {
  return dayjs.unix(timestamp).utc().startOf('month').unix();
}

function getStartOfQuarter(timestamp: number): number {
  const month = dayjs.unix(timestamp).utc().month();
  const startMonth = Math.floor(month / 3) * 3;
  return dayjs.unix(timestamp).utc().month(startMonth).startOf('month').unix();
}

function getStartOfHalfYear(timestamp: number): number {
  const month = dayjs.unix(timestamp).utc().month();
  const startMonth = month < 6 ? 0 : 6;
  return dayjs.unix(timestamp).utc().month(startMonth).startOf('month').unix();
}
