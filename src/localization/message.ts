export type Localize = (message: string, ...args: Array<string | number>) => string;

export const formatMessage: Localize = (message, ...args) =>
  message.replace(/\{(\d+)\}/gu, (placeholder: string, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? placeholder : String(value);
  });
