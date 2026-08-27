//! Bounded per-terminal scrollback held in the MAIN process (disposable-
//! projection model): the renderer can re-attach with a snapshot after a
//! reload while the PTY keeps running. Chunks keep their coalescer-flush
//! boundaries — trimming whole chunks is inherently UTF-8-safe. Port of
//! `91ec558:app/platform/terminal-scrollback.ts`.

pub struct ScrollbackSnapshot {
    pub data: String,
    pub seq: u64,
}

pub struct ScrollbackBuffer {
    chunks: Vec<String>,
    chars: usize,
    next_seq: u64,
    max_chars: usize,
}

impl ScrollbackBuffer {
    pub fn new(max_chars: usize) -> Self {
        Self {
            chunks: Vec::new(),
            chars: 0,
            next_seq: 1,
            max_chars,
        }
    }

    /// Append a chunk; returns its sequence number (monotonic from 1).
    /// An empty chunk is a no-op returning the previous seq, exactly like
    /// the TS buffer (the renderer's dedupe treats `seq <= last` as seen).
    pub fn append(&mut self, data: &str) -> u64 {
        if data.is_empty() {
            return self.next_seq - 1;
        }
        self.chunks.push(data.to_owned());
        self.chars += data.chars().count();
        while self.chunks.len() > 1 && self.chars > self.max_chars {
            self.chars -= self.chunks[0].chars().count();
            self.chunks.remove(0);
        }
        let seq = self.next_seq;
        self.next_seq += 1;
        seq
    }

    pub fn snapshot(&self) -> ScrollbackSnapshot {
        ScrollbackSnapshot {
            data: self.chunks.concat(),
            seq: self.next_seq - 1,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_returns_monotonic_seq_from_one() {
        let mut buf = ScrollbackBuffer::new(1024);
        assert_eq!(buf.append("a"), 1);
        assert_eq!(buf.append("b"), 2);
        assert_eq!(buf.append(""), 2);
        let snap = buf.snapshot();
        assert_eq!(snap.data, "ab");
        assert_eq!(snap.seq, 2);
    }

    #[test]
    fn empty_buffer_snapshots_to_empty_string_and_seq_zero() {
        let buf = ScrollbackBuffer::new(8);
        let snap = buf.snapshot();
        assert_eq!(snap.data, "");
        assert_eq!(snap.seq, 0);
    }

    #[test]
    fn trimming_drops_whole_chunks_and_keeps_at_least_one() {
        let mut buf = ScrollbackBuffer::new(10);
        for i in 0..6 {
            buf.append(&format!("chunk{i}:xxxxx"));
        }
        let snap = buf.snapshot();
        // 6 chunks x 11 chars = 66; trimming to <=10 leaves only the newest.
        assert_eq!(snap.data, "chunk5:xxxxx");
        // The seq counter is unaffected by trimming — the renderer's dedupe
        // compares against the last push, not the buffer length.
        assert_eq!(snap.seq, 6);
    }

    #[test]
    fn oversized_single_chunk_is_never_dropped() {
        let mut buf = ScrollbackBuffer::new(4);
        buf.append("way more than four chars");
        assert_eq!(buf.snapshot().data, "way more than four chars");
    }

    #[test]
    fn trimming_never_splits_a_utf8_codepoint() {
        let mut buf = ScrollbackBuffer::new(3);
        buf.append("alpha");
        buf.append("→→→");
        let data = buf.snapshot().data;
        assert_eq!(data, "→→→");
    }
}
