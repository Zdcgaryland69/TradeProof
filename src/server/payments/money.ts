// Exact money handling: amounts are integers in the currency's minor unit (USD cents).
// PayPal sends decimal strings; they are parsed digit by digit, never through floating point.

const MINOR_DIGITS: Readonly<Record<string, number>> = { USD: 2 };

export function minorDigits(currency: string): number | undefined {
  return MINOR_DIGITS[currency];
}

/** "1.00" + "USD" → 100. Returns null for unsupported currencies or malformed / over-precise values. */
export function toMinorUnits(value: string, currency: string): number | null {
  const digits = minorDigits(currency);
  if (digits === undefined) return null;
  const match = /^(\d{1,13})(?:\.(\d{1,10}))?$/.exec(value);
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > digits && /[1-9]/.test(fraction.slice(digits))) return null;
  const fractionPadded = (fraction + "0".repeat(digits)).slice(0, digits);
  const minor = Number(match[1]) * 10 ** digits + (digits > 0 ? Number(fractionPadded) : 0);
  return Number.isSafeInteger(minor) ? minor : null;
}

/** 100 + "USD" → "1.00". */
export function formatMinorUnits(minor: number, currency: string): string {
  const digits = minorDigits(currency);
  if (digits === undefined) throw new Error(`Unsupported currency ${currency}`);
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error("Amount must be a non-negative integer of minor units");
  if (digits === 0) return String(minor);
  const base = 10 ** digits;
  return `${Math.floor(minor / base)}.${String(minor % base).padStart(digits, "0")}`;
}
