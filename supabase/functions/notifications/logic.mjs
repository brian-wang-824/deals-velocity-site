export const ALLOWED_THRESHOLDS = ["warming", "hot", "surging", "blazing", "on fire", "inferno"];

export function normalizeThresholds(value) {
  if (!Array.isArray(value)) return [];
  return ALLOWED_THRESHOLDS.filter((item) => value.includes(item));
}

export function enteredHigherStamp(previousLabel, currentLabel) {
  if (typeof previousLabel !== "string") return false;
  const currentRank = ALLOWED_THRESHOLDS.indexOf(currentLabel);
  if (currentRank === -1 || previousLabel === currentLabel) return false;
  const previousRank = ALLOWED_THRESHOLDS.indexOf(previousLabel);
  return currentRank > previousRank;
}
