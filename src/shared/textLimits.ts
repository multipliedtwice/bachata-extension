const BACHATA_TEXT_LIMITS = Object.freeze({
  preparedDraftUnits: 131_072,
  readableMarkdownUnits: 65_536,
  handoffMarkdownUnits: 65_536,
  catalogJsonBytes: 262_144,
  maximumVisitedEntries: 4_096,
  maximumInputTextUnits: 262_144,
  maximumEntryTextUnits: 16_384,
  maximumDepth: 12,
  maximumSectionEntries: 64,
});

if (typeof module !== "undefined" && module.exports) {
  module.exports = BACHATA_TEXT_LIMITS;
}
