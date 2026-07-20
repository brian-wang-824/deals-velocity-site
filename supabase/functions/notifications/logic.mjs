export const ALLOWED_THRESHOLDS = ["warming", "hot", "surging", "blazing", "on fire", "inferno"];

export const PUSH_DELIVERY_OPTIONS = Object.freeze({
  // Request enough retention for an overnight Android Doze interval without
  // allowing time-sensitive deal notifications to arrive more than a day late.
  TTL: 24 * 60 * 60,
  // These alerts always produce a user-visible notification, so ask the push
  // service to attempt immediate delivery instead of batching for power savings.
  urgency: "high",
});

export function normalizeThresholds(value) {
  if (!Array.isArray(value)) return [];
  return ALLOWED_THRESHOLDS.filter((item) => value.includes(item));
}

export function enteredHigherHeat(previousLabel, currentLabel) {
  const currentRank = ALLOWED_THRESHOLDS.indexOf(currentLabel);
  if (currentRank === -1) return false;
  if (typeof previousLabel !== "string") return true;
  if (previousLabel === currentLabel) return false;
  const previousRank = ALLOWED_THRESHOLDS.indexOf(previousLabel);
  return currentRank > previousRank;
}
