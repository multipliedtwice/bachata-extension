const { FEE_BPS } = require("./fees");
const { parseAmount, formatAmount } = require("./money");

const feeFor = (amount, type) => Math.round(amount * FEE_BPS[type] / 10000 * 100) / 100;

const balance = (entries) => {
  let total = 0;
  for (const entry of entries) {
    const amount = parseAmount(entry.amount);
    total += amount - feeFor(amount, entry.type);
  }
  return formatAmount(total);
};

module.exports = { feeFor, balance };
