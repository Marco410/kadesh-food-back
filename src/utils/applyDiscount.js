export function applyDiscount(amount, value) {
  const discount = Number(value) || 0;

  if (discount <= 0) return amount;

  // prevent more than 100%
  const safeDiscount = Math.min(discount, 100);

  const finalAmount = amount - (amount * safeDiscount) / 100;

  return Math.max(Math.round(finalAmount), 0); // never below 0
}

