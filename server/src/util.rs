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

pub fn valid_metric_key(s: &str) -> bool {
    (1..=256).contains(&s.len()) && !s.chars().any(|c| c.is_control())
}

pub fn valid_status(s: &str) -> bool {
    matches!(s, "running" | "finished" | "failed" | "crashed")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn natural() {
        let mut v = vec!["layer10", "layer2", "a/b", "layer1", "eval/acc", "layer02", "train/loss"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["a/b", "eval/acc", "layer1", "layer2", "layer02", "layer10", "train/loss"]);
    }
    #[test]
    fn time() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(rfc3339(1732400000123), "2024-11-23T22:13:20.123Z");
    }
}
