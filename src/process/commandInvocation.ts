import * as path from "node:path";

const nodeScriptExtensions = new Set([".js", ".cjs", ".mjs"]);

export type CommandInvocation = {
  command: string;
  args: string[];
};

export const commandInvocation = (
  command: string,
  args: string[],
): CommandInvocation =>
  nodeScriptExtensions.has(path.extname(command).toLowerCase())
    ? { command: process.execPath, args: [command, ...args] }
    : { command, args };
