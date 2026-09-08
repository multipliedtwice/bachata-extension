import { createHash } from "node:crypto";
import { createServer, IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { TextDecoder } from "node:util";

export type TextSocket = {
  send: (text: string) => void;
  close: () => void;
  isOpen: () => boolean;
  remoteAddress?: string;
  origin?: string;
};

export type TextWebSocketServer = {
  listen: () => Promise<number>;
  close: () => Promise<void>;
};

export type TextWebSocketServerOptions = {
  host: string;
  port: number;
  path: string;
  maxMessageBytes: number;
  maxMessageBytesForSocket?: (socket: TextSocket) => number;
  maxConnections: number;
  allowOrigin: (origin: string | undefined) => boolean;
  onConnection: (socket: TextSocket) => void;
  onMessage: (socket: TextSocket, text: string) => void;
  onClose: (socket: TextSocket) => void;
  onError: (error: Error) => void;
};

const webSocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
// Long enough for a two-byte frame to reach the kernel, short enough that shutdown is not
// held hostage by a peer that stopped reading.
const CLOSE_FLUSH_GRACE_MS = 250;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

class ByteQueue {
  private readonly chunks: Buffer[] = [];
  private firstOffset = 0;
  length = 0;

  push(chunk: Buffer): void {
    if (chunk.length === 0) {
      return;
    }
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  clear(): void {
    this.chunks.length = 0;
    this.firstOffset = 0;
    this.length = 0;
  }

  peek(length: number): Buffer {
    if (length < 0 || length > this.length) {
      throw new Error("WebSocket parser requested unavailable bytes");
    }
    const output = Buffer.allocUnsafe(length);
    let written = 0;
    let offset = this.firstOffset;
    for (const chunk of this.chunks) {
      if (written >= length) {
        break;
      }
      const available = chunk.length - offset;
      const take = Math.min(available, length - written);
      chunk.copy(output, written, offset, offset + take);
      written += take;
      offset = 0;
    }
    return output;
  }

  read(length: number): Buffer {
    const output = this.peek(length);
    this.discard(length);
    return output;
  }

  discard(length: number): void {
    if (length < 0 || length > this.length) {
      throw new Error("WebSocket parser discarded unavailable bytes");
    }
    let remaining = length;
    while (remaining > 0) {
      const first = this.chunks[0];
      // The length check above proved the bytes are buffered, so there is always a chunk to
      // take them from; the guard is what lets the compiler see it.
      if (!first) {
        throw new Error("WebSocket parser lost a buffered chunk");
      }
      const available = first.length - this.firstOffset;
      if (remaining < available) {
        this.firstOffset += remaining;
        remaining = 0;
      } else {
        remaining -= available;
        this.chunks.shift();
        this.firstOffset = 0;
      }
    }
    this.length -= length;
  }
}

const createFrame = (opcode: number, payload: Buffer): Buffer => {
  const length = payload.length;
  const headerLength = length < 126 ? 2 : length <= 65_535 ? 4 : 10;
  const frame = Buffer.allocUnsafe(headerLength + length);
  frame[0] = 0x80 | opcode;
  if (length < 126) {
    frame[1] = length;
  } else if (length <= 65_535) {
    frame[1] = 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  }
  payload.copy(frame, headerLength);
  return frame;
};

// RFC 6455 requires `Sec-WebSocket-Key` to be the base64 encoding of exactly 16 random
// bytes. Accepting any string let a request that is not a WebSocket handshake — a probe, or
// a cross-protocol request shaped like one — complete an upgrade and reach the frame parser.
// The check is canonical: the value must round-trip, so padding and alphabet are exact.
const isCanonicalWebSocketKey = (key: string): boolean => {
  if (key.length !== 24 || !/^[A-Za-z0-9+/]{22}==$/u.test(key)) return false;
  const decoded = Buffer.from(key, "base64");
  return decoded.length === 16 && decoded.toString("base64") === key;
};

const rejectUpgrade = (
  socket: Socket,
  status: string,
): void => {
  if (socket.writable) {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  } else {
    socket.destroy();
  }
};

const parseUpgrade = (
  request: IncomingMessage,
  socket: Socket,
  options: TextWebSocketServerOptions,
): boolean => {
  const key = request.headers["sec-websocket-key"];
  const upgrade = request.headers.upgrade;
  const version = request.headers["sec-websocket-version"];
  const origin = request.headers.origin;
  if (request.url !== options.path) {
    rejectUpgrade(socket, "404 Not Found");
    return false;
  }
  if (!options.allowOrigin(typeof origin === "string" ? origin : undefined)) {
    rejectUpgrade(socket, "403 Forbidden");
    return false;
  }
  if (
    typeof key !== "string" ||
    !isCanonicalWebSocketKey(key) ||
    upgrade?.toLowerCase() !== "websocket" ||
    version !== "13"
  ) {
    rejectUpgrade(socket, "400 Bad Request");
    return false;
  }

  const accept = createHash("sha1")
    .update(`${key}${webSocketGuid}`)
    .digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n"),
  );
  return true;
};

export const createTextWebSocketServer = (
  options: TextWebSocketServerOptions,
): TextWebSocketServer => {
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  const sockets = new Set<Socket>();
  const connections = new Map<Socket, TextSocket>();

  server.on("upgrade", (request, socket, head) => {
    const netSocket = socket as Socket;
    if (sockets.size >= options.maxConnections) {
      rejectUpgrade(netSocket, "503 Service Unavailable");
      return;
    }
    if (!parseUpgrade(request, netSocket, options)) {
      return;
    }

    sockets.add(netSocket);
    const buffer = new ByteQueue();
    let fragmentOpcode: number | undefined;
    let fragments: Buffer[] = [];
    let fragmentBytes = 0;
    let closing = false;
    let closed = false;

    const clearParserState = (): void => {
      buffer.clear();
      fragmentOpcode = undefined;
      fragments = [];
      fragmentBytes = 0;
    };

    const beginClose = (reply: boolean): void => {
      if (closing || closed) {
        return;
      }
      closing = true;
      clearParserState();
      if (reply && netSocket.writable && !netSocket.writableEnded) {
        netSocket.write(createFrame(0x8, Buffer.alloc(0)));
      }
      netSocket.end();
    };

    const origin = typeof request.headers.origin === "string"
      ? request.headers.origin
      : undefined;
    const textSocket: TextSocket = {
      ...(netSocket.remoteAddress === undefined
        ? {}
        : { remoteAddress: netSocket.remoteAddress }),
      ...(origin === undefined ? {} : { origin }),
      send: (text) => {
        if (!closing && !closed && netSocket.writable) {
          netSocket.write(createFrame(0x1, Buffer.from(text, "utf8")));
        }
      },
      close: () => beginClose(true),
      isOpen: () =>
        !closing &&
        !closed &&
        !netSocket.destroyed &&
        netSocket.writable &&
        !netSocket.writableEnded,
    };
    connections.set(netSocket, textSocket);
    options.onConnection(textSocket);

    const fail = (error: Error): void => {
      options.onError(error);
      netSocket.destroy();
    };

    const deliver = (opcode: number, payload: Buffer): void => {
      if (opcode === 0x1) {
        if (payload.length > options.maxMessageBytes) {
          fail(new Error("WebSocket message exceeds the configured limit"));
          return;
        }
        let text: string;
        try {
          text = utf8Decoder.decode(payload);
        } catch {
          fail(new Error("WebSocket text message contains invalid UTF-8"));
          return;
        }
        options.onMessage(textSocket, text);
        return;
      }
      if (opcode === 0x8) {
        beginClose(true);
        return;
      }
      if (opcode === 0x9) {
        netSocket.write(createFrame(0xa, payload));
        return;
      }
      if (opcode === 0xa) {
        return;
      }
      fail(new Error(`Unsupported WebSocket opcode: ${String(opcode)}`));
    };

    netSocket.on("data", (chunk: Buffer) => {
      if (closing || closed) {
        return;
      }
      buffer.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      while (buffer.length >= 2) {
        const initial = buffer.peek(2);
        const first = initial[0];
        const second = initial[1];
        // `buffer.length >= 2` is the loop condition, so both header bytes exist.
        if (first === undefined || second === undefined) {
          fail(new Error("WebSocket parser read an incomplete frame header"));
          return;
        }
        const fin = (first & 0x80) !== 0;
        const reserved = first & 0x70;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        if (reserved !== 0) {
          fail(new Error("WebSocket extensions are not supported"));
          return;
        }
        let payloadLength = second & 0x7f;
        let offset = 2;

        if (!masked) {
          fail(new Error("Client WebSocket frames must be masked"));
          return;
        }
        if (payloadLength === 126) {
          if (buffer.length < 4) {
            return;
          }
          const header = buffer.peek(4);
          payloadLength = header.readUInt16BE(2);
          // RFC 6455 requires the shortest length form. A 16-bit field carrying a value that
          // fits in 7 bits is a second encoding of the same frame, and two encodings of one
          // frame are what length-based filters and proxies disagree about.
          if (payloadLength < 126) {
            fail(new Error("WebSocket frame uses a non-minimal length encoding"));
            return;
          }
          offset = 4;
        } else if (payloadLength === 127) {
          if (buffer.length < 10) {
            return;
          }
          const header = buffer.peek(10);
          const longLength = header.readBigUInt64BE(2);
          if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
            fail(new Error("WebSocket frame is too large"));
            return;
          }
          payloadLength = Number(longLength);
          if (payloadLength <= 65_535) {
            fail(new Error("WebSocket frame uses a non-minimal length encoding"));
            return;
          }
          offset = 10;
        }

        const controlFrame = opcode >= 0x8;
        if (controlFrame && (!fin || payloadLength > 125)) {
          fail(new Error("Invalid WebSocket control frame"));
          return;
        }
        const currentMaximum = Math.max(
          1,
          options.maxMessageBytesForSocket?.(textSocket) ??
            options.maxMessageBytes,
        );
        if (payloadLength > currentMaximum) {
          fail(new Error("WebSocket frame exceeds the configured limit"));
          return;
        }
        const frameLength = offset + 4 + payloadLength;
        if (buffer.length < frameLength) {
          return;
        }

        buffer.discard(offset);
        const mask = buffer.read(4);
        const payload = buffer.read(payloadLength);
        for (let index = 0; index < payload.length; index += 1) {
          // Both reads are exact-length by construction: `mask` is four bytes and `payload`
          // is `payloadLength`, so neither index can fall outside its buffer.
          const maskByte = mask[index % 4] ?? 0;
          const payloadByte = payload[index] ?? 0;
          payload[index] = payloadByte ^ maskByte;
        }

        if (opcode === 0x8) {
          beginClose(true);
          return;
        }

        if (opcode === 0x0) {
          if (fragmentOpcode === undefined) {
            fail(new Error("Unexpected WebSocket continuation frame"));
            return;
          }
          fragments.push(payload);
          fragmentBytes += payload.length;
          if (fragmentBytes > currentMaximum) {
            fail(new Error("WebSocket message exceeds the configured limit"));
            return;
          }
          if (fin) {
            const complete = Buffer.concat(fragments, fragmentBytes);
            const completeOpcode = fragmentOpcode;
            fragmentOpcode = undefined;
            fragments = [];
            fragmentBytes = 0;
            deliver(completeOpcode, complete);
          }
          continue;
        }

        if (fragmentOpcode !== undefined && (opcode === 0x1 || opcode === 0x2)) {
          fail(new Error("A fragmented WebSocket message is already active"));
          return;
        }

        if (!fin && (opcode === 0x1 || opcode === 0x2)) {
          fragmentOpcode = opcode;
          fragments = [payload];
          fragmentBytes = payload.length;
          continue;
        }

        if (opcode === 0x2) {
          fail(new Error("Binary WebSocket messages are not supported"));
          return;
        }
        deliver(opcode, payload);
      }
    });

    netSocket.on("error", (error) => options.onError(error));
    netSocket.on("close", () => {
      if (closed) {
        return;
      }
      closed = true;
      sockets.delete(netSocket);
      connections.delete(netSocket);
      options.onClose(textSocket);
    });
    if (head.length > 0) {
      netSocket.emit("data", head);
    }
  });

  server.on("error", (error) => options.onError(error));

  return {
    listen: () =>
      new Promise((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("Could not determine browser bridge port"));
            return;
          }
          resolve(address.port);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(options.port, options.host);
      }),
    close: () =>
      new Promise((resolve) => {
        // `close()` writes a close frame and calls `end()`. Destroying in the same tick threw
        // that frame away whenever it had not already reached the kernel, so a peer saw the
        // connection vanish instead of closing. Give the flush a short, bounded grace and
        // then destroy whatever is left; shutdown must not wait on a peer that never reads.
        const remaining = [...sockets];
        connections.forEach((connection) => connection.close());
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          sockets.forEach((activeSocket) => activeSocket.destroy());
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
        };
        if (remaining.length === 0) {
          finish();
          return;
        }
        let pending = remaining.length;
        const grace = setTimeout(finish, CLOSE_FLUSH_GRACE_MS);
        grace.unref?.();
        // One settlement per socket. `finish`, `close` and `error` can all fire for the same
        // socket, and a shared counter decremented three times would reach zero while other
        // sockets were still flushing.
        const settleOnce = (): (() => void) => {
          let done = false;
          return () => {
            if (done) return;
            done = true;
            pending -= 1;
            if (pending <= 0) {
              clearTimeout(grace);
              finish();
            }
          };
        };
        remaining.forEach((activeSocket) => {
          // `writableFinished`, not `writableEnded`: `end()` sets `writableEnded`
          // synchronously, so checking that reported every socket as already flushed and
          // destroyed the close frame in the same tick the race was meant to close.
          const settle = settleOnce();
          if (activeSocket.writableFinished || activeSocket.destroyed) {
            settle();
            return;
          }
          activeSocket.once("finish", settle);
          activeSocket.once("close", settle);
          activeSocket.once("error", settle);
        });
      }),
  };
};
