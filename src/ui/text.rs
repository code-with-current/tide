/// Middle-truncate a string to at most `max` chars: keep the head + tail,
/// drop the middle behind a single ellipsis. Directory paths keep their
/// distinguishing tail this way, unlike a `…` suffix.
pub fn middle_ellipsis(s: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    if s.chars().count() <= max {
        return s.to_owned();
    }
    let head = (max - 1).div_ceil(2);
    let tail = (max - 1) / 2;
    let mut out = String::with_capacity(max + 4);
    out.extend(s.chars().take(head));
    out.push('…');
    out.extend(s.chars().skip(s.chars().count() - tail));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_strings_pass_through_untouched() {
        assert_eq!(middle_ellipsis("abc", 8), "abc");
        assert_eq!(middle_ellipsis("12345678", 8), "12345678");
    }

    #[test]
    fn head_and_tail_join_at_the_boundary() {
        // head = 4, ellipsis = 1, tail = 3.
        assert_eq!(middle_ellipsis("abcdefghijklmnop", 8), "abcd…nop");
        assert_eq!(middle_ellipsis("abcdefghijk", 5), "ab…jk");
    }

    #[test]
    fn splits_on_char_boundaries_with_multibyte_input() {
        assert_eq!(middle_ellipsis("日本語のテキストです", 5), "日本…です");
    }
}
