import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(here, "..", "public");
const source = join(siteRoot, "index.html");

export const LOCALES = [
  { tag: "ru", label: "Русский" },
  { tag: "zh-cn", label: "简体中文", htmlLang: "zh-Hans" },
  { tag: "pt-br", label: "Português (Brasil)", htmlLang: "pt-BR" },
  { tag: "th", label: "ไทย" },
  { tag: "de", label: "Deutsch" },
];

const SITE_URL = "https://multipliedtwice.github.io/bachata-extension/";
const OPAQUE = new Set(["script", "style", "svg"]);
const ATTRIBUTES = ["alt", "title", "aria-label", "placeholder"];

const tokenize = (html) => html.split(/(<[^>]+>)/u).filter((part) => part !== "");

const isTag = (token) => token.startsWith("<") && token.endsWith(">");
const tagName = (token) => (/^<\/?\s*([a-zA-Z0-9-]+)/u.exec(token)?.[1] ?? "").toLowerCase();
const isClosing = (token) => token.startsWith("</");
const isSelfClosing = (token) => token.endsWith("/>") || ["meta", "link", "img", "br", "hr", "input"].includes(tagName(token));

const walk = (html, visitText, visitAttribute) => {
  const tokens = tokenize(html);
  const opaque = [];
  return tokens.map((token) => {
    if (!isTag(token)) return opaque.length > 0 ? token : visitText(token);
    const name = tagName(token);
    if (OPAQUE.has(name) && !isSelfClosing(token)) {
      if (isClosing(token)) opaque.pop();
      else opaque.push(name);
      return token;
    }
    if (opaque.length > 0 || isClosing(token)) return token;
    return token.replace(/([a-zA-Z-]+)="([^"]*)"/gu, (whole, attribute, value) => {
      const translatable = ATTRIBUTES.includes(attribute)
        || (attribute === "content" && /name="(description|twitter:title|twitter:description)"|property="og:(title|description|image:alt)"/u.test(token));
      return translatable ? `${attribute}="${visitAttribute(value, attribute)}"` : whole;
    });
  }).join("");
};

const decode = (value) => value
  .replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'");

const encode = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const extract = (html) => {
  const strings = new Set();
  const keep = (value) => {
    const trimmed = value.trim();
    if (trimmed.length > 1 && /\p{L}/u.test(trimmed)) strings.add(trimmed);
    return value;
  };
  walk(html, keep, (value) => { keep(value); return value; });
  return [...strings];
};

const translateText = (token, messages) => {
  const match = /^(\s*)([\s\S]*?)(\s*)$/u.exec(token);
  const [, before, body, after] = match;
  if (body === "") return token;
  const translated = messages[decode(body)];
  return translated === undefined ? token : `${before}${encode(translated)}${after}`;
};

const headFor = (locale, tags) => {
  const alternates = [
    `<link rel="alternate" hreflang="x-default" href="${SITE_URL}">`,
    `<link rel="alternate" hreflang="en" href="${SITE_URL}">`,
    ...tags.map((item) => `<link rel="alternate" hreflang="${item.htmlLang ?? item.tag}" href="${SITE_URL}${item.tag}/">`),
  ];
  return alternates.map((line) => `\n${line}`).join("");
};

const switcherFor = (locale, tags) => {
  const entries = [{ tag: "", label: "English" }, ...tags].map((item) => {
    const href = item.tag === "" ? SITE_URL : `${SITE_URL}${item.tag}/`;
    const current = item.tag === locale ? ' aria-current="true"' : "";
    return `<a href="${href}" hreflang="${item.tag === "" ? "en" : item.htmlLang ?? item.tag}"${current}>${item.label}</a>`;
  }).join("");
  return `<nav class="language-switcher" aria-label="Language">${entries}</nav>`;
};

const stripGenerated = (html) => html
  .replace(/\n<link rel="alternate"[^>]*>/gu, "")
  .replace(/<nav class="language-switcher"[\s\S]*?<\/nav>/u, "");

export const render = (source, locale, messages, tags) => {
  const html = stripGenerated(source);
  const localised = walk(html, (token) => translateText(token, messages), (value) => encode(messages[decode(value)] ?? decode(value)));
  const base = locale === "" ? "" : "../";
  const imageBase = locale === "" ? "img/" : `${base}img/${locale}/`;
  return localised
    .replace(/<html lang="en">/u, `<html lang="${locale === "" ? "en" : tags.find((item) => item.tag === locale)?.htmlLang ?? locale}">`)
    .replace(/<link rel="canonical" href="[^"]*">/u, `<link rel="canonical" href="${SITE_URL}${locale ? `${locale}/` : ""}">${headFor(locale, tags)}`)
    .replace(/<meta property="og:url" content="[^"]*">/u, `<meta property="og:url" content="${SITE_URL}${locale ? `${locale}/` : ""}">`)
    .replaceAll('href="assets/', `href="${base}assets/`)
    .replaceAll('src="assets/', `src="${base}assets/`)
    .replaceAll('href="img/', `href="${imageBase}`)
    .replaceAll('src="img/', `src="${imageBase}`)
    .replace(/<\/nav>/u, `</nav>${switcherFor(locale, tags)}`);
};

const messagesFor = (tag) => {
  const path = join(here, `${tag}.json`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

const main = () => {
  const html = readFileSync(source, "utf8");
  if (process.argv.includes("--extract")) {
    const strings = extract(stripGenerated(html));
    writeFileSync(join(here, "en.json"), `${JSON.stringify(Object.fromEntries(strings.map((value) => [value, value])), null, 2)}\n`);
    process.stdout.write(`extracted ${strings.length} strings\n`);
    return;
  }
  const available = LOCALES.filter((locale) => messagesFor(locale.tag) !== undefined);
  for (const locale of available) {
    const target = join(siteRoot, locale.tag);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "index.html"), render(html, locale.tag, messagesFor(locale.tag), available));
    process.stdout.write(`wrote ${locale.tag}/index.html\n`);
  }
  writeFileSync(source, render(html, "", {}, available));
  const urls = ["", ...available.map((locale) => `${locale.tag}/`)].map((path) => {
    const alternates = [
      `      <xhtml:link rel="alternate" hreflang="x-default" href="${SITE_URL}"/>`,
      `      <xhtml:link rel="alternate" hreflang="en" href="${SITE_URL}"/>`,
      ...available.map((locale) => `      <xhtml:link rel="alternate" hreflang="${locale.htmlLang ?? locale.tag}" href="${SITE_URL}${locale.tag}/"/>`),
    ].join("\n");
    return `  <url>\n    <loc>${SITE_URL}${path}</loc>\n${alternates}\n  </url>`;
  }).join("\n");
  writeFileSync(join(siteRoot, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`);
  process.stdout.write(`updated index.html and sitemap.xml with ${available.length} alternates\n`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
