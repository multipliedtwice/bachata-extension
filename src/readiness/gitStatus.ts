// `--porcelain=v1 -z` emits pathnames verbatim: no C-style quoting, no escaping, NUL as the
// only delimiter. Every decoded pathname character between delimiters is part of the name,
// including quote characters that a filename genuinely contains. Git path bytes that are not
// valid UTF-8 are decoded by the caller before this parser sees them and are out of scope here.
export type PorcelainStatusEntry = {
  code: string;
  paths: string[];
};

export const parsePorcelainStatusRecords = (status: string): PorcelainStatusEntry[] => {
  const records = status.split("\0");
  const entries: PorcelainStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== " ") {
      throw new Error("Git returned an invalid porcelain status record");
    }
    const code = record.slice(0, 2);
    const paths = [record.slice(3)];
    if (code.includes("R") || code.includes("C")) {
      const source = records[index + 1];
      if (!source) {
        throw new Error("Git returned an incomplete rename status record");
      }
      paths.push(source);
      index += 1;
    }
    entries.push({ code, paths });
  }
  return entries;
};

export const parsePorcelainDirtyPaths = (status: string): string[] =>
  Array.from(new Set(
    parsePorcelainStatusRecords(status)
      .flatMap((entry) => entry.paths)
      .filter((value) => value.length > 0),
  ));
