"use strict";

// Research entry point uses the typed production contract so replays exercise the same resolver.
const selection = require("../../dist/browser/deliverableSelection.js");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const implementationHashes = async () => Object.fromEntries(await Promise.all([
  "scripts/lib/browserDeliverableSelection.cjs",
  "dist/browser/deliverableSelection.js",
  "dist/browser/deliverableTransfer.js",
  "dist/browser/deliverableArchive.js",
  "dist/browser/mutationPolicy.js",
].map(async (relative) => [relative, createHash("sha256")
  .update(await fs.readFile(path.resolve(__dirname, "../..", relative))).digest("hex")])));
module.exports = {
  PROTOCOL: selection.DELIVERABLE_SELECTION_PROTOCOL,
  buildSelectionRequest: selection.buildDeliverableSelectionRequest,
  selectionSchema: selection.deliverableSelectionSchema,
  unambiguousSelection: selection.unambiguousDeliverableSelection,
  resolveSelection: selection.resolveDeliverableSelection,
  implementationHashes,
};
