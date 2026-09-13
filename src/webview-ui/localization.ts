type LocalizationMessages = Readonly<Record<string, string>>;

const canonicalLocale = (value: unknown): string => {
  if (typeof value !== "string") return "en";
  try {
    return Intl.getCanonicalLocales(value.replaceAll("_", "-"))[0] ?? "en";
  } catch {
    return "en";
  }
};

const localizationSettings = (() => {
  try {
    const value: unknown = JSON.parse(document.getElementById("bachata-localization")?.textContent ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return { locale: "en", messages: {} };
    const settings = value as Record<string, unknown>;
    const messages = settings.messages && typeof settings.messages === "object" && !Array.isArray(settings.messages)
      ? Object.fromEntries(Object.entries(settings.messages).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
    return { locale: canonicalLocale(settings.locale), messages };
  } catch {
    return { locale: "en", messages: {} };
  }
})();

const webviewLocale = localizationSettings.locale;

const messageParameters = (message: string): string =>
  [...new Set(Array.from(message.matchAll(/\{(\d+)\}/gu), (match) => match[1]))].sort().join(",");

const translateMessage = (
  messages: LocalizationMessages,
  message: string,
  args: ReadonlyArray<string | number>,
): string => {
  const translated = Object.hasOwn(messages, message) ? messages[message] : undefined;
  const template = translated?.trim() && messageParameters(translated) === messageParameters(message) ? translated : message;
  return template.replace(/\{(\d+)\}/gu, (placeholder: string, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? placeholder : String(value);
  });
};

const localize = (message: string, ...args: Array<string | number>): string =>
  translateMessage(localizationSettings.messages, message, args.map((value) => typeof value === "number" ? formatNumber(value) : value));

const formatNumber = (value: number, options: Intl.NumberFormatOptions = {}): string =>
  new Intl.NumberFormat(webviewLocale, options).format(value);
