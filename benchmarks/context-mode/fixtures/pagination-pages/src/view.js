const { pages } = require("./pagination");

const render = (items, size) => pages(items, size)
  .map((page, index) => `Page ${String(index + 1)}: ${page.join(", ")}`)
  .join("\n");

module.exports = { render };
