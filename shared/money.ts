/** Dollars (number or printed string like "$1,234.50" / "-3.30") to integer cents. Null when it isn't an amount. */
export function toCents(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 100) : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
}
