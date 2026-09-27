// getdents64(2) on Linux and getdirentries64 on macOS fill a buffer with
// variable-length records. Each record says how long it is (`d_reclen`). The
// kernel builds these records itself and does not get the length wrong, but a
// sandbox or an emulator that answers the syscall in its place can. bun has
// two directory walkers: one behind node:fs, one behind Bun.Glob, the resolver
// and `bun install`. Both trusted the record, so a `d_reclen` of 0 aborted the
// process on Linux: "slice index starts at 19 but ends at 0".
//
// A normal filesystem cannot produce such a record, so a shim damages the
// buffer after the real syscall returns. The name of the directory selects the
// damage. On Linux the shim is an LD_PRELOAD library that interposes libc's
// syscall(), which is how bun issues getdents64 (glibc only: it relies on ELF
// symbol interposition). On macOS it is a DYLD_INSERT_LIBRARIES library that
// interposes __getdirentries64.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isGlibc, isMacOS, tempDir } from "harness";
import { join } from "node:path";

const cc = Bun.which("cc") || Bun.which("gcc") || Bun.which("clang");

const SHIM_C = /* c */ `
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <limits.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifdef __APPLE__
// struct dirent { u64 d_ino; u64 d_seekoff; u16 d_reclen; u16 d_namlen; u8 d_type; char d_name[]; }
enum { RECLEN_OFFSET = 16, NAMLEN_OFFSET = 18, NAME_OFFSET = 21 };
#else
// struct linux_dirent64 { u64 d_ino; s64 d_off; u16 d_reclen; u8 d_type; char d_name[]; }
enum { RECLEN_OFFSET = 16, NAME_OFFSET = 19 };
#endif

static long get_u16(const unsigned char *at) {
  uint16_t value;
  memcpy(&value, at, sizeof value);
  return value;
}

static void set_u16(unsigned char *at, long to) {
  uint16_t value = (uint16_t)to;
  memcpy(at, &value, sizeof value);
}

static long reclen_of(const unsigned char *record) {
  return get_u16(record + RECLEN_OFFSET);
}

static void clear_name(unsigned char *record) {
  memset(record + NAME_OFFSET, 0, reclen_of(record) - NAME_OFFSET);
#ifdef __APPLE__
  set_u16(record + NAMLEN_OFFSET, 0);
#endif
}

// No NUL anywhere in the name field.
static void unterminate_name(unsigned char *record) {
  memset(record + NAME_OFFSET, 'x', reclen_of(record) - NAME_OFFSET);
}

// \`buf\` holds \`rc\` bytes of records and is \`len\` bytes long. Returns the
// byte count to report.
static long damage(const char *path, unsigned char *buf, long rc, long len) {
  const char *mode = strrchr(path, '/');
  mode = mode ? mode + 1 : path;

  unsigned char *second = buf + reclen_of(buf);
  unsigned char *last = buf;
  while (last + reclen_of(last) < buf + rc) last += reclen_of(last);
  unsigned char *b_txt = NULL;
  for (unsigned char *at = buf; at < buf + rc; at += reclen_of(at)) {
    if (strcmp((const char *)at + NAME_OFFSET, "b.txt") == 0) b_txt = at;
  }

  if (strcmp(mode, "reclen-zero") == 0) {
    set_u16(buf + RECLEN_OFFSET, 0);
  } else if (strcmp(mode, "reclen-below-header") == 0) {
    set_u16(buf + RECLEN_OFFSET, 8);
  } else if (strcmp(mode, "reclen-past-end") == 0) {
    // The first record claims to be longer than everything the call returned.
    set_u16(buf + RECLEN_OFFSET, rc + 8);
  } else if (strcmp(mode, "second-record") == 0) {
    set_u16(second + RECLEN_OFFSET, 0);
  } else if (strcmp(mode, "all-zeros") == 0) {
    memset(buf, 0, (size_t)rc);
  } else if (strcmp(mode, "name-unterminated") == 0) {
    unterminate_name(last);
  } else if (strcmp(mode, "name-empty") == 0) {
    clear_name(buf);
  } else if (strcmp(mode, "header-cut") == 0) {
    // The byte count ends in the middle of the last record's header.
    return (last - buf) + 10;
  } else if (strcmp(mode, "count-above-buffer") == 0) {
    // The byte count is larger than the buffer that was passed in.
    memset(buf + rc, 0, (size_t)(len - rc));
    return len + 64;
  } else if (strcmp(mode, "inode-zero") == 0 && b_txt) {
    memset(b_txt, 0, 8);
  } else if (strcmp(mode, "inode-zero-name-unterminated") == 0 && b_txt) {
    memset(b_txt, 0, 8);
    unterminate_name(b_txt);
  }
  return rc;
}

#ifdef __APPLE__

extern ssize_t __getdirentries64(int fd, void *buf, size_t nbytes, off_t *basep);

static ssize_t damaged_getdirentries64(int fd, void *buf, size_t nbytes, off_t *basep) {
  ssize_t rc = __getdirentries64(fd, buf, nbytes, basep);
  char path[PATH_MAX];
  if (rc <= 0 || fcntl(fd, F_GETPATH, path) != 0) return rc;
  return damage(path, buf, rc, (long)nbytes);
}

__attribute__((used, section("__DATA,__interpose")))
static const struct {
  const void *replacement;
  const void *original;
} interpose_getdirentries64 = {damaged_getdirentries64, __getdirentries64};

#else

static long (*next_syscall)(long, ...);

long syscall(long nr, ...) {
  va_list ap;
  va_start(ap, nr);
  long a1 = va_arg(ap, long), a2 = va_arg(ap, long), a3 = va_arg(ap, long);
  long a4 = va_arg(ap, long), a5 = va_arg(ap, long), a6 = va_arg(ap, long);
  va_end(ap);
  if (!next_syscall) next_syscall = dlsym(RTLD_NEXT, "syscall");
  long rc = next_syscall(nr, a1, a2, a3, a4, a5, a6);
  if (nr != SYS_getdents64 || rc <= 0) return rc;

  char link[64], path[PATH_MAX];
  snprintf(link, sizeof link, "/proc/self/fd/%d", (int)a1);
  ssize_t n = readlink(link, path, sizeof path - 1);
  if (n <= 0) return rc;
  path[n] = 0;
  return damage(path, (unsigned char *)a2, rc, a3);
}

#endif
`;

// argv[2] is a JSON list of [mode, forms]. The mode is the damage. For each
// mode, prints one line with what each form did: the sorted names, or the
// error.
const FIXTURE = /* js */ `
const fs = require("node:fs");
const path = require("node:path");

const forms = {
  readdirSync: dir => fs.readdirSync(dir),
  readdirSyncWithFileTypes: dir => fs.readdirSync(dir, { withFileTypes: true }).map(entry => entry.name),
  readdirCallback: dir =>
    new Promise((resolve, reject) => fs.readdir(dir, (err, names) => (err ? reject(err) : resolve(names)))),
  readdir: dir => fs.promises.readdir(dir),
  opendirSync: dir => {
    const handle = fs.opendirSync(dir);
    try {
      const names = [];
      for (let entry; (entry = handle.readSync()); ) names.push(entry.name);
      return names;
    } finally {
      handle.closeSync();
    }
  },
  globSync: dir => [...new Bun.Glob("*").scanSync({ cwd: dir })],
  glob: dir => Array.fromAsync(new Bun.Glob("*").scan({ cwd: dir })),
  // "nested-<mode>" is intact. The damaged directory is the one below it.
  readdirSyncRecursive: (dir, mode) => fs.readdirSync("nested-" + mode, { recursive: true }),
  readdirRecursive: (dir, mode) => fs.promises.readdir("nested-" + mode, { recursive: true }),
  rmSync: (dir, mode) => {
    fs.rmSync(path.join("rm", mode), { recursive: true });
    return fs.existsSync(path.join("rm", mode)) ? "still there" : "removed";
  },
  cpSync: (dir, mode) => {
    fs.cpSync(path.join("cp", mode), path.join("cp-out", mode), { recursive: true });
    return fs.readdirSync(path.join("cp-out", mode));
  },
};

(async () => {
  for (const [mode, names] of JSON.parse(process.argv[2])) {
    const result = {};
    for (const name of names) {
      try {
        const value = await forms[name](path.join("read", mode), mode);
        result[name] = Array.isArray(value) ? value.sort() : value;
      } catch (e) {
        result[name] = { code: e.code, syscall: e.syscall, path: e.path };
      }
    }
    console.log(JSON.stringify({ mode, result }));
  }
})();
`;

const files = ["a.txt", "b.txt", "c.txt"];
const walkerSyscall = isMacOS ? "getdirentries64" : "getdents64";

// What each form reports for a malformed record in `mode`.
function malformed(mode: string): Record<string, unknown> {
  const scandir = { code: "EIO", syscall: "scandir", path: join("read", mode) };
  const walker = { code: "EIO", syscall: walkerSyscall };
  return {
    readdirSync: scandir,
    readdirSyncWithFileTypes: scandir,
    readdirCallback: scandir,
    readdir: scandir,
    opendirSync: scandir,
    globSync: walker,
    glob: walker,
    // The syscall and the path that a recursive readdir reports for a
    // subdirectory are not the subject here.
    readdirSyncRecursive: { code: "EIO", syscall: expect.any(String), path: expect.any(String) },
    readdirRecursive: { code: "EIO", syscall: expect.any(String), path: expect.any(String) },
    rmSync: { code: "EIO", syscall: "rm", path: join("rm", mode) },
    cpSync: { code: "EIO", syscall: "scandir", path: join("cp", mode) },
  };
}

// What each form reports when the walk gives `names`.
function listed(mode: string, names: string[]): Record<string, unknown> {
  return {
    readdirSync: names,
    readdirSyncWithFileTypes: names,
    readdirCallback: names,
    readdir: names,
    opendirSync: names,
    globSync: names,
    glob: names,
    readdirSyncRecursive: [mode, ...names.map(name => join(mode, name))],
    readdirRecursive: [mode, ...names.map(name => join(mode, name))],
    rmSync: "removed",
    cpSync: names,
  };
}

// One form for each walker: node:fs, then the one in bun_sys.
const eachWalker = ["readdirSync", "globSync"];
// The forms that read the directory with one walk of one iterator.
const plainForms = [...eachWalker, "readdirSyncWithFileTypes", "readdirCallback", "readdir", "opendirSync", "glob"];
// macOS can copy or remove a tree without a walk of it, so what these report
// there is not known.
const treeForms = ["readdirSyncRecursive", "readdirRecursive", "rmSync", "cpSync"];
const everyForm = isMacOS ? plainForms : [...plainForms, ...treeForms];

// Records that the shim touches and that are still well formed. They run
// first, so that they are judged even when a later mode ends the process.
const wellFormed: [string, string[]][] = [
  ["intact", everyForm],
  ["inode-zero", eachWalker],
];
const damaged: [string, string[]][] = [
  // The record from the crash report.
  ["reclen-zero", everyForm],
  ["reclen-below-header", eachWalker],
  ["reclen-past-end", eachWalker],
  ["second-record", eachWalker],
  ["all-zeros", eachWalker],
  ["name-unterminated", eachWalker],
  ["name-empty", eachWalker],
  ["header-cut", eachWalker],
  ["count-above-buffer", eachWalker],
];
// macOS keeps a removed entry in place with inode 0. The walkers skip it and
// read nothing of it but its length. Linux has no such rule.
const inodeZeroWithBadName: [string, string[]] = ["inode-zero-name-unterminated", eachWalker];
const plan = [...wellFormed, ...(isMacOS ? [inodeZeroWithBadName, ...damaged] : [...damaged, inodeZeroWithBadName])];

function only(forms: string[], expected: Record<string, unknown>) {
  return Object.fromEntries(forms.map(form => [form, expected[form]]));
}

describe.skipIf(!(isGlibc || isMacOS) || !cc)("a malformed directory record", () => {
  let dir: ReturnType<typeof tempDir>;
  let walked: Promise<{ results: Record<string, unknown>; stderr: string; exitCode: number }>;

  beforeAll(async () => {
    const tree: Record<string, string> = { "shim.c": SHIM_C, "fixture.js": FIXTURE };
    for (const [mode] of plan) {
      for (const file of files) {
        tree[`read/${mode}/${file}`] = "";
        tree[`nested-${mode}/${mode}/${file}`] = "";
        tree[`rm/${mode}/${file}`] = "";
        tree[`cp/${mode}/${file}`] = "";
      }
    }
    dir = tempDir("readdir-malformed-dirent", tree);
    const shimPath = join(String(dir), isMacOS ? "shim.dylib" : "shim.so");
    await using compile = Bun.spawn({
      cmd: isMacOS
        ? [cc!, "-dynamiclib", "-o", shimPath, join(String(dir), "shim.c")]
        : [cc!, "-shared", "-fPIC", "-o", shimPath, join(String(dir), "shim.c"), "-ldl"],
      env: bunEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, exitCode] = await Promise.all([compile.stdout.text(), compile.stderr.text(), compile.exited]);
    if (exitCode !== 0) throw new Error(`Failed to build the shim:\n${err || out}`);
    walked = walk(shimPath);
  });

  afterAll(() => {
    dir?.[Symbol.dispose]();
  });

  // One process walks every mode. A debug build starts slowly, and a process
  // for each mode does not fit the default timeout.
  async function walk(shimPath: string) {
    const preload = isMacOS ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD";
    const existing = bunEnv[preload];
    await using proc = Bun.spawn({
      // If the fixture does crash, the flag skips the debug build's slow
      // symbolized backtrace, so the test fails on the panic message and not
      // on a timeout. The fixture ignores the extra argv entry.
      cmd: [bunExe(), "fixture.js", JSON.stringify(plan), "--debug-crash-handler-use-trace-string"],
      cwd: String(dir),
      env: { ...bunEnv, [preload]: existing ? `${shimPath}:${existing}` : shimPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    const results: Record<string, unknown> = {};
    for (const line of stdout.split("\n").filter(Boolean)) {
      const { mode, result } = JSON.parse(line);
      results[mode] = result;
    }
    return { results, stderr, exitCode };
  }

  // One value so that a crash shows stderr and the exit code in the diff.
  async function outcome(mode: string) {
    const { results, stderr, exitCode } = await walked;
    return { result: results[mode], stderr, exitCode };
  }

  test.each(damaged)("%s is an EIO error", async (mode, forms) => {
    expect(await outcome(mode)).toEqual({ result: only(forms, malformed(mode)), stderr: "", exitCode: 0 });
  });

  // The shim is loaded and leaves this directory alone.
  test("an intact directory is listed", async () => {
    expect((await outcome("intact")).result).toEqual(only(everyForm, listed("intact", files)));
  });

  test("an entry with inode 0 is skipped on macOS and listed on Linux", async () => {
    const names = isMacOS ? ["a.txt", "c.txt"] : files;
    expect((await outcome("inode-zero")).result).toEqual(only(eachWalker, listed("inode-zero", names)));
  });

  test("the name of an entry with inode 0 is read on Linux and not on macOS", async () => {
    const [mode, forms] = inodeZeroWithBadName;
    const expected = isMacOS ? listed(mode, ["a.txt", "c.txt"]) : malformed(mode);
    expect(await outcome(mode)).toEqual({ result: only(forms, expected), stderr: "", exitCode: 0 });
  });
});
