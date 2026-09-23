const parseAmount = (value) => parseFloat(value);

const formatAmount = (value) => value.toFixed(2);

module.exports = { parseAmount, formatAmount };
