/**
 * @forge/kernel-money — the runtime half of kernel.money@1.0.0
 *
 * Integer minor units only. Any capability handling money uses this type;
 * floating point currency anywhere in a generated product is a defect.
 *
 * Spec: catalog/kernel/kernel.money.capability.json
 */

export { Money, sum, type Factor, type MoneyFormatOptions, type MoneyJSON } from './money.js'
export { allocate, allocateEvenly, allocationPreservesTotal, type Ratio } from './allocate.js'
export {
  clearCurrencies,
  getCurrency,
  isKnownCurrency,
  listCurrencies,
  minorUnitScale,
  registerCurrency,
  type CurrencyDefinition,
} from './currency.js'
export { convert, invertRate, type ExchangeRate } from './exchange.js'
export {
  AllocationError,
  CurrencyMismatchError,
  MoneyError,
  MoneyPrecisionError,
  UnknownCurrencyError,
} from './errors.js'
export { DEFAULT_ROUNDING, type RoundingMode } from './rational.js'
export { currencies, exchangeRates, type CurrencyRow, type ExchangeRateRow } from './schema.js'
