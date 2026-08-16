/**
 * Shared full-read limits.
 *
 * Keep policy constants that are consumed by both the governor and its
 * adaptive adviser here so those two decision modules do not import each
 * other.
 */
export const PER_TASK_FULL_CAP = 6;
