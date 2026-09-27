//! One record of the buffer that `getdents64(2)` (Linux), `__getdirentries64`
//! (Darwin) or `getdents(2)` (FreeBSD) fills. Both directory walkers read
//! their buffers through [`parse`]: `dir_iterator` in this crate and
//! `bun_runtime::node::dir_iterator`.
//!
//! A sandbox or an emulator can answer the syscall in place of the kernel, so
//! no length in a record is trusted. Each one is checked against the bytes the
//! syscall returned.

use crate::{E, Error, Tag};

/// Where a platform keeps the fields of a record. On all three, `d_ino` is the
/// `u64` at offset 0 and `d_reclen` is the `u16` at offset 16.
pub trait Layout {
    /// `u8 d_type`.
    const D_TYPE: usize;
    /// `u16 d_namlen`. Linux has none: the name ends at its NUL.
    const D_NAMLEN: Option<usize>;
    /// `d_name[0]`. Also the size of the fixed header.
    const D_NAME: usize;
    /// Darwin and FreeBSD keep a removed entry in place with inode 0.
    const INODE_ZERO_IS_REMOVED: bool;
}

/// `struct linux_dirent64 { u64 d_ino; i64 d_off; u16 d_reclen; u8 d_type;
/// char d_name[]; }`
pub struct Linux;
impl Layout for Linux {
    const D_TYPE: usize = 18;
    const D_NAMLEN: Option<usize> = None;
    const D_NAME: usize = 19;
    const INODE_ZERO_IS_REMOVED: bool = false;
}

/// Darwin `struct dirent` (64-bit ino): `u64 d_ino; u64 d_seekoff;
/// u16 d_reclen; u16 d_namlen; u8 d_type; char d_name[];`
pub struct Darwin;
impl Layout for Darwin {
    const D_TYPE: usize = 20;
    const D_NAMLEN: Option<usize> = Some(18);
    const D_NAME: usize = 21;
    const INODE_ZERO_IS_REMOVED: bool = true;
}

/// FreeBSD 12+ `struct dirent` (ino64): `u64 d_fileno; i64 d_off;
/// u16 d_reclen; u8 d_type; u8 pad0; u16 d_namlen; u16 pad1; char d_name[];`
pub struct FreeBsd;
impl Layout for FreeBsd {
    const D_TYPE: usize = 18;
    const D_NAMLEN: Option<usize> = Some(20);
    const D_NAME: usize = 24;
    const INODE_ZERO_IS_REMOVED: bool = true;
}

#[cfg(any(target_os = "linux", target_os = "android"))]
pub type Native = Linux;
#[cfg(target_os = "macos")]
pub type Native = Darwin;
#[cfg(target_os = "freebsd")]
pub type Native = FreeBsd;

const D_INO: usize = 0;
const D_RECLEN: usize = 16;

/// A record that lies inside the bytes the syscall returned.
pub struct Record<'a> {
    /// Offset of the record after this one. `at < next <= filled.len()`.
    pub next: usize,
    /// `None` for a record that the walkers do not report: `.`, `..`, and a
    /// removed entry (see [`Layout::INODE_ZERO_IS_REMOVED`]), whose name is
    /// not read.
    pub entry: Option<Entry<'a>>,
}

pub struct Entry<'a> {
    /// `d_name` without its NUL. Not empty. The NUL is the byte after it,
    /// inside the record.
    pub name: &'a [u8],
    pub d_type: u8,
}

/// Reads the record at `filled[at..]`. `filled` is the part of the buffer that
/// the syscall wrote.
///
/// `None` for a record that cannot be walked: the header or the record does
/// not fit in `filled`, the record is shorter than its header, the name has no
/// NUL inside the record, or the name is empty. An empty name resolves to the
/// directory itself, so a recursive walk would never end.
#[inline]
pub fn parse<L: Layout>(filled: &[u8], at: usize) -> Option<Record<'_>> {
    let rest = filled.get(at..)?;
    let header = rest.get(..L::D_NAME)?;
    let u16_at = |offset: usize| {
        Some(usize::from(u16::from_ne_bytes(
            *header.get(offset..)?.first_chunk()?,
        )))
    };

    let reclen = u16_at(D_RECLEN)?;
    // `None` when `reclen` is smaller than the header or larger than `rest`.
    let name_field = rest.get(L::D_NAME..reclen)?;
    let next = at + reclen;

    if L::INODE_ZERO_IS_REMOVED && header.get(D_INO..)?.first_chunk::<8>()? == &[0; 8] {
        return Some(Record { next, entry: None });
    }

    let name = match L::D_NAMLEN {
        Some(offset) => {
            let namlen = u16_at(offset)?;
            if *name_field.get(namlen)? != 0 {
                return None;
            }
            name_field.get(..namlen)?
        }
        None => {
            // A scalar loop here showed up in startup profiles on large directories.
            let nul = bun_core::strings::index_of_char_usize(name_field, 0);
            let nul = nul.unwrap_or(name_field.len());
            // `None` when the field has no NUL.
            name_field.get(nul)?;
            name_field.get(..nul)?
        }
    };
    // One test for every name longer than `..`.
    if name.len() <= 2 {
        match name {
            b"" => return None,
            b"." | b".." => return Some(Record { next, entry: None }),
            _ => {}
        }
    }

    Some(Record {
        next,
        entry: Some(Entry {
            name,
            d_type: *header.get(L::D_TYPE)?,
        }),
    })
}

/// The error a walker returns for a record that [`parse`] rejects. The kernel
/// answers the same way when a FUSE server sends it a malformed entry.
#[cold]
pub fn malformed(syscall: Tag) -> Error {
    Error::from_code(E::EIO, syscall)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One well-formed record of `reclen` bytes. Every byte that is not a
    /// field is `fill`.
    fn record<L: Layout>(ino: u64, d_type: u8, name: &[u8], reclen: usize, fill: u8) -> Vec<u8> {
        // The name and its NUL fit.
        assert!(L::D_NAME + name.len() < reclen);
        let mut bytes = vec![fill; reclen];
        bytes[..L::D_NAME].fill(0);
        bytes[D_INO..][..8].copy_from_slice(&ino.to_ne_bytes());
        bytes[D_RECLEN..][..2].copy_from_slice(&(reclen as u16).to_ne_bytes());
        bytes[L::D_TYPE] = d_type;
        if let Some(offset) = L::D_NAMLEN {
            bytes[offset..][..2].copy_from_slice(&(name.len() as u16).to_ne_bytes());
        }
        bytes[L::D_NAME..][..name.len()].copy_from_slice(name);
        bytes[L::D_NAME + name.len()] = 0;
        bytes
    }

    fn set_reclen(bytes: &mut [u8], reclen: usize) {
        bytes[D_RECLEN..][..2].copy_from_slice(&(reclen as u16).to_ne_bytes());
    }

    #[derive(Debug, PartialEq)]
    enum Walked {
        Names(Vec<Vec<u8>>),
        MalformedAt(usize),
    }

    fn walk<L: Layout>(filled: &[u8]) -> Walked {
        let mut names = Vec::new();
        let mut at = 0;
        while at < filled.len() {
            let Some(record) = parse::<L>(filled, at) else {
                return Walked::MalformedAt(at);
            };
            assert!(at < record.next && record.next <= filled.len());
            if let Some(entry) = record.entry {
                let nul = at + L::D_NAME + entry.name.len();
                assert!(nul < record.next);
                assert_eq!(filled[nul], 0);
                names.push(entry.name.to_vec());
            }
            at = record.next;
        }
        Walked::Names(names)
    }

    fn names(list: &[&[u8]]) -> Walked {
        Walked::Names(list.iter().map(|name| name.to_vec()).collect())
    }

    macro_rules! each_layout {
        ($test:ident) => {
            $test::<Linux>();
            $test::<Darwin>();
            $test::<FreeBsd>();
        };
    }

    #[test]
    fn walks_well_formed_records() {
        fn check<L: Layout>() {
            let mut buf = record::<L>(7, 8, b"a.txt", 32, 0);
            buf.extend(record::<L>(8, 4, b"dir", 32, 0xEE));
            // The longest name a record can carry.
            buf.extend(record::<L>(9, 8, &[b'n'; 255], L::D_NAME + 256, 0));
            assert_eq!(walk::<L>(&buf), names(&[b"a.txt", b"dir", &[b'n'; 255]]));

            let first = parse::<L>(&buf, 0).unwrap();
            assert_eq!(first.next, 32);
            assert_eq!(first.entry.unwrap().d_type, 8);
            let second = parse::<L>(&buf, 32).unwrap();
            assert_eq!(second.next, 64);
            assert_eq!(second.entry.unwrap().d_type, 4);
        }
        each_layout!(check);
    }

    #[test]
    fn rejects_a_record_too_short_for_a_name() {
        fn check<L: Layout>() {
            // Shorter than the header, then the header alone.
            for reclen in [0, 1, 8, L::D_NAME - 1, L::D_NAME] {
                let mut buf = record::<L>(7, 8, b"a.txt", 32, 0);
                buf.extend(record::<L>(8, 8, b"b.txt", 32, 0));
                set_reclen(&mut buf, reclen);
                assert_eq!(walk::<L>(&buf), Walked::MalformedAt(0), "reclen {reclen}");

                let mut buf = record::<L>(7, 8, b"a.txt", 32, 0);
                buf.extend(record::<L>(8, 8, b"b.txt", 32, 0));
                set_reclen(&mut buf[32..], reclen);
                assert_eq!(walk::<L>(&buf), Walked::MalformedAt(32), "reclen {reclen}");
            }
        }
        each_layout!(check);
    }

    #[test]
    fn rejects_a_buffer_of_zeros() {
        fn check<L: Layout>() {
            assert_eq!(walk::<L>(&[0; 144]), Walked::MalformedAt(0));
        }
        each_layout!(check);
    }

    #[test]
    fn rejects_a_record_that_runs_past_the_bytes_returned() {
        fn check<L: Layout>() {
            let mut buf = record::<L>(7, 8, b"a.txt", 32, 0);
            buf.extend(record::<L>(8, 8, b"b.txt", 32, 0));

            // The byte count ends inside the last record, then inside its header.
            assert_eq!(walk::<L>(&buf[..63]), Walked::MalformedAt(32));
            assert_eq!(
                walk::<L>(&buf[..32 + L::D_NAME - 1]),
                Walked::MalformedAt(32)
            );
            assert_eq!(walk::<L>(&buf[..32 + D_RECLEN]), Walked::MalformedAt(32));

            set_reclen(&mut buf, 65);
            assert_eq!(walk::<L>(&buf), Walked::MalformedAt(0));
            set_reclen(&mut buf, usize::from(u16::MAX));
            assert_eq!(walk::<L>(&buf), Walked::MalformedAt(0));

            assert!(parse::<L>(&buf, buf.len()).is_none());
            assert!(parse::<L>(&buf, buf.len() + 1).is_none());
            assert!(parse::<L>(&buf, usize::MAX).is_none());
        }
        each_layout!(check);
    }

    #[test]
    fn rejects_a_name_with_no_nul_inside_the_record() {
        fn check<L: Layout>() {
            let mut buf = record::<L>(7, 8, b"a.txt", 32, 0);
            buf.extend(record::<L>(8, 8, b"b.txt", 32, 0));
            buf[L::D_NAME..32].fill(b'x');
            assert_eq!(walk::<L>(&buf), Walked::MalformedAt(0));
        }
        each_layout!(check);
    }

    #[test]
    fn rejects_an_empty_name() {
        fn check<L: Layout>() {
            let mut buf = record::<L>(7, 4, b"", 32, 0);
            buf.extend(record::<L>(8, 8, b"b.txt", 32, 0));
            assert_eq!(walk::<L>(&buf), Walked::MalformedAt(0));
        }
        each_layout!(check);
    }

    #[test]
    fn rejects_a_name_length_that_runs_past_the_record() {
        fn check<L: Layout>() {
            let offset = L::D_NAMLEN.unwrap();
            // The NUL would be the first byte after the record, then far past it.
            for namlen in [32 - L::D_NAME, 1024] {
                let mut buf = record::<L>(7, 8, b"a.txt", 32, b'x');
                buf.extend(record::<L>(8, 8, b"b.txt", 32, 0));
                buf[offset..][..2].copy_from_slice(&(namlen as u16).to_ne_bytes());
                assert_eq!(walk::<L>(&buf), Walked::MalformedAt(0), "namlen {namlen}");
            }
        }
        check::<Darwin>();
        check::<FreeBsd>();
    }

    #[test]
    fn name_length_decides_the_name_where_the_layout_has_one() {
        fn check<L: Layout>() {
            // Bytes after the NUL belong to the record and are not the name.
            let buf = record::<L>(7, 8, b"kept.txt", 80, 0xAB);
            assert_eq!(walk::<L>(&buf), names(&[b"kept.txt"]));
        }
        each_layout!(check);
    }

    #[test]
    fn skips_a_removed_entry_without_reading_its_name() {
        fn check<L: Layout>() {
            let offset = L::D_NAMLEN.unwrap();

            let mut unterminated = record::<L>(0, 8, b"old", 32, 0);
            unterminated[L::D_NAME..].fill(b'x');
            let mut stale_length = record::<L>(0, 8, b"", 32, 0);
            stale_length[offset..][..2].copy_from_slice(&40u16.to_ne_bytes());
            let mut header_only = record::<L>(0, 0, b"", 32, 0);
            header_only.truncate(L::D_NAME);
            set_reclen(&mut header_only, L::D_NAME);

            for removed in [
                record::<L>(0, 8, b"gone.txt", 40, 0xEE),
                record::<L>(0, 0, b"", 512, 0),
                unterminated,
                stale_length,
                header_only,
            ] {
                let mut buf = record::<L>(7, 8, b"a.txt", 32, 0);
                buf.extend(&removed);
                buf.extend(record::<L>(8, 8, b"b.txt", 32, 0));
                assert_eq!(walk::<L>(&buf), names(&[b"a.txt", b"b.txt"]));
            }

            // Its length is still checked.
            let mut buf = record::<L>(0, 8, b"gone.txt", 40, 0);
            set_reclen(&mut buf, 0);
            assert_eq!(walk::<L>(&buf), Walked::MalformedAt(0));
            set_reclen(&mut buf, L::D_NAME - 1);
            assert_eq!(walk::<L>(&buf), Walked::MalformedAt(0));
            set_reclen(&mut buf, 41);
            assert_eq!(walk::<L>(&buf), Walked::MalformedAt(0));
        }
        check::<Darwin>();
        check::<FreeBsd>();
    }

    #[test]
    fn linux_reports_an_entry_with_inode_zero() {
        let buf = record::<Linux>(0, 8, b"a.txt", 32, 0);
        assert_eq!(walk::<Linux>(&buf), names(&[b"a.txt"]));
    }

    #[test]
    fn skips_dot_and_dot_dot() {
        fn check<L: Layout>() {
            let mut buf = record::<L>(1, 4, b".", 32, 0);
            buf.extend(record::<L>(2, 4, b"..", 32, 0));
            // Names of the same lengths that are not skipped.
            for name in [&b"a"[..], b"..a", b".a", b"a.", b"ab", b"...", b".git"] {
                buf.extend(record::<L>(3, 8, name, 32, 0));
            }
            assert_eq!(
                walk::<L>(&buf),
                names(&[b"a", b"..a", b".a", b"a.", b"ab", b"...", b".git"])
            );
        }
        each_layout!(check);
    }
}
