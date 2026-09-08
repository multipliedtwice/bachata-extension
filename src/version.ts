import { readFileSync } from "node:fs";
import * as path from "node:path";

type PackageMetadata = {
  version: string;
};

const packageMetadata = JSON.parse(
  readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
) as PackageMetadata;

export const extensionVersion = packageMetadata.version;
