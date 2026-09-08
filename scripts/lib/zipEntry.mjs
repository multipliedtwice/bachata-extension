import yauzl from "yauzl";

export const MAXIMUM_MANIFEST_RECORDS = 4096;
export const MAXIMUM_MANIFEST_BYTES = 1_048_576;

export const MAXIMUM_ARCHIVE_DECLARED_BYTES = 512 * 1_048_576;

const readEntryFrom = (open, label, entryName, limits) => new Promise((resolve, reject) => {
  const maximumRecords = limits.maximumRecords ?? MAXIMUM_MANIFEST_RECORDS;
  const maximumBytes = limits.maximumBytes ?? MAXIMUM_MANIFEST_BYTES;
  const maximumDeclared = limits.maximumDeclaredBytes ?? MAXIMUM_ARCHIVE_DECLARED_BYTES;
  const file = label;
  open((openError, zip) => {
    if (openError) {
      reject(openError);
      return;
    }
    let declaredBytes = 0;
    let settled = false;
    let found;
    let records = 0;
    const seen = new Set();
    const fail = (message) => {
      if (settled) return;
      settled = true;
      try {
        zip.close();
      } catch {
        // The archive is already closed; the rejection below is the outcome.
      }
      reject(new Error(message));
    };
    const failWith = (error) => {
      if (settled) return;
      settled = true;
      try {
        zip.close();
      } catch {
        // The archive is already closed; the rejection below is the outcome.
      }
      reject(error);
    };
    zip.on("error", failWith);
    zip.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(found);
      }
    });
    zip.on("entry", (entry) => {
      records += 1;
      if (records > maximumRecords) {
        fail(`${file} declares more than ${String(maximumRecords)} records`);
        return;
      }
      if (seen.has(entry.fileName)) {
        fail(`${file} declares a duplicate entry: ${entry.fileName}`);
        return;
      }
      seen.add(entry.fileName);
      declaredBytes += entry.uncompressedSize;
      if (declaredBytes > maximumDeclared) {
        fail(`${file} declares more than ${String(maximumDeclared)} uncompressed bytes`);
        return;
      }
      if (entry.fileName !== entryName) {
        zip.readEntry();
        return;
      }
      if (entry.uncompressedSize > maximumBytes) {
        fail(
          `${file} declares ${entryName} as ${String(entry.uncompressedSize)} bytes, above the ${String(maximumBytes)}-byte limit`,
        );
        return;
      }
      zip.openReadStream(entry, (streamError, stream) => {
        if (streamError) {
          failWith(streamError);
          return;
        }
        const chunks = [];
        let bytes = 0;
        stream.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > maximumBytes) {
            stream.destroy();
            fail(`${file} streams more than ${String(maximumBytes)} bytes for ${entryName}`);
            return;
          }
          chunks.push(chunk);
        });
        stream.on("error", failWith);
        stream.on("end", () => {
          if (settled) return;
          if (bytes !== entry.uncompressedSize) {
            fail(
              `${file} streams ${String(bytes)} bytes for ${entryName} but declares ${String(entry.uncompressedSize)}`,
            );
            return;
          }
          found = Buffer.concat(chunks);
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
});

export const readZipEntry = (file, entryName, limits = {}) =>
  readEntryFrom(
    (callback) => yauzl.open(file, { lazyEntries: true }, callback),
    file,
    entryName,
    limits,
  );

export const readZipEntryFromBuffer = (buffer, label, entryName, limits = {}) =>
  readEntryFrom(
    (callback) => yauzl.fromBuffer(buffer, { lazyEntries: true }, callback),
    label,
    entryName,
    limits,
  );
