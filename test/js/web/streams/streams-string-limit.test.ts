import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isASAN, isDebug } from "harness";
import { totalmem } from "node:os";

// Consuming a stream as text must reject with a catchable error when the accumulated
// chunks exceed the maximum string length (2^31-1 bytes), instead of aborting the
// process in WTF::Vector's capacity check. Each child commits ~2.2GB.
const enoughMemory = totalmem() >= 8 * 1024 * 1024 * 1024;

// 3 chunks of n bytes sum to 2^31+1: each chunk fits comfortably, the total does not.
function consumeToText(streamSource: string): string {
  return `
    const n = 715827883;
    const rs = ${streamSource};
    try {
      const text = await Bun.readableStreamToText(rs);
      console.log("resolved", text.length);
    } catch (e) {
      console.log("threw", e.name, e.message);
    }
  `;
}

async function run(
  script: string,
  env: Record<string, string | undefined> = bunEnv,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  await using proc = Bun.spawn({
    cmd: [bunExe(), "-e", script],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

const threw = { stdout: "threw RangeError Out of memory\n", stderr: "", exitCode: 0 };

describe.skipIf(!enoughMemory)("text consumers reject binary chunks summing past 2^31-1", () => {
  test("queue-backed ReadableStream", async () => {
    const result = await run(
      consumeToText(`new ReadableStream({
        start(c) {
          for (let i = 0; i < 3; i++) c.enqueue(new Uint8Array(n));
          c.close();
        },
      })`),
    );
    expect(result).toEqual(threw);
  });

  test("direct ReadableStream", async () => {
    const result = await run(
      consumeToText(`new ReadableStream({
        type: "direct",
        pull(c) {
          for (let i = 0; i < 3; i++) c.write(new Uint8Array(n));
          c.end();
        },
      })`),
    );
    expect(result).toEqual(threw);
  });

  test("Response(stream).text()", async () => {
    const result = await run(`
      const n = 715827883;
      const rs = new ReadableStream({
        start(c) {
          for (let i = 0; i < 3; i++) c.enqueue(new Uint8Array(n));
          c.close();
        },
      });
      try {
        const text = await new Response(rs).text();
        console.log("resolved", text.length);
      } catch (e) {
        console.log("threw", e.name, e.message);
      }
    `);
    expect(result).toEqual(threw);
  });

  // WTF::String::utf8() aborts once its conversion needs more than INT32_MAX bytes of
  // scratch (2x the length for 8-bit strings), so a mixed stream with a near-limit string
  // chunk crashed in the encode even when the real UTF-8 total fit. The consumers now size
  // and write through simdutf instead.
  test("mixed chunks with a big ASCII string chunk resolve when the UTF-8 total fits", async () => {
    const result = await run(`
        const big = Buffer.alloc(1200000000, "a").toString();
        const rs = new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([65]));
            c.enqueue(big);
            c.close();
          },
        });
        try {
          const text = await Bun.readableStreamToText(rs);
          console.log("resolved", text.length);
        } catch (e) {
          console.log("threw", e.name, e.message);
        }
      `);
    expect(result).toEqual({ stdout: "resolved 1200000001\n", stderr: "", exitCode: 0 });
  }, 60_000);

  test("mixed chunks whose UTF-8 expansion passes the limit reject", async () => {
    const result = await run(`
        // 1.2e9 U+00E9 chars: a Latin1 string whose UTF-8 form is 2.4e9 bytes.
        const big = Buffer.alloc(1200000000, 233).toString("latin1");
        const rs = new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([65]));
            c.enqueue(big);
            c.close();
          },
        });
        try {
          const text = await Bun.readableStreamToText(rs);
          console.log("resolved", text.length);
        } catch (e) {
          console.log("threw", e.name, e.message);
        }
      `);
    expect(result).toEqual(threw);
  }, 60_000);

  // The direct sink records sizes at write() time and reads the spans at end(), so a
  // resizable ArrayBuffer grown in between bypasses the up-front estimate check; the
  // append itself must reject the oversized span.
  test("direct stream with a buffer grown past the limit after write() rejects", async () => {
    const result = await run(`
      const ab = new ArrayBuffer(8, { maxByteLength: 2400000000 });
      const rs = new ReadableStream({
        type: "direct",
        pull(c) {
          c.write(new Uint8Array(ab));
          ab.resize(2400000000);
          console.log("resized", ab.byteLength);
          c.end();
        },
      });
      try {
        const text = await Bun.readableStreamToText(rs);
        console.log("resolved", text.length);
      } catch (e) {
        console.log("threw", e.name, e.message);
      }
    `);
    expect(result).toEqual({
      stdout: "resized 2400000000\nthrew RangeError Out of memory\n",
      stderr: "",
      exitCode: 0,
    });
  });
});

// arrayBuffer() and bytes() assemble a chunk array that holds a string in a WTF::Vector, which
// aborts past 2^31-1 bytes. The child reserves the two big chunks and never touches them, so
// it stays small.
test.skipIf(!enoughMemory)("arrayBuffer() and bytes() reject mixed chunks summing past 2^31-1", async () => {
  const result = await run(`
    const big = new Uint8Array(1100000000);
    for (const consume of [Bun.readableStreamToArrayBuffer, Bun.readableStreamToBytes]) {
      const rs = new ReadableStream({
        start(c) {
          c.enqueue("a");
          c.enqueue(big);
          c.enqueue(big);
          c.close();
        },
      });
      try {
        const bytes = await consume(rs);
        console.log("resolved", bytes.byteLength);
      } catch (e) {
        console.log("threw", e.name, e.message);
      }
    }
  `);
  expect(result).toEqual({
    stdout: "threw RangeError Out of memory\nthrew RangeError Out of memory\n",
    stderr: "",
    exitCode: 0,
  });
});

// TextDecoderStream joins a chunk with the bytes it carried over from an incomplete UTF-8
// sequence. The join sized a WTF::Vector that aborts past 2^31-1 bytes, so a 2^31-byte chunk
// after a carried byte killed the process before it read a byte. The child reserves the
// chunk and never touches it, so it stays small.
test.skipIf(!enoughMemory)("TextDecoderStream rejects a chunk too long to join with the carried bytes", async () => {
  const result = await run(`
    const writer = new TextDecoderStream().writable.getWriter();
    await writer.write(new Uint8Array([0xe2]));
    try {
      await writer.write(new Uint8Array(2 ** 31));
      console.log("resolved");
    } catch (e) {
      console.log("threw", e.name, e.message);
    }
  `);
  expect(result).toEqual(threw);
});

// The text sink of a direct stream, and the text consumers of every other stream, join string
// chunks in one WTF::StringBuilder. A string that the builder cannot take has to be an error
// that script can catch, and the builder has to keep the text it has: the caller of write()
// can catch the error and end the stream. The builder lost its text, and the next read of it
// aborted the process.
const settle = `
  const describeError = e => e.name + ": " + e.message;
  // "aaabbc" is "a3 b2 c1".
  const runs = text => text.replace(/(.)\\1*/gs, (run, character) => character + run.length + " ").trim();
  const settle = promise => promise.then(text => ({ text: runs(text) }), e => ({ rejected: describeError(e) }));
`;

// The builder cannot grow because an allocation fails. With Malloc=1 WebKit allocates through
// the system allocator, so ASAN's cap of 4 MiB for one allocation covers the builder's buffer.
// ASAN logs every allocation that it refuses to stderr.
describe.skipIf(!isASAN)("text consumers keep their text when a string chunk cannot be allocated", () => {
  const MIB = 1024 * 1024;
  const env = {
    ...bunEnv,
    Malloc: "1",
    ASAN_OPTIONS: [bunEnv.ASAN_OPTIONS, "allocator_may_return_null=1", "max_allocation_size_mb=4", "detect_leaks=0"]
      .filter(Boolean)
      .join(":"),
  };
  const outOfMemory = "RangeError: Out of memory";
  const prelude = `
    ${settle}
    const megabyte = letter => Buffer.alloc(${MIB}, letter).toString("latin1");
    // Three megabytes fit in one allocation. Four megabytes and the header of the string do not.
    const writeUntilRefused = controller => {
      let written = 0;
      try {
        for (; written < 8; written++) controller.write(megabyte("abcdefgh"[written]));
      } catch (e) {
        return { written, refused: describeError(e) };
      }
      return { written, refused: null };
    };
  `;
  const runWithCap = async (source: string) => {
    const { stdout, exitCode } = await run(`${prelude}\n${source}`, env);
    return { stdout: JSON.parse(stdout || "null"), exitCode };
  };
  const threeMegabytes = `a${MIB} b${MIB} c${MIB}`;

  test.concurrent("direct stream: the caller catches the error and ends the stream", async () => {
    const result = await runWithCap(`
      let writes;
      const stream = new ReadableStream({
        type: "direct",
        pull(controller) {
          writes = writeUntilRefused(controller);
          controller.end();
        },
      });
      console.log(JSON.stringify({ ...(await settle(Bun.readableStreamToText(stream))), ...writes }));
    `);
    expect(result).toEqual({ stdout: { text: threeMegabytes, written: 3, refused: outOfMemory }, exitCode: 0 });
  });

  test.concurrent("direct stream: the caller catches the error and writes bytes", async () => {
    const result = await runWithCap(`
      let writes;
      const stream = new ReadableStream({
        type: "direct",
        pull(controller) {
          writes = writeUntilRefused(controller);
          controller.write(new TextEncoder().encode("z"));
          controller.end();
        },
      });
      console.log(JSON.stringify({ ...(await settle(Bun.readableStreamToText(stream))), ...writes }));
    `);
    expect(result).toEqual({
      stdout: { text: `${threeMegabytes} z1`, written: 3, refused: outOfMemory },
      exitCode: 0,
    });
  });

  test.concurrent("direct stream: nothing catches the error", async () => {
    const result = await runWithCap(`
      let written = 0;
      const stream = new ReadableStream({
        type: "direct",
        pull(controller) {
          for (; written < 8; written++) controller.write(megabyte("abcdefgh"[written]));
          controller.end();
        },
      });
      console.log(JSON.stringify({ ...(await settle(Bun.readableStreamToText(stream))), written }));
    `);
    expect(result).toEqual({ stdout: { rejected: outOfMemory, written: 3 }, exitCode: 0 });
  });

  test.concurrent("mixed chunks: three megabytes of strings after bytes", async () => {
    const result = await runWithCap(`
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("z"));
          for (const letter of "abc") controller.enqueue(megabyte(letter));
          controller.close();
        },
      });
      console.log(JSON.stringify(await settle(Bun.readableStreamToText(stream))));
    `);
    expect(result).toEqual({ stdout: { text: `z1 ${threeMegabytes}` }, exitCode: 0 });
  });

  test.concurrent("mixed chunks: four megabytes of strings after bytes", async () => {
    const result = await runWithCap(`
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("z"));
          for (const letter of "abcd") controller.enqueue(megabyte(letter));
          controller.close();
        },
      });
      console.log(JSON.stringify(await settle(Bun.readableStreamToText(stream))));
    `);
    expect(result).toEqual({ stdout: { rejected: outOfMemory }, exitCode: 0 });
  });

  // The builder is 8-bit until the 16-bit chunk comes, and then needs a buffer of 2 bytes for each character.
  test.concurrent("string chunks: one megabyte, then a 16-bit character", async () => {
    const result = await runWithCap(`
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(megabyte("a"));
          controller.enqueue("\\u20AC");
          controller.close();
        },
      });
      console.log(JSON.stringify(await settle(Bun.readableStreamToText(stream))));
    `);
    expect(result).toEqual({ stdout: { text: `a${MIB} \u20AC1` }, exitCode: 0 });
  });

  test.concurrent("string chunks: three megabytes, then a 16-bit character", async () => {
    const result = await runWithCap(`
      const stream = new ReadableStream({
        start(controller) {
          for (const letter of "abc") controller.enqueue(megabyte(letter));
          controller.enqueue("\\u20AC");
          controller.close();
        },
      });
      console.log(JSON.stringify(await settle(Bun.readableStreamToText(stream))));
    `);
    expect(result).toEqual({ stdout: { rejected: outOfMemory }, exitCode: 0 });
  });
});

// The builder cannot grow because the text would be longer than a string can be.
describe.skipIf(!enoughMemory)("text consumers keep their text when a string chunk passes the string limit", () => {
  const outOfMemory = "RangeError: Out of memory";
  const prelude = `
    const describeError = e => e.name + ": " + e.message;
    const gigabyte = Buffer.alloc(2 ** 30, "x").toString("latin1");
    const settle = promise =>
      promise.then(
        text => ({ length: text.length, isTheFirstChunk: text === gigabyte }),
        e => ({ rejected: describeError(e) }),
      );
  `;
  const runParsed = async (source: string) => {
    const { stdout, stderr, exitCode } = await run(`${prelude}\n${source}`);
    return { stdout: JSON.parse(stdout || "null"), stderr, exitCode };
  };

  test("direct stream: the caller catches the error and ends the stream", async () => {
    const result = await runParsed(`
      let refused = null;
      const stream = new ReadableStream({
        type: "direct",
        pull(controller) {
          controller.write(gigabyte);
          try {
            controller.write(gigabyte);
          } catch (e) {
            refused = describeError(e);
          }
          controller.end();
        },
      });
      console.log(JSON.stringify({ ...(await settle(Bun.readableStreamToText(stream))), refused }));
    `);
    expect(result).toEqual({
      stdout: { length: 2 ** 30, isTheFirstChunk: true, refused: outOfMemory },
      stderr: "",
      exitCode: 0,
    });
  });

  test("direct stream: nothing catches the error", async () => {
    const result = await runParsed(`
      let wroteTwice = false;
      const stream = new ReadableStream({
        type: "direct",
        pull(controller) {
          controller.write(gigabyte);
          controller.write(gigabyte);
          wroteTwice = true;
          controller.end();
        },
      });
      console.log(JSON.stringify({ ...(await settle(new Response(stream).text())), wroteTwice }));
    `);
    expect(result).toEqual({ stdout: { rejected: outOfMemory, wroteTwice: false }, stderr: "", exitCode: 0 });
  });

  // A gigabyte of Latin-1 and one 16-bit character fit in a string of 16-bit characters. The
  // builder asked for twice its size to make room, which no 16-bit string can have, and
  // overflowed. The child holds 4 to 5 GiB, and 6.5 GiB in a build with ASAN.
  describe.skipIf(isASAN || isDebug || totalmem() < 16 * 1024 ** 3)("a 16-bit character after a gigabyte", () => {
    const settled = { length: 2 ** 30 + 1, startsWithTheFirstChunk: true, last: "\u20AC" };
    const consume = `
      const text = await Bun.readableStreamToText(stream);
      console.log(
        JSON.stringify({
          length: text.length,
          startsWithTheFirstChunk: text.startsWith(gigabyte),
          last: text.at(-1),
          refused,
        }),
      );
    `;

    test("direct stream", async () => {
      const result = await runParsed(`
        let refused = null;
        const stream = new ReadableStream({
          type: "direct",
          pull(controller) {
            controller.write(gigabyte);
            try {
              controller.write("\\u20AC");
            } catch (e) {
              refused = describeError(e);
            }
            controller.end();
          },
        });
        ${consume}
      `);
      expect(result).toEqual({ stdout: { ...settled, refused: null }, stderr: "", exitCode: 0 });
    });

    test("string chunks of another stream", async () => {
      const result = await runParsed(`
        const refused = null;
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(gigabyte);
            controller.enqueue("\\u20AC");
            controller.close();
          },
        });
        ${consume}
      `);
      expect(result).toEqual({ stdout: { ...settled, refused: null }, stderr: "", exitCode: 0 });
    });
  });
});
