const Module = require("node:module");

const entry = process.argv[2];
if (!entry) throw new Error("Expected packaged extension entry path");

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "vscode") return {
    l10n: {
      t: (message, ...args) => String(message).replace(/\{(\d+)\}/gu, (match, index) => args[Number(index)] === undefined ? match : String(args[Number(index)])),
    },
  };
  return originalLoad.call(this, request, parent, isMain);
};

require(entry);
