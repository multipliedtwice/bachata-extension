/**
 * Markdown and code rendering for the webview, apart from the panel that shows it.
 *
 * Agent output is Markdown by convention and unbounded by nature: fences with a language, pipe
 * tables, nested quotes, headings that must sit under the room's own, inline code and links. Every
 * rule about what that text becomes — and the highlight cache that makes re-rendering a transcript
 * affordable — lived in the bootstrap module beside the message loop. It is a rendering
 * responsibility with no state of its own beyond the cache and the code-block registry it feeds,
 * so it stands on its own here and every renderer calls it. `codeBlocks` and `codeBlockSequence`
 * stay in state.ts, where the copy action and the render reset already read them.
 */
const normalizeLanguage = (value: string): string => {
  const key = value.trim().toLowerCase().split(/\s+/u)[0] ?? "";
  const aliases: Record<string, string> = {
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    ts: "typescript",
    shell: "bash",
    sh: "bash",
    zsh: "bash",
    ps1: "powershell",
    py: "python",
    yml: "yaml",
    md: "markdown",
    patch: "diff",
    plaintext: "plain",
    text: "plain",
    txt: "plain",
  };
  // Own-property lookup only: a bare index reaches Object.prototype, so a fence language of
  // `constructor` returns a function and `__proto__` returns an object, and that value then
  // lands in the toolbar label and the language- class. Agent output chooses this string.
  return (Object.hasOwn(aliases, key) ? aliases[key] : key) || "plain";
};

// Highlighting is the expensive part of a render, and a transcript re-renders on every host
// message with the same blocks in it. The cache is keyed by language and text, and dropped
// whole once it holds more blocks than a transcript window can show.
const highlightCache = new Map<string, string>();
const highlightCacheLimit = 1_200;

const highlightedCode = (code: string, language: string): string => {
  const normalized = normalizeLanguage(language);
  const grammar = Prism.languages[normalized];
  if (!grammar) {
    return escapeHtml(code);
  }
  const key = `${normalized}\u0000${code}`;
  const cached = highlightCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  let html: string;
  try {
    html = Prism.highlight(code, grammar, normalized);
  } catch {
    html = escapeHtml(code);
  }
  if (highlightCache.size >= highlightCacheLimit) {
    highlightCache.clear();
  }
  highlightCache.set(key, html);
  return html;
};

const renderInline = (value: string): string => {
  let output = "";
  let index = 0;
  while (index < value.length) {
    if (value.startsWith("**", index)) {
      const end = value.indexOf("**", index + 2);
      if (end > index + 2) {
        output += `<strong>${renderInline(value.slice(index + 2, end))}</strong>`;
        index = end + 2;
        continue;
      }
    }
    if (value[index] === "`" && !value.startsWith("```", index)) {
      const end = value.indexOf("`", index + 1);
      if (end > index + 1) {
        output += `<code>${escapeHtml(value.slice(index + 1, end))}</code>`;
        index = end + 1;
        continue;
      }
    }
    if (value[index] === "[") {
      const labelEnd = value.indexOf("](", index + 1);
      const urlEnd = labelEnd >= 0 ? value.indexOf(")", labelEnd + 2) : -1;
      if (labelEnd > index && urlEnd > labelEnd + 2) {
        const label = value.slice(index + 1, labelEnd);
        const url = value.slice(labelEnd + 2, urlEnd);
        if (/^https?:\/\//iu.test(url)) {
          output += `<a href="${escapeAttribute(url)}">${renderInline(label)}</a>`;
          index = urlEnd + 1;
          continue;
        }
      }
    }
    if (value[index] === "*" || value[index] === "_") {
      const marker = value[index] ?? "*";
      const end = value.indexOf(marker, index + 1);
      if (end > index + 1) {
        output += `<em>${renderInline(value.slice(index + 1, end))}</em>`;
        index = end + 1;
        continue;
      }
    }
    output += escapeHtml(value[index] ?? "");
    index += 1;
  }
  return output;
};

const codeBlockHtml = (code: string, language: string): string => {
  const normalized = normalizeLanguage(language);
  const id = `code-${String(++codeBlockSequence)}`;
  // A transcript holds many of both, so neither the copy control nor the scrollable block can be
  // named "Copy" and "pre": a control list of identical entries names nothing.
  const label = `${normalized === "plain" ? "text" : normalized} code block`;
  codeBlocks.set(id, code);
  // The block becomes a focusable region only once it is known to scroll; see settleCodeBlockFocus.
  return `<section class="code-block">
    <div class="code-toolbar"><span>${escapeHtml(normalized === "plain" ? "text" : normalized)}</span><button data-action="copy-code" data-code-id="${id}" aria-label="Copy ${escapeAttribute(label)}">Copy</button></div>
    <pre class="language-${escapeAttribute(normalized)}" data-code-region="${escapeAttribute(label)}"><code class="language-${escapeAttribute(normalized)}">${highlightedCode(code, normalized)}</code></pre>
  </section>`;
};

// A pipe table: a header row, a delimiter row of dashes, then body rows, every one starting
// with `|`. Reviewer answers use them for findings, and unrendered they arrive as raw pipes.
const markdownTableCells = (line: string): string[] =>
  line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());

const isMarkdownTableDelimiter = (line: string | undefined): boolean =>
  line !== undefined && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/u.test(line);

const readMarkdownTable = (lines: string[], start: number): string[][] => {
  const header = lines[start];
  if (header === undefined || !header.trim().startsWith("|") || !isMarkdownTableDelimiter(lines[start + 1])) {
    return [];
  }
  const rows = [markdownTableCells(header)];
  let index = start + 2;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || !line.trim().startsWith("|")) break;
    rows.push(markdownTableCells(line));
    index += 1;
  }
  return rows;
};

const markdownTableHtml = (rows: string[][]): string => {
  const [header, ...body] = rows;
  // A header cell says which cells it heads, so a screen reader reading a body cell can name its
  // column rather than leaving the reader to count.
  const cells = (row: string[], tag: "th" | "td"): string =>
    row.map((cell) => `<${tag}${tag === "th" ? ` scope="col"` : ""}>${renderInline(cell)}</${tag}>`).join("");
  return `<div class="markdown-table"><table><thead><tr>${cells(header ?? [], "th")}</tr></thead>${body.length > 0 ? `<tbody>${body.map((row) => `<tr>${cells(row, "td")}</tr>`).join("")}</tbody>` : ""}</table></div>`;
};

const isBlockStart = (line: string): boolean =>
  /^#{1,6}\s+/u.test(line) ||
  /^\s*\|/u.test(line) ||
  /^\s*[-*+]\s+/u.test(line) ||
  /^\s*\d+[.)]\s+/u.test(line) ||
  /^>\s?/u.test(line) ||
  /^(```+|~~~+)/u.test(line) ||
  /^\s*([-*_])(?:\s*\1){2,}\s*$/u.test(line);

// Each blockquote level strips one `>` and recurses, so a long run of leading `>` in agent
// output recurses once per character and overflows the stack, dropping the whole panel into
// its render-failure banner. Past the cap the remaining quote is rendered as inline text.
const maximumQuoteDepth = 16;

const renderMarkdown = (value: string, quoteDepth = 0): string => {
  const lines = value.replaceAll("\r\n", "\n").split("\n");
  const blocks: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    // The loop bound proves the line is there; saying it once keeps every block reader
    // below working with a line rather than a maybe-line.
    if (line === undefined) {
      index += 1;
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = line.match(/^\s*(```+|~~~+)\s*([^\s`]*)?.*$/u);
    if (fence) {
      const marker = fence[1] ?? "```";
      const language = fence[2] ?? "plain";
      const closing = new RegExp(`^\\s*${marker[0] ?? "`"}{${String(marker.length)},}\\s*$`, "u");
      const content: string[] = [];
      index += 1;
      while (index < lines.length) {
        const next = lines[index];
        if (next === undefined || closing.test(next)) break;
        content.push(next);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push(codeBlockHtml(content.join("\n"), language));
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/u);
    if (heading) {
      // A heading inside an answer sits under the room's own h1 and h2, so an answer's "#" is
      // an h3 here; otherwise every agent that titles its reply adds a second h1 to the page.
      const level = Math.min(6, (heading[1] ?? "#").length + 2);
      blocks.push(`<h${String(level)}>${renderInline(heading[2] ?? "")}</h${String(level)}>`);
      index += 1;
      continue;
    }
    const tableRows = readMarkdownTable(lines, index);
    if (tableRows.length > 0) {
      blocks.push(markdownTableHtml(tableRows));
      index += tableRows.length + 1;
      continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/u.test(line)) {
      blocks.push("<hr>");
      index += 1;
      continue;
    }
    if (/^\s*[-*+]\s+/u.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const next = lines[index];
        if (next === undefined || !/^\s*[-*+]\s+/u.test(next)) break;
        items.push(next.replace(/^\s*[-*+]\s+/u, ""));
        index += 1;
      }
      blocks.push(`<ul>${items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/u.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const next = lines[index];
        if (next === undefined || !/^\s*\d+[.)]\s+/u.test(next)) break;
        items.push(next.replace(/^\s*\d+[.)]\s+/u, ""));
        index += 1;
      }
      blocks.push(`<ol>${items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ol>`);
      continue;
    }
    if (/^>\s?/u.test(line)) {
      const quotes: string[] = [];
      while (index < lines.length) {
        const next = lines[index];
        if (next === undefined || !/^>\s?/u.test(next)) break;
        quotes.push(next.replace(/^>\s?/u, ""));
        index += 1;
      }
      blocks.push(
        quoteDepth >= maximumQuoteDepth
          ? `<blockquote>${quotes.map(renderInline).join("<br>")}</blockquote>`
          : `<blockquote>${renderMarkdown(quotes.join("\n"), quoteDepth + 1)}</blockquote>`,
      );
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (next === undefined || !next.trim() || isBlockStart(next)) break;
      paragraph.push(next);
      index += 1;
    }
    blocks.push(`<p>${paragraph.map(renderInline).join("<br>")}</p>`);
  }
  return blocks.join("");
};
