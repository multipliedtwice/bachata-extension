import { createHash } from "node:crypto";
import type { BrowserBridgeServer } from "./bridgeServer";
import type { CapturedAsset } from "./protocol";

export const fetchDeliverableBytes = async (
  asset: CapturedAsset, fetchAsset: BrowserBridgeServer["fetchAsset"], signal: AbortSignal, maximumBytes: number,
): Promise<Buffer> => {
  if (!asset.downloadAvailable) throw new Error("The deliverable is not downloadable; attach the actual file or return structured workspace changes");
  if (asset.size !== undefined && asset.size > maximumBytes) throw new Error("Deliverable exceeds the download limit");
  const chunks: Buffer[] = [];
  let size = 0;
  let sequence = 0;
  let started = false;
  let completed = false;
  let declaredSize: number | undefined;
  const digest = createHash("sha256");
  for await (const event of fetchAsset(asset.id, maximumBytes, signal)) {
    signal.throwIfAborted();
    if (completed || event.assetId !== asset.id) throw new Error("Deliverable transfer identity or order is invalid");
    if (event.type === "start") {
      if (started || (event.size !== undefined && event.size > maximumBytes)) throw new Error("Deliverable transfer start is invalid");
      if (event.name !== asset.name) throw new Error("Deliverable identity changed during download");
      started = true;
      declaredSize = event.size;
    } else if (event.type === "chunk") {
      if (!started || sequence >= 8192 || event.sequence !== sequence++ || event.data.length > maximumBytes - size) throw new Error("Deliverable transfer is out of order or oversized");
      const chunk = Buffer.from(event.data);
      chunks.push(chunk);
      digest.update(chunk);
      size += event.data.length;
    } else {
      if (!started || event.size !== size || (declaredSize !== undefined && declaredSize !== size)
        || (asset.size !== undefined && asset.size !== size) || digest.digest("hex") !== event.sha256) {
        throw new Error("Deliverable transfer failed integrity validation");
      }
      completed = true;
    }
  }
  signal.throwIfAborted();
  if (!completed) throw new Error("Deliverable download ended before completion");
  return Buffer.concat(chunks, size);
};
