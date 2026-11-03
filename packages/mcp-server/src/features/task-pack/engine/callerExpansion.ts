// callerExpansion — extracted implementation; imports point to the owning modules.
import { callerExpansionEntryCountForTest } from "./answerPackBuilder.js";
import { concernRecoveryEntryCountForTest } from "./answerPackBuilder.js";

export function concernRecoveryEntryCount(): number {
  return concernRecoveryEntryCountForTest;
}

export function callerExpansionEntryCount(): number {
  return callerExpansionEntryCountForTest;
}
