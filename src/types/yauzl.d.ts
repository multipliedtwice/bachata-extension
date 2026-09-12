declare module "yauzl" {
  import { EventEmitter } from "node:events";
  import { Readable } from "node:stream";
  export type Entry = {
    fileName: string;
    compressedSize: number;
    uncompressedSize: number;
    compressionMethod: number;
    generalPurposeBitFlag: number;
    externalFileAttributes: number;
    crc32: number;
  };
  export class ZipFile extends EventEmitter {
    entryCount: number;
    readEntry(): void;
    close(): void;
    openReadStream(entry: Entry, callback: (error: Error | null, stream: Readable) => void): void;
  }
  export function fromBuffer(buffer: Buffer, options: { lazyEntries: boolean; validateEntrySizes: boolean; strictFileNames: boolean }, callback: (error: Error | null, zip: ZipFile) => void): void;
}
