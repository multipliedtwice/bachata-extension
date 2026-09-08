const { writeFileSync } = require("node:fs");

const [pidFile] = process.argv.slice(2);
writeFileSync(pidFile, String(process.pid), "utf8");
process.on("SIGTERM", () => undefined);
setInterval(() => undefined, 1_000);
