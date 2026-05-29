const ZERO_DECIMAL = ["JPY", "KRW"];

export function toStripeAmount(amount, currency) {
  if (ZERO_DECIMAL.includes(currency.toUpperCase())) return amount;
  return amount * 100;
}