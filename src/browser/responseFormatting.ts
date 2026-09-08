import { redactFreeFormText } from "../security/redact";
import { CapturedAsset } from "./protocol";

const formattedSize = (size: number | undefined): string | undefined => {
  if (size === undefined) {
    return undefined;
  }
  if (size < 1_024) {
    return `${String(size)} B`;
  }
  if (size < 1_048_576) {
    return `${(size / 1_024).toFixed(1)} KiB`;
  }
  return `${(size / 1_048_576).toFixed(1)} MiB`;
};

export const renderCapturedAssetSummary = (
  assets: CapturedAsset[],
): string | undefined => {
  if (assets.length === 0) {
    return undefined;
  }
  return [
    "Provider assets:",
    ...assets.map((asset) => {
      const details = [
        asset.kind,
        asset.mimeType,
        formattedSize(asset.size),
        asset.sourceElement,
        asset.downloadAvailable ? "download available" : "metadata only",
      ].filter((value): value is string => Boolean(value));
      const preview = asset.previewText
        ? `\n  preview: ${JSON.stringify(redactFreeFormText(asset.previewText))}`
        : "";
      return `- ${redactFreeFormText(asset.name)} (${details.join(", ")})${preview}`;
    }),
    "These provider assets are not present in the workspace until the user saves them through bachata.",
  ].join("\n");
};
