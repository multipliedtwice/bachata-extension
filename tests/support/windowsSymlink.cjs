const test = require("node:test");

const symlinkFixtureTest = (name, optionsOrBody, body) => {
  const options = typeof optionsOrBody === "function" ? undefined : optionsOrBody;
  const run = body ?? optionsOrBody;
  const wrapped = async (context) => {
    try {
      await run(context);
    } catch (error) {
      if (
        process.platform === "win32" &&
        error?.code === "EPERM" &&
        error?.syscall === "symlink"
      ) {
        context.skip("Windows denied symbolic-link creation for this fixture");
        return;
      }
      throw error;
    }
  };
  if (options === undefined) test(name, wrapped);
  else test(name, options, wrapped);
};

module.exports = { symlinkFixtureTest };
