//! Zero-copy ingest body parsing (sonic-rs via serde, borrowed keys, one flat value vec).

use serde::de::{self, DeserializeSeed, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use std::borrow::Cow;
use std::fmt;

pub struct PVal<'de> {
    pub key: Cow<'de, str>,
    pub step: i64,
    pub ts: f64,
    pub value: f64,
    /// Index of the point this value came from (for server-assigned steps).
    pub point: u32,
}

#[derive(Default)]
pub struct Parsed<'de> {
    pub project: Option<Cow<'de, str>>,
    pub experiment: Option<Cow<'de, str>>,
    pub config: Option<serde_json::Map<String, serde_json::Value>>,
    pub status: Option<Cow<'de, str>>,
    pub host: Option<Cow<'de, str>>,
    pub values: Vec<PVal<'de>>,
    pub dropped: usize,
    /// Up to MAX_DROPPED_KEYS distinct example keys of dropped values.
    pub dropped_keys: Vec<String>,
    /// Explicit step of every point, in request order (`None` = server assigns).
    pub point_steps: Vec<Option<i64>>,
    /// True when at least one point has no `step`.
    pub auto_steps: bool,
    pub now_ts: f64,
    pub max_values: usize,
}

pub const MAX_DROPPED_KEYS: usize = 20;
const MAX_DEPTH: u32 = 16;

/// Where parsed values go (shared by all seeds).
struct Sink<'a, 'de> {
    out: &'a mut Vec<PVal<'de>>,
    dropped: &'a mut usize,
    dropped_keys: &'a mut Vec<String>,
    max: usize,
    point: u32,
}

impl<'de> Sink<'_, 'de> {
    #[inline]
    fn push<E: de::Error>(&mut self, key: Cow<'de, str>, value: f64) -> Result<(), E> {
        if !crate::util::valid_metric_key(&key) {
            self.drop_key(&key);
            return Ok(());
        }
        if self.out.len() >= self.max {
            return Err(E::custom(TOO_MANY));
        }
        self.out.push(PVal { key, step: 0, ts: 0.0, value, point: self.point });
        Ok(())
    }
    #[cold]
    fn drop_key(&mut self, key: &str) {
        *self.dropped += 1;
        if self.dropped_keys.len() < MAX_DROPPED_KEYS && !self.dropped_keys.iter().any(|k| k == key) {
            let mut k: String = key.chars().take(256).collect();
            if k.is_empty() {
                k = "(empty key)".into();
            }
            self.dropped_keys.push(k);
        }
    }
}

pub const TOO_MANY: &str = "kymo:too_many_values";

/// Borrowed-when-possible string.
struct BStr<'de>(Cow<'de, str>);

impl<'de> de::Deserialize<'de> for BStr<'de> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = BStr<'de>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a string")
            }
            fn visit_borrowed_str<E: de::Error>(self, v: &'de str) -> Result<Self::Value, E> {
                Ok(BStr(Cow::Borrowed(v)))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(BStr(Cow::Owned(v.to_owned())))
            }
            fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
                Ok(BStr(Cow::Owned(v)))
            }
        }
        d.deserialize_str(V)
    }
}

/// Optional nullable string.
struct OptBStr<'de>(Option<Cow<'de, str>>);
impl<'de> de::Deserialize<'de> for OptBStr<'de> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Option::<BStr<'de>>::deserialize(d).map(|o| OptBStr(o.map(|b| b.0)))
    }
}

/// A metric value: number / bool / "NaN" / "Infinity" / "-Infinity"; anything else -> None.
struct MVal(Option<f64>);

impl<'de> de::Deserialize<'de> for MVal {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = MVal;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a metric value")
            }
            fn visit_f64<E>(self, v: f64) -> Result<MVal, E> {
                Ok(MVal(Some(v)))
            }
            fn visit_i64<E>(self, v: i64) -> Result<MVal, E> {
                Ok(MVal(Some(v as f64)))
            }
            fn visit_u64<E>(self, v: u64) -> Result<MVal, E> {
                Ok(MVal(Some(v as f64)))
            }
            fn visit_bool<E>(self, v: bool) -> Result<MVal, E> {
                Ok(MVal(Some(if v { 1.0 } else { 0.0 })))
            }
            fn visit_str<E>(self, v: &str) -> Result<MVal, E> {
                Ok(MVal(match v {
                    "NaN" | "nan" => Some(f64::NAN),
                    "Infinity" | "+Infinity" | "inf" => Some(f64::INFINITY),
                    "-Infinity" | "-inf" => Some(f64::NEG_INFINITY),
                    _ => None,
                }))
            }
            fn visit_unit<E>(self) -> Result<MVal, E> {
                Ok(MVal(None))
            }
            fn visit_none<E>(self) -> Result<MVal, E> {
                Ok(MVal(None))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<MVal, A::Error> {
                while m.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(MVal(None))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut s: A) -> Result<MVal, A::Error> {
                while s.next_element::<IgnoredAny>()?.is_some() {}
                Ok(MVal(None))
            }
        }
        d.deserialize_any(V)
    }
}

/// Step: integer, or an integral float.
struct Step(i64);
impl<'de> de::Deserialize<'de> for Step {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Step;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an integer step")
            }
            fn visit_i64<E>(self, v: i64) -> Result<Step, E> {
                Ok(Step(v))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Step, E> {
                i64::try_from(v).map(Step).map_err(|_| E::custom("step out of range"))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Step, E> {
                if v.fract() == 0.0 && v.abs() < 9.0e18 {
                    Ok(Step(v as i64))
                } else {
                    Err(E::custom("step must be an integer"))
                }
            }
        }
        d.deserialize_any(V)
    }
}

struct Ts(Option<f64>);
impl<'de> de::Deserialize<'de> for Ts {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = MVal::deserialize(d)?;
        Ok(Ts(v.0.filter(|x| x.is_finite())))
    }
}

/// One metric value under `key`: number/bool/"NaN"/"Infinity"/"-Infinity" are kept, nested objects are
/// flattened with `/`, anything else is dropped.
struct ValueSeed<'s, 'a, 'de> {
    key: Cow<'de, str>,
    sink: &'s mut Sink<'a, 'de>,
    depth: u32,
}

impl<'de> DeserializeSeed<'de> for ValueSeed<'_, '_, 'de> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for ValueSeed<'_, '_, 'de> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a metric value")
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> Result<(), E> {
        self.sink.push(self.key, v)
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> Result<(), E> {
        self.sink.push(self.key, v as f64)
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> Result<(), E> {
        self.sink.push(self.key, v as f64)
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> Result<(), E> {
        self.sink.push(self.key, if v { 1.0 } else { 0.0 })
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<(), E> {
        match v {
            "NaN" | "nan" => self.sink.push(self.key, f64::NAN),
            "Infinity" | "+Infinity" | "inf" => self.sink.push(self.key, f64::INFINITY),
            "-Infinity" | "-inf" => self.sink.push(self.key, f64::NEG_INFINITY),
            _ => {
                self.sink.drop_key(&self.key);
                Ok(())
            }
        }
    }
    fn visit_unit<E>(self) -> Result<(), E> {
        self.sink.drop_key(&self.key);
        Ok(())
    }
    fn visit_none<E>(self) -> Result<(), E> {
        self.sink.drop_key(&self.key);
        Ok(())
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut s: A) -> Result<(), A::Error> {
        while s.next_element::<IgnoredAny>()?.is_some() {}
        self.sink.drop_key(&self.key);
        Ok(())
    }
    fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<(), A::Error> {
        if self.depth >= MAX_DEPTH {
            while m.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
            self.sink.drop_key(&self.key);
            return Ok(());
        }
        while let Some(BStr(k)) = m.next_key::<BStr<'de>>()? {
            let key = Cow::Owned(format!("{}/{}", self.key, k));
            m.next_value_seed(ValueSeed { key, sink: &mut *self.sink, depth: self.depth + 1 })?;
        }
        Ok(())
    }
}

struct MetricsSeed<'s, 'a, 'de>(&'s mut Sink<'a, 'de>);

impl<'de> DeserializeSeed<'de> for MetricsSeed<'_, '_, 'de> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for MetricsSeed<'_, '_, 'de> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a metrics object")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<(), A::Error> {
        while let Some(BStr(key)) = m.next_key::<BStr<'de>>()? {
            m.next_value_seed(ValueSeed { key, sink: &mut *self.0, depth: 1 })?;
        }
        Ok(())
    }
}

struct PointSeed<'s, 'a, 'de> {
    sink: &'s mut Sink<'a, 'de>,
    point_steps: &'s mut Vec<Option<i64>>,
    auto: &'s mut bool,
    now_ts: f64,
}

impl<'de> DeserializeSeed<'de> for PointSeed<'_, '_, 'de> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for PointSeed<'_, '_, 'de> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a point object {step?, ts?, metrics}")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<(), A::Error> {
        let start = self.sink.out.len();
        let pi = self.point_steps.len();
        if pi >= u32::MAX as usize {
            return Err(de::Error::custom(TOO_MANY));
        }
        self.sink.point = pi as u32;
        self.point_steps.push(None);
        let mut step = None;
        let mut ts = None;
        while let Some(BStr(k)) = m.next_key::<BStr<'de>>()? {
            match &*k {
                "step" => step = m.next_value::<Option<Step>>()?.map(|s| s.0),
                "ts" => ts = m.next_value::<Ts>()?.0,
                "metrics" => m.next_value_seed(MetricsSeed(&mut *self.sink))?,
                _ => {
                    m.next_value::<IgnoredAny>()?;
                }
            }
        }
        finish_point(&mut self.sink.out[start..], step, ts.unwrap_or(self.now_ts));
        self.point_steps[pi] = step;
        if step.is_none() {
            *self.auto = true;
        }
        Ok(())
    }
}

#[inline]
fn finish_point(vals: &mut [PVal], step: Option<i64>, ts: f64) {
    let step = step.unwrap_or(0);
    for v in vals {
        v.step = step;
        v.ts = ts;
    }
}

struct PointsSeed<'s, 'a, 'de> {
    sink: &'s mut Sink<'a, 'de>,
    point_steps: &'s mut Vec<Option<i64>>,
    auto: &'s mut bool,
    now_ts: f64,
}

impl<'de> DeserializeSeed<'de> for PointsSeed<'_, '_, 'de> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_seq(self)
    }
}

impl<'de> Visitor<'de> for PointsSeed<'_, '_, 'de> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("an array of points")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut s: A) -> Result<(), A::Error> {
        while s
            .next_element_seed(PointSeed {
                sink: &mut *self.sink,
                point_steps: &mut *self.point_steps,
                auto: &mut *self.auto,
                now_ts: self.now_ts,
            })?
            .is_some()
        {}
        Ok(())
    }
}

struct TopSeed<'a, 'de>(&'a mut Parsed<'de>);

impl<'de> DeserializeSeed<'de> for TopSeed<'_, 'de> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for TopSeed<'_, 'de> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("an ingest object")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<(), A::Error> {
        let p = self.0;
        let Parsed { values, dropped, dropped_keys, point_steps, auto_steps, max_values, now_ts, .. } = p;
        let mut sink = Sink { out: values, dropped, dropped_keys, max: *max_values, point: 0 };
        let now_ts = *now_ts;
        // single-point shorthand: top-level metrics (+ step, ts)
        let mut top: Option<(usize, std::ops::Range<usize>)> = None;
        let (mut top_step, mut top_ts) = (None, None);
        let (mut project, mut experiment, mut status, mut host, mut config) = (None, None, None, None, None);
        while let Some(BStr(k)) = m.next_key::<BStr<'de>>()? {
            match &*k {
                "project" => project = Some(m.next_value::<BStr<'de>>()?.0),
                "experiment" => experiment = Some(m.next_value::<BStr<'de>>()?.0),
                "status" => status = m.next_value::<OptBStr<'de>>()?.0,
                "host" => host = m.next_value::<OptBStr<'de>>()?.0,
                "config" => {
                    config = m.next_value::<Option<serde_json::Map<String, serde_json::Value>>>()?;
                }
                "points" => m.next_value_seed(PointsSeed {
                    sink: &mut sink,
                    point_steps: &mut *point_steps,
                    auto: &mut *auto_steps,
                    now_ts,
                })?,
                "metrics" => {
                    if top.is_some() {
                        return Err(de::Error::custom("duplicate 'metrics'"));
                    }
                    let pi = point_steps.len();
                    point_steps.push(None);
                    sink.point = pi as u32;
                    let start = sink.out.len();
                    m.next_value_seed(MetricsSeed(&mut sink))?;
                    top = Some((pi, start..sink.out.len()));
                }
                "step" => top_step = m.next_value::<Option<Step>>()?.map(|s| s.0),
                "ts" => top_ts = m.next_value::<Ts>()?.0,
                _ => {
                    m.next_value::<IgnoredAny>()?;
                }
            }
        }
        if let Some((pi, r)) = top {
            finish_point(&mut sink.out[r], top_step, top_ts.unwrap_or(now_ts));
            point_steps[pi] = top_step;
            if top_step.is_none() {
                *auto_steps = true;
            }
        }
        p.project = project;
        p.experiment = experiment;
        p.status = status;
        p.host = host;
        p.config = config;
        Ok(())
    }
}

pub enum ParseError {
    TooMany,
    Malformed(String),
}

pub fn parse(body: &[u8], max_values: usize) -> Result<Parsed<'_>, ParseError> {
    let now_ts = crate::util::now_ms() as f64 / 1000.0;
    let mut p = Parsed { now_ts, max_values, ..Default::default() };
    let mut de = sonic_rs::Deserializer::from_slice(body);
    match TopSeed(&mut p).deserialize(&mut de).and_then(|_| de.end()) {
        Ok(()) => Ok(p),
        Err(e) => {
            let s = e.to_string();
            if s.contains(TOO_MANY) { Err(ParseError::TooMany) } else { Err(ParseError::Malformed(s)) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parse_basic() {
        let body = br#"{"project":"p","experiment":"e","client_id":"x","seq":1,"config":{"lr":0.1},
          "points":[{"step":3,"ts":1.5,"metrics":{"a":1,"b":"NaN","c":"-Infinity","d":true,"e":"bad","f":{"x":1},"g":null}},
                    {"metrics":{"a":2},"step":4}]}"#;
        let p = parse(body, 100).ok().unwrap();
        assert_eq!(p.project.as_deref(), Some("p"));
        assert_eq!(p.values.len(), 6);
        assert_eq!(p.dropped, 2);
        assert_eq!(p.dropped_keys, vec!["e", "g"]);
        assert!(p.values[1].value.is_nan());
        assert_eq!(p.values[2].value, f64::NEG_INFINITY);
        assert_eq!(p.values[3].value, 1.0);
        assert_eq!(p.values[4].key, "f/x");
        assert_eq!(p.values[5].step, 4);
        assert_eq!(p.values[5].point, 1);
        assert!(!p.auto_steps);
        assert!(matches!(p.values[0].key, Cow::Borrowed(_)));
        assert!(matches!(parse(body, 3), Err(ParseError::TooMany)));
        assert!(matches!(parse(b"{\"points\":[{\"metrics\":5}]}", 3), Err(ParseError::Malformed(_))));
        // shorthand + missing step + nesting
        let p = parse(br#"{"step":7,"metrics":{"a":{"b":{"c":1}},"x":[1]},"project":"p"}"#, 10).ok().unwrap();
        assert_eq!(p.values[0].key, "a/b/c");
        assert_eq!(p.values[0].step, 7);
        assert_eq!(p.point_steps, vec![Some(7)]);
        assert_eq!(p.dropped_keys, vec!["x"]);
        let p = parse(br#"{"points":[{"metrics":{"a":1}},{"step":3,"metrics":{"a":2}}]}"#, 10).ok().unwrap();
        assert!(p.auto_steps);
        assert_eq!(p.point_steps, vec![None, Some(3)]);
    }
}
