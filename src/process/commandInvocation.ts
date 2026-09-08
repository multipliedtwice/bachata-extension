import * as path from "node:path";

const nodeScriptExtensions = new Set([".js", ".cjs", ".mjs"]);

export type CommandInvocation = {
  command: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
};

export const nodeProcessEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  process.versions.electron
    ? {
      ...Object.fromEntries(Object.entries(environment).filter(([key]) => key.toUpperCase() !== "ELECTRON_RUN_AS_NODE")),
      ELECTRON_RUN_AS_NODE: "1",
    }
    : environment;

export const commandInvocation = (
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): CommandInvocation =>
  nodeScriptExtensions.has(path.extname(command).toLowerCase())
    ? { command: process.execPath, args: [command, ...args], environment: nodeProcessEnvironment(environment) }
    : { command, args, environment };
