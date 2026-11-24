//! Zero-copy ingest body parsing (sonic-rs via serde, borrowed keys, one flat value vec).

use serde::de::{self, DeserializeSeed, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use std::borrow::Cow;
use std::fmt;

pub struct PVal<'de> {
    pub key: Cow<'de, str>,
    pub step: i64,
    pub ts: f64,
    pub value: f64,
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
    pub now_ts: f64,
    pub max_values: usize,
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

struct MetricsSeed<'a, 'de> {
    out: &'a mut Vec<PVal<'de>>,
    dropped: &'a mut usize,
    max: usize,
}

impl<'de> DeserializeSeed<'de> for MetricsSeed<'_, 'de> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for MetricsSeed<'_, 'de> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a metrics object")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<(), A::Error> {
        while let Some(BStr(key)) = m.next_key::<BStr<'de>>()? {
            let MVal(v) = m.next_value::<MVal>()?;
            match v {
                Some(value) if crate::util::valid_metric_key(&key) => {
                    if self.out.len() >= self.max {
                        return Err(de::Error::custom(TOO_MANY));
                    }
                    self.out.push(PVal { key, step: 0, ts: 0.0, value });
                }
                _ => *self.dropped += 1,
            }
        }
        Ok(())
    }
}

struct PointSeed<'a, 'de> {
    out: &'a mut Vec<PVal<'de>>,
    dropped: &'a mut usize,
    max: usize,
    now_ts: f64,
}

impl<'de> DeserializeSeed<'de> for PointSeed<'_, 'de> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for PointSeed<'_, 'de> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a point object {step, ts, metrics}")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<(), A::Error> {
        let start = self.out.len();
        let mut step = None;
        let mut ts = None;
        while let Some(BStr(k)) = m.next_key::<BStr<'de>>()? {
            match &*k {
                "step" => step = Some(m.next_value::<Step>()?.0),
                "ts" => ts = m.next_value::<Ts>()?.0,
                "metrics" => m.next_value_seed(MetricsSeed { out: self.out, dropped: self.dropped, max: self.max })?,
                _ => {
                    m.next_value::<IgnoredAny>()?;
                }
            }
        }
        let step = step.ok_or_else(|| de::Error::custom("point without step"))?;
        let ts = ts.unwrap_or(self.now_ts);
        for v in &mut self.out[start..] {
            v.step = step;
            v.ts = ts;
        }
        Ok(())
    }
}

struct PointsSeed<'a, 'de> {
    out: &'a mut Vec<PVal<'de>>,
    dropped: &'a mut usize,
    max: usize,
    now_ts: f64,
}

impl<'de> DeserializeSeed<'de> for PointsSeed<'_, 'de> {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_seq(self)
    }
}

impl<'de> Visitor<'de> for PointsSeed<'_, 'de> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("an array of points")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut s: A) -> Result<(), A::Error> {
        while s
            .next_element_seed(PointSeed { out: self.out, dropped: self.dropped, max: self.max, now_ts: self.now_ts })?
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
        while let Some(BStr(k)) = m.next_key::<BStr<'de>>()? {
            match &*k {
                "project" => p.project = Some(m.next_value::<BStr<'de>>()?.0),
                "experiment" => p.experiment = Some(m.next_value::<BStr<'de>>()?.0),
                "status" => p.status = m.next_value::<OptBStr<'de>>()?.0,
                "host" => p.host = m.next_value::<OptBStr<'de>>()?.0,
                "config" => {
                    p.config = m.next_value::<Option<serde_json::Map<String, serde_json::Value>>>()?;
                }
                "points" => m.next_value_seed(PointsSeed {
                    out: &mut p.values,
                    dropped: &mut p.dropped,
                    max: p.max_values,
                    now_ts: p.now_ts,
                })?,
                _ => {
                    m.next_value::<IgnoredAny>()?;
                }
            }
        }
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
        assert_eq!(p.values.len(), 5);
        assert_eq!(p.dropped, 3);
        assert!(p.values[1].value.is_nan());
        assert_eq!(p.values[2].value, f64::NEG_INFINITY);
        assert_eq!(p.values[3].value, 1.0);
        assert_eq!(p.values[4].step, 4);
        assert!(matches!(p.values[0].key, Cow::Borrowed(_)));
        assert!(matches!(parse(body, 3), Err(ParseError::TooMany)));
        assert!(matches!(parse(b"{\"points\":[{\"metrics\":{}}]}", 3), Err(ParseError::Malformed(_))));
    }
}
