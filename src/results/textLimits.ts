export const RESULT_TEXT_LIMITS: typeof BACHATA_TEXT_LIMITS = require("../shared/textLimits");

export const assertPreparedDraftSize = (text: string | undefined): void => {
  if (text !== undefined && text.length > RESULT_TEXT_LIMITS.preparedDraftUnits) {
    throw new Error(`The draft exceeds the ${String(RESULT_TEXT_LIMITS.preparedDraftUnits)} character limit. Shorten it before saving or opening it.`);
  }
};
