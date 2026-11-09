/// A console line whose allocation is retained across R's buffer refills.
pub(crate) struct ConsoleInput {
    bytes: Vec<u8>,
    offset: usize,
}

impl From<Vec<u8>> for ConsoleInput {
    fn from(bytes: Vec<u8>) -> Self {
        Self { bytes, offset: 0 }
    }
}

impl ConsoleInput {
    /// Writes a NUL-terminated chunk, returning true only after the newline fits.
    pub(crate) fn write_into(&mut self, target: &mut [u8]) -> bool {
        assert!(target.len() >= 2);
        let remaining = &self.bytes[self.offset..];
        let used = remaining.len().min(target.len() - 1);
        target[..used].copy_from_slice(&remaining[..used]);
        self.offset += used;

        if used < target.len() - 1 {
            target[used] = b'\n';
            target[used + 1] = 0;
            true
        } else {
            target[used] = 0;
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ConsoleInput;

    #[test]
    fn preserves_bytes_and_appends_one_newline_across_chunk_boundaries() {
        let source = "a\u{e9}\u{65e5}\u{1f642}".repeat(8).into_bytes();
        for len in 0..=source.len() {
            for capacity in 2..=17 {
                let bytes = source[..len].to_vec();
                let allocation = bytes.as_ptr();
                let mut input = ConsoleInput::from(bytes);
                let mut actual = Vec::new();
                loop {
                    let mut target = vec![0xff; capacity];
                    let complete = input.write_into(&mut target);
                    let end = target.iter().position(|&byte| byte == 0).unwrap();
                    actual.extend_from_slice(&target[..end]);
                    assert_eq!(input.bytes.as_ptr(), allocation);
                    if complete {
                        break;
                    }
                }
                assert_eq!(actual, [&source[..len], b"\n"].concat());
            }
        }
    }

    #[test]
    fn accepts_changing_buffer_sizes_without_reallocating() {
        let bytes = vec![b'x'; 16 * 1024 * 1024];
        let allocation = bytes.as_ptr();
        let mut input = ConsoleInput::from(bytes);
        let mut written = 0;
        for capacity in [4096, 2, 8192].into_iter().cycle() {
            let mut target = vec![0xff; capacity];
            let complete = input.write_into(&mut target);
            let end = target.iter().position(|&byte| byte == 0).unwrap();
            if complete {
                assert_eq!(target[end - 1], b'\n');
                assert!(target[..end - 1].iter().all(|&byte| byte == b'x'));
            } else {
                assert!(target[..end].iter().all(|&byte| byte == b'x'));
            }
            written += end;
            assert_eq!(input.bytes.as_ptr(), allocation);
            if complete {
                break;
            }
        }
        assert_eq!(written, 16 * 1024 * 1024 + 1);
    }
}
