const { balance } = require("./ledger");

const report = (account, entries) => `${account}: ${balance(entries)} (${String(entries.length)} entries)`;

module.exports = { report };
