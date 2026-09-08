import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const runtime = require("./process-scope.cjs");

export const spawnProcessScope = runtime.spawnProcessScope;
