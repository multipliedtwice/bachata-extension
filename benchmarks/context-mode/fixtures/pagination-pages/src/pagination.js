const pageCount = (total, size) => Math.floor(total / size);

const pageItems = (items, page, size) => items.slice((page - 1) * size, page * size - 1);

const pages = (items, size) =>
  Array.from({ length: pageCount(items.length, size) }, (_, index) => pageItems(items, index + 1, size));

module.exports = { pageCount, pageItems, pages };
