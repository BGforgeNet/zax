//! A PE32 image carrying nothing but a version resource, for the tests of the version reader and of
//! everything that reads a version through it. Built rather than vendored because a real `ddraw.dll` is
//! nearly a megabyte and what the reader has to get right is the resource, not the code.
//!
//! Test-only: nothing ZAX ships writes PE images.

/// A key or value as the resource format spells it: UTF-16LE, NUL-terminated.
fn utf16z(text: &str) -> Vec<u8> {
    let mut out: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
    out.extend([0, 0]);
    out
}

fn pad4(out: &mut Vec<u8>) {
    while !out.len().is_multiple_of(4) {
        out.push(0);
    }
}

/// One `VS_VERSIONINFO` block: a header, a NUL-terminated key, a value on a four-byte boundary, and
/// whatever blocks sit inside it.
///
/// `value_words` is what the format asks for - the value's length in 16-bit words for a text block, and
/// in bytes for the fixed-info one - which is why it is stated rather than derived from `value`.
fn block(key: &str, kind: u16, value: &[u8], value_words: u16, children: &[u8]) -> Vec<u8> {
    let mut out = vec![0, 0];
    out.extend(value_words.to_le_bytes());
    out.extend(kind.to_le_bytes());
    out.extend(utf16z(key));
    pad4(&mut out);
    out.extend_from_slice(value);
    pad4(&mut out);
    out.extend_from_slice(children);
    let length = u16::try_from(out.len()).expect("a fixture block is small");
    out[0..2].copy_from_slice(&length.to_le_bytes());
    out
}

/// `VS_FIXEDFILEINFO`, whose numbers the reader does not use - it reads the strings - but whose presence
/// and signature it parses through.
fn fixed_info() -> Vec<u8> {
    let fields: [u32; 13] = [
        0xfeef_04bd, // signature
        0x0001_0000, // structure version
        0,           // file version, high and low
        0,
        0, // product version, high and low
        0,
        0x0000_003f, // flags mask
        0,           // flags
        0x0000_0004, // Windows NT
        0x0000_0002, // a dynamic library
        0,           // subtype
        0,           // date, high and low
        0,
    ];
    fields.iter().flat_map(|one| one.to_le_bytes()).collect()
}

/// The version resource holding these string values, under language 1033.
fn version_resource(values: &[(&str, &str)]) -> Vec<u8> {
    let mut strings = Vec::new();
    for (key, value) in values {
        let text = utf16z(value);
        let words = u16::try_from(text.len() / 2).expect("a fixture value is short");
        strings.extend(block(key, 1, &text, words, &[]));
    }
    // `040904b0` is language 1033 in the Unicode codepage, which is what a library records.
    let table = block("040904b0", 1, &[], 0, &strings);
    let string_info = block("StringFileInfo", 1, &[], 0, &table);
    let fixed = fixed_info();
    let fixed_len = u16::try_from(fixed.len()).expect("the fixed block is 52 bytes");
    block("VS_VERSION_INFO", 0, &fixed, fixed_len, &string_info)
}

fn directory(entries: u16) -> Vec<u8> {
    let mut out = vec![0; 12];
    out.extend(entries.to_le_bytes());
    out.extend([0, 0]);
    out
}

fn entry(id: u32, offset: u32, is_directory: bool) -> Vec<u8> {
    let mut out = id.to_le_bytes().to_vec();
    let target = if is_directory {
        offset | 0x8000_0000
    } else {
        offset
    };
    out.extend(target.to_le_bytes());
    out
}

/// The `.rsrc` section's bytes: a three-level tree (type, name, language) over one version resource.
fn resource_section(rva: u32, values: &[(&str, &str)]) -> Vec<u8> {
    // Every level is one directory of one entry, so the layout is fixed and can be written straight
    // through rather than laid out in a pass of its own.
    let level2 = 24;
    let level3 = 48;
    let data_entry = 72;
    let blob = 88;
    let payload = version_resource(values);

    let mut out = Vec::new();
    out.extend(directory(1));
    out.extend(entry(16, level2, true)); // RT_VERSION
    out.extend(directory(1));
    out.extend(entry(1, level3, true)); // the resource's own id
    out.extend(directory(1));
    out.extend(entry(1033, data_entry, false)); // language
    assert_eq!(out.len(), data_entry as usize, "the tree is a fixed layout");
    out.extend((rva + blob).to_le_bytes());
    out.extend(
        u32::try_from(payload.len())
            .expect("a fixture is small")
            .to_le_bytes(),
    );
    out.extend([0u8; 8]); // codepage and reserved
    assert_eq!(out.len(), blob as usize, "the blob follows the data entry");
    out.extend(payload);
    out
}

/// A library recording these version strings, and nothing else.
///
/// Section and file alignment are the same, so a section's address in the image is its offset in the
/// file - which is what lets the reader map the resource directory without a loader.
#[must_use]
pub fn library(values: &[(&str, &str)]) -> Vec<u8> {
    const ALIGNMENT: u32 = 0x200;
    const HEADERS: u32 = 0x200;
    let rsrc = resource_section(HEADERS, values);
    let raw_size =
        u32::try_from(rsrc.len().next_multiple_of(ALIGNMENT as usize)).expect("a fixture is small");

    let mut image = vec![0u8; HEADERS as usize];
    image[0..2].copy_from_slice(b"MZ");
    image[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());

    let pe = 0x80;
    image[pe..pe + 4].copy_from_slice(b"PE\0\0");
    let coff = pe + 4;
    let put16 = |image: &mut Vec<u8>, at: usize, value: u16| {
        image[at..at + 2].copy_from_slice(&value.to_le_bytes());
    };
    let put32 = |image: &mut Vec<u8>, at: usize, value: u32| {
        image[at..at + 4].copy_from_slice(&value.to_le_bytes());
    };
    put16(&mut image, coff, 0x014c); // i386
    put16(&mut image, coff + 2, 1); // one section
    put16(&mut image, coff + 16, 224); // size of the PE32 optional header
    put16(&mut image, coff + 18, 0x2102); // a 32-bit dynamic library

    let optional = coff + 20;
    put16(&mut image, optional, 0x10b); // PE32
    put32(&mut image, optional + 20, 0x1000); // base of code
    put32(&mut image, optional + 28, 0x1000_0000); // image base
    put32(&mut image, optional + 32, ALIGNMENT); // section alignment
    put32(&mut image, optional + 36, ALIGNMENT); // file alignment
    put16(&mut image, optional + 48, 4); // major subsystem version
    put32(&mut image, optional + 56, HEADERS + raw_size); // size of image
    put32(&mut image, optional + 60, HEADERS); // size of headers
    put16(&mut image, optional + 68, 2); // GUI subsystem
    put32(&mut image, optional + 92, 16); // number of data directories

    // The resource directory is the third entry, and the only one this image has.
    let directories = optional + 96;
    put32(&mut image, directories + 16, HEADERS);
    put32(
        &mut image,
        directories + 20,
        u32::try_from(rsrc.len()).expect("a fixture is small"),
    );

    let section = optional + 224;
    image[section..section + 5].copy_from_slice(b".rsrc");
    put32(
        &mut image,
        section + 8,
        u32::try_from(rsrc.len()).expect("a fixture is small"),
    ); // virtual size
    put32(&mut image, section + 12, HEADERS); // virtual address
    put32(&mut image, section + 16, raw_size);
    put32(&mut image, section + 20, HEADERS); // pointer to raw data
    put32(&mut image, section + 36, 0x4000_0040); // initialized data, read only

    image.extend(rsrc);
    image.resize((HEADERS + raw_size) as usize, 0);
    image
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pe_version::read_file_version;

    #[test]
    fn the_fixture_is_an_image_the_reader_reads_a_version_out_of() {
        // The positive control every other test of the reader rests on: without it, a reader that
        // answered nothing for everything would pass them all.
        let image = library(&[("FileVersion", "4.5")]);
        assert_eq!(read_file_version(&image).as_deref(), Some("4.5"));
    }

    #[test]
    fn the_hi_res_patchs_own_spelling_comes_back_normalized() {
        let image = library(&[("FileVersion", "4, 1, 8, 0")]);
        assert_eq!(read_file_version(&image).as_deref(), Some("4.1.8"));
    }

    #[test]
    fn a_library_recording_no_file_version_has_none_to_read() {
        let image = library(&[("ProductName", "Something")]);
        assert_eq!(read_file_version(&image), None);
    }

    #[test]
    fn a_blank_file_version_is_not_a_version() {
        let image = library(&[("FileVersion", "")]);
        assert_eq!(read_file_version(&image), None);
    }
}
