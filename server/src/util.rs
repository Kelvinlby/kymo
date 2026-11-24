use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Format unix milliseconds as RFC 3339 UTC, e.g. `2026-11-23T10:00:00.123Z`.
pub fn rfc3339(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86400);
    let sod = secs.rem_euclid(86400);
    // civil_from_days (Howard Hinnant)
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        sod / 3600,
        (sod / 60) % 60,
        sod % 60
    )
}

/// Parse RFC 3339 (`YYYY-MM-DDTHH:MM:SS[.frac](Z|±HH:MM)`, `T` may be a space) to unix ms.
pub fn parse_rfc3339(s: &str) -> Option<i64> {
    let b = s.trim().as_bytes();
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        let t = b.get(r)?;
        if t.is_empty() || !t.iter().all(u8::is_ascii_digit) {
            return None;
        }
        std::str::from_utf8(t).ok()?.parse().ok()
    };
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (y, mo, d, h, mi, se) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let mut i = 19;
    let mut ms = 0i64;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let st = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == st {
            return None;
        }
        let frac = &b[st..i.min(st + 3)];
        ms = std::str::from_utf8(frac).ok()?.parse::<i64>().ok()? * 10i64.pow(3 - frac.len() as u32);
    }
    let off = match b.get(i) {
        Some(b'Z' | b'z') if i + 1 == b.len() => 0,
        Some(&c @ (b'+' | b'-')) if i + 6 == b.len() && b[i + 3] == b':' => {
            let o = num(i + 1..i + 3)? * 60 + num(i + 4..i + 6)?;
            if c == b'+' { o } else { -o }
        }
        _ => return None,
    };
    // days_from_civil (Howard Hinnant)
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = if mo > 2 { mo - 3 } else { mo + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 86400 + h * 3600 + mi * 60 + se) - off * 60) * 1000 + ms)
}

pub fn opt_rfc3339(ms: Option<i64>) -> Option<String> {
    ms.map(rfc3339)
}

const B62: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/// Random base62 string from the OS CSPRNG (rejection sampling, no modulo bias).
pub fn random_b62(len: usize) -> String {
    let mut out = String::with_capacity(len);
    let mut buf = [0u8; 64];
    while out.len() < len {
        getrandom::fill(&mut buf).expect("OS RNG failure");
        for &b in &buf {
            if b < 248 {
                out.push(B62[(b % 62) as usize] as char);
                if out.len() == len {
                    break;
                }
            }
        }
    }
    out
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("OS RNG failure");
    b
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    let out = Sha256::digest(data);
    let mut a = [0u8; 32];
    a.copy_from_slice(&out);
    a
}

/// Constant-time byte comparison.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut d = 0u8;
    for (x, y) in a.iter().zip(b) {
        d |= x ^ y;
    }
    d == 0
}

/// Natural ordering: digit runs compare numerically (`layer2` < `layer10`).
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        if a[i].is_ascii_digit() && b[j].is_ascii_digit() {
            let si = i;
            while i < a.len() && a[i].is_ascii_digit() {
                i += 1;
            }
            let sj = j;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            let na = trim_zeros(&a[si..i]);
            let nb = trim_zeros(&b[sj..j]);
            let o = na.len().cmp(&nb.len()).then_with(|| na.cmp(nb));
            if o != Ordering::Equal {
                return o;
            }
            let o = (i - si).cmp(&(j - sj)); // fewer leading zeros first
            if o != Ordering::Equal {
                return o;
            }
        } else {
            let o = a[i].cmp(&b[j]);
            if o != Ordering::Equal {
                return o;
            }
            i += 1;
            j += 1;
        }
    }
    (a.len() - i).cmp(&(b.len() - j))
}

fn trim_zeros(s: &[u8]) -> &[u8] {
    let n = s.iter().take_while(|&&c| c == b'0').count();
    &s[n.min(s.len().saturating_sub(1))..]
}

pub fn valid_username(s: &str) -> bool {
    (2..=32).contains(&s.len())
        && s.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'_' | b'.' | b'-'))
}

pub fn valid_project_name(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-'))
}

pub fn valid_experiment_name(s: &str) -> bool {
    let n = s.chars().count();
    (1..=128).contains(&n) && !s.chars().any(|c| c.is_control())
}

#[inline]
pub fn valid_metric_key(s: &str) -> bool {
    // Control chars = C0 (< 0x20), DEL, and C1 (U+0080..U+009F = 0xC2 0x80..0x9F in UTF-8).
    let b = s.as_bytes();
    (1..=256).contains(&b.len())
        && !b.iter().any(|&c| c < 0x20 || c == 0x7f)
        && !b.windows(2).any(|w| w[0] == 0xc2 && (0x80..=0x9f).contains(&w[1]))
}

pub fn valid_status(s: &str) -> bool {
    matches!(s, "running" | "finished" | "failed" | "crashed")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rfc3339_roundtrip() {
        for ms in [0i64, 1_795_497_600_123, 951_782_400_000, -86_400_000, 4_102_444_799_999] {
            assert_eq!(parse_rfc3339(&rfc3339(ms)), Some(ms), "{}", rfc3339(ms));
        }
        assert_eq!(parse_rfc3339("2026-11-24T10:30:00+01:30"), parse_rfc3339("2026-11-24T09:00:00Z"));
        assert_eq!(parse_rfc3339("2026-11-24 09:00:00.5Z"), parse_rfc3339("2026-11-24T09:00:00.500Z"));
        assert_eq!(parse_rfc3339("2026-13-01T00:00:00Z"), None);
        assert_eq!(parse_rfc3339("yesterday"), None);
    }
    #[test]
    fn natural() {
        let mut v = vec!["layer10", "layer2", "a/b", "layer1", "eval/acc", "layer02", "train/loss"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["a/b", "eval/acc", "layer1", "layer2", "layer02", "layer10", "train/loss"]);
    }
    #[test]
    fn metric_keys() {
        assert!(valid_metric_key("train/loss"));
        assert!(valid_metric_key("über/ß"));
        assert!(!valid_metric_key(""));
        assert!(!valid_metric_key("a\nb"));
        assert!(!valid_metric_key("a\u{85}b"));
        assert!(!valid_metric_key(&"x".repeat(257)));
    }
    #[test]
    fn time() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(rfc3339(1732400000123), "2024-11-23T22:13:20.123Z");
    }
}
