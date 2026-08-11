/**
 * A WebSocket server, just enough of one to be Slack.
 *
 * `SlackSocket` was written without ever opening a socket to slack.com, which
 * makes it the least trustworthy code in the app. Testing it against mocks would
 * only assert that the mocks match my reading of the protocol — the same reading
 * that could be wrong. So this speaks real RFC6455 over a real TCP socket: the
 * client under test performs a genuine handshake, and frames are masked, parsed
 * and emitted for real.
 *
 * Node ships a WebSocket CLIENT and no server, and one integration is not worth
 * adding `ws` to a desktop app's install surface — so the handshake and the two
 * frame paths are done by hand here. Test-only, and deliberately narrow: text
 * frames, no fragmentation, no compression, no ping/pong. Slack sends none of
 * those on this connection.
 */

import { createHash } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';

/** The constant every RFC6455 handshake hashes the client key against. */
const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface FakeSlackSocketServer {
  url: string;
  /** Every text frame the client sent us — the acks. */
  received: string[];
  /** Push a frame to the connected client. */
  send: (payload: unknown) => void;
  /** Drop the connection, as Slack does when it cycles one. */
  dropConnection: () => void;
  connections: () => number;
  waitForConnection: () => Promise<void>;
  close: () => Promise<void>;
}

/** Mask-aware read of a single client text frame. Returns null when incomplete. */
function readFrame(buf: Buffer): { text: string; rest: Buffer } | null {
  if (buf.length < 2) return null;
  const masked = (buf[1]! & 0x80) !== 0;
  let length = buf[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buf.length < 4) return null;
    length = buf.readUInt16BE(2);
    offset = 4;
  }
  const maskKey = masked ? buf.subarray(offset, offset + 4) : undefined;
  if (masked) offset += 4;
  if (buf.length < offset + length) return null;

  const body = Buffer.from(buf.subarray(offset, offset + length));
  // A client MUST mask; unmasking is not optional politeness.
  if (maskKey) for (let i = 0; i < body.length; i++) body[i]! ^= maskKey[i % 4]!;
  return { text: body.toString('utf8'), rest: buf.subarray(offset + length) };
}

/** Server frames are never masked. */
function writeFrame(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  if (body.length < 126) {
    return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

export async function startFakeSlack(): Promise<FakeSlackSocketServer> {
  const received: string[] = [];
  let client: Socket | undefined;
  let connections = 0;
  let announce: (() => void) | undefined;

  const server: Server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let handshaken = false;

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (!handshaken) {
        const text = buffer.toString('utf8');
        if (!text.includes('\r\n\r\n')) return;
        const key = /sec-websocket-key:\s*(.+)\r\n/i.exec(text)?.[1]?.trim() ?? '';
        const accept = createHash('sha1').update(key + MAGIC).digest('base64');
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        handshaken = true;
        buffer = Buffer.from(buffer.subarray(text.indexOf('\r\n\r\n') + 4));
        client = socket;
        connections++;
        announce?.();
      }

      for (;;) {
        const frame = readFrame(buffer);
        if (!frame) break;
        buffer = Buffer.from(frame.rest);
        if (frame.text) received.push(frame.text);
      }
    });

    socket.on('error', () => undefined);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  return {
    url: `ws://127.0.0.1:${port}`,
    received,
    send: (payload) => client?.write(writeFrame(JSON.stringify(payload))),
    dropConnection: () => {
      client?.destroy();
      client = undefined;
    },
    connections: () => connections,
    waitForConnection: () =>
      new Promise<void>((resolve) => {
        if (client) return resolve();
        announce = () => {
          announce = undefined;
          resolve();
        };
      }),
    close: () =>
      new Promise<void>((resolve) => {
        client?.destroy();
        server.close(() => resolve());
      }),
  };
}
