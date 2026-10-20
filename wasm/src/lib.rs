//! Turns a LinkedIn data export (Basic or Complete) into the data.json the Activity Explorer renders.
//!
//! Reads the export zip directly. Compiled to wasm32 it runs in the browser (see the `wasm`
//! module for the exports); natively it backs the `linkedin-build` CLI.

use std::collections::{BTreeMap, HashMap};
use std::io::{Cursor, Read};

use serde_json::{json, Map, Value};

/// CSV files from one or more exports, keyed by file name (directories dropped).
#[derive(Default)]
pub struct Export {
    files: BTreeMap<String, Vec<u8>>,
}

impl Export {
    /// Add every CSV in a zip. Files already present are replaced, so add older exports first.
    pub fn add_zip(&mut self, bytes: &[u8]) -> Result<usize, String> {
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("not a zip file: {e}"))?;
        let mut n = 0;
        for i in 0..zip.len() {
            let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
            let name = f.name().map_err(|e| e.to_string())?.rsplit('/').next().unwrap_or("").to_string();
            if f.is_dir() || !name.to_ascii_lowercase().ends_with(".csv") {
                continue;
            }
            let mut buf = Vec::with_capacity(f.size() as usize);
            f.read_to_end(&mut buf).map_err(|e| format!("{name}: {e}"))?;
            self.files.insert(name, buf);
            n += 1;
        }
        Ok(n)
    }

    pub fn add_file(&mut self, name: &str, bytes: Vec<u8>) {
        self.files.insert(name.to_string(), bytes);
    }

    /// `stem` matches "stem.csv", or "stem_<member id>.csv" as in Shares_123456789.csv.
    fn text(&self, stem: &str) -> Option<String> {
        let hit = self.files.get(&format!("{stem}.csv")).or_else(|| {
            self.files.iter().find_map(|(k, v)| {
                let id = k.strip_prefix(stem)?.strip_prefix('_')?.strip_suffix(".csv")?;
                (!id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())).then_some(v)
            })
        })?;
        let s = String::from_utf8_lossy(hit);
        Some(s.strip_prefix('\u{feff}').unwrap_or(&s).to_string())
    }

    fn rows(&self, stem: &str) -> Vec<Row> {
        let Some(text) = self.text(stem) else { return vec![] };
        let mut rd = csv::ReaderBuilder::new().flexible(true).from_reader(text.as_bytes());
        let head: Vec<String> = match rd.headers() {
            Ok(h) => h.iter().map(str::to_string).collect(),
            Err(_) => return vec![],
        };
        rd.records()
            .filter_map(Result::ok)
            .map(|r| {
                let mut m = HashMap::new();
                for (k, v) in head.iter().zip(r.iter()) {
                    m.insert(k.clone(), v.to_string());
                }
                Row(m)
            })
            .collect()
    }

    /// Build data.json. `now` is seconds since the Unix epoch, recorded as the build time.
    pub fn build(&self, now: i64) -> String {
        let mut data = Map::new();

        let profile = self.rows("Profile");
        let me = profile.first().map(|p| format!("{} {}", p.get("First Name"), p.get("Last Name"))).unwrap_or_default();
        data.insert(
            "profile".into(),
            match profile.first() {
                Some(p) => json!({"name": me, "headline": p.get("Headline")}),
                None => json!({}),
            },
        );

        // Your own posts and comments
        let mut posts = vec![];
        for r in self.records("Shares") {
            let (date, rest) = (&r[..19], r.get(20..).unwrap_or(""));
            let Some((link, rest)) = rest.split_once(',') else { continue };
            let mut tail = rest.rsplitn(4, ',');
            let (_vis, _media, shared, body) = (tail.next(), tail.next(), tail.next(), tail.next());
            let (Some(shared), Some(body)) = (shared, body) else { continue };
            posts.push(json!({"d": iso(date), "url": link, "text": clean(body), "shared": shared.trim_matches('"')}));
        }
        data.insert("posts".into(), Value::Array(posts));

        let mut comments = vec![];
        for r in self.records("Comments") {
            let (date, rest) = (&r[..19], r.get(20..).unwrap_or(""));
            let Some((link, msg)) = rest.split_once(',') else { continue };
            comments.push(json!({"d": iso(date), "url": link, "text": clean(msg)}));
        }
        data.insert("comments".into(), Value::Array(comments));

        let pairs = |stem: &str, cols: &[&str]| -> Value {
            Value::Array(
                self.rows(stem)
                    .iter()
                    .map(|r| {
                        let mut v = vec![json!(iso(r.get(cols[0])))];
                        v.extend(cols[1..].iter().map(|c| json!(r.get(c))));
                        Value::Array(v)
                    })
                    .collect(),
            )
        };
        data.insert("reactions".into(), pairs("Reactions", &["Date", "Type"]));
        data.insert("reposts".into(), pairs("InstantReposts", &["Date", "Link"]));
        data.insert("votes".into(), pairs("Votes", &["Date", "OptionText", "Link"]));
        data.insert("saved".into(), pairs("Saved_Items", &["CreatedTime", "savedItem"]));

        // Searches: LinkedIn often logs the same query 2-3 times within seconds; keep one.
        let mut raw: Vec<(Option<String>, String)> = self
            .rows("SearchQueries")
            .iter()
            .map(|r| (iso(r.get("Time")), r.get("Search Query").trim().to_string()))
            .collect();
        raw.sort_by(|a, b| a.0.as_deref().unwrap_or("").cmp(b.0.as_deref().unwrap_or("")));
        let mut searches = vec![];
        let mut last: HashMap<String, i64> = HashMap::new();
        for (d, q) in &raw {
            let Some(d) = d else { continue };
            if q.is_empty() {
                continue;
            }
            let t = epoch(d);
            let key = q.to_lowercase();
            if last.get(&key).is_some_and(|&p| t - p < 10) {
                continue;
            }
            last.insert(key, t);
            searches.push(json!([d, q]));
        }
        data.insert("searches".into(), Value::Array(searches));
        data.insert("searches_raw".into(), json!(raw.len()));

        // Following
        data.insert("follows_members".into(), pairs("Member_Follows", &["Date", "FullName", "Status"]));
        data.insert("follows_companies".into(), pairs("Company Follows", &["Followed On", "Organization"]));
        data.insert("follows_hashtags".into(), pairs("Hashtag_Follows", &["CreatedTime", "HashTag", "State"]));

        // Ads and what LinkedIn infers
        data.insert("ads_clicked".into(), pairs("Ads Clicked", &["Ad clicked Date", "Ad Title/Id"]));
        data.insert("ads_offsite".into(), pairs("LAN Ads Engagement", &["Date", "Action", "Page/App"]));
        let inferences = self
            .rows("Inferences_about_you")
            .iter()
            .map(|r| {
                json!({"category": r.get("Category"), "type": r.get("Type of inference"),
                       "description": r.get("Description"), "value": r.get("Inference")})
            })
            .collect();
        data.insert("inferences".into(), Value::Array(inferences));
        data.insert("ad_targeting".into(), self.ad_targeting());

        // Account security
        let logins = self
            .rows("Logins")
            .iter()
            .map(|r| json!([iso(r.get("Login Date")), r.get("IP Address"), device(r.get("User Agent"))]))
            .collect();
        data.insert("logins".into(), Value::Array(logins));
        let challenges = self
            .rows("Security Challenges")
            .iter()
            .map(|r| {
                json!([iso(r.get("Challenge Date")), r.get("IP Address"), r.get("Country"),
                       r.get("Challenge Type"), device(r.get("User Agent"))])
            })
            .collect();
        data.insert("challenges".into(), Value::Array(challenges));

        data.insert("conversations".into(), self.conversations(&me));
        data.insert("built".into(), json!(iso_from_epoch(now)));
        serde_json::to_string(&Value::Object(data)).unwrap_or_default()
    }

    /// Comments and Shares break CSV quoting around line breaks, so split on record-start dates instead.
    fn records(&self, stem: &str) -> Vec<String> {
        let Some(text) = self.text(stem) else { return vec![] };
        let b = text.as_bytes();
        let starts: Vec<usize> = std::iter::once(0)
            .chain(b.iter().enumerate().filter(|(_, c)| **c == b'\n').map(|(i, _)| i + 1))
            .filter(|&i| is_record_start(&b[i..]))
            .collect();
        starts
            .iter()
            .enumerate()
            .map(|(k, &a)| {
                let end = starts.get(k + 1).copied().unwrap_or(b.len());
                text[a..end].trim_end_matches(['\r', '\n']).to_string()
            })
            .collect()
    }

    fn ad_targeting(&self) -> Value {
        let mut out: Map<String, Value> = Map::new();
        let Some(text) = self.text("Ad_Targeting") else { return Value::Object(out) };
        let mut rd = csv::ReaderBuilder::new().has_headers(false).flexible(true).from_reader(text.as_bytes());
        let mut it = rd.records().filter_map(Result::ok);
        let (Some(head), vals) = (it.next(), it.next().unwrap_or_default()) else { return Value::Object(out) };
        for (k, v) in head.iter().zip(vals.iter()) {
            for item in v.split(';').map(str::trim).filter(|s| !s.is_empty()) {
                let list = out.entry(k).or_insert_with(|| json!([])).as_array_mut().unwrap();
                if !list.iter().any(|x| x == item) {
                    list.push(json!(item));
                }
            }
        }
        Value::Object(out)
    }

    /// Messages grouped into conversations, most recently active first.
    fn conversations(&self, me: &str) -> Value {
        struct Conv {
            id: String,
            title: String,
            folder: String,
            people: Vec<String>,
            to: Option<String>,
            msgs: Vec<(Option<String>, String, String, String)>,
        }
        let mut order: Vec<Conv> = vec![];
        let mut index: HashMap<String, usize> = HashMap::new();
        for r in self.rows("messages") {
            let cid = r.get("CONVERSATION ID").to_string();
            let i = *index.entry(cid.clone()).or_insert_with(|| {
                order.push(Conv {
                    id: cid,
                    title: r.get("CONVERSATION TITLE").into(),
                    folder: r.get("FOLDER").into(),
                    people: vec![],
                    to: None,
                    msgs: vec![],
                });
                order.len() - 1
            });
            let c = &mut order[i];
            // Names can contain commas, so take people from senders; fall back to the raw recipient field.
            let (from, to) = (r.get("FROM"), r.get("TO"));
            if !from.trim().is_empty() && from != me {
                if !c.people.iter().any(|p| p == from.trim()) {
                    c.people.push(from.trim().into());
                }
            } else if !to.trim().is_empty() && to != me && c.to.is_none() {
                c.to = Some(to.trim().into());
            }
            c.msgs.push((iso(&r.get("DATE").replace(" UTC", "")), from.into(), r.get("SUBJECT").into(), html_text(r.get("CONTENT"))));
        }
        for c in &mut order {
            c.msgs.sort_by(|a, b| a.0.as_deref().unwrap_or("").cmp(b.0.as_deref().unwrap_or("")));
            c.people.sort();
            if c.people.is_empty() {
                c.people.extend(c.to.take());
            }
        }
        let latest = |c: &Conv| c.msgs.last().and_then(|m| m.0.clone()).unwrap_or_default();
        order.sort_by_key(|c| std::cmp::Reverse(latest(c)));
        Value::Array(
            order
                .into_iter()
                .map(|c| {
                    let msgs: Vec<Value> = c.msgs.into_iter().map(|(d, f, s, t)| json!([d, f, s, t])).collect();
                    json!({"id": c.id, "title": c.title, "people": c.people, "folder": c.folder, "msgs": msgs})
                })
                .collect(),
        )
    }
}

struct Row(HashMap<String, String>);

impl Row {
    fn get(&self, k: &str) -> &str {
        self.0.get(k).map_or("", String::as_str)
    }
}

fn is_record_start(b: &[u8]) -> bool {
    const PAT: &[u8] = b"dddd-dd-dd dd:dd:dd,";
    b.len() >= PAT.len() && PAT.iter().zip(b).all(|(p, c)| if *p == b'd' { c.is_ascii_digit() } else { p == c })
}

// ---------- dates ----------

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS: [&str; 7] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/// Normalise the export's assorted timestamp formats to ISO-8601 UTC.
pub fn iso(s: &str) -> Option<String> {
    let s = s.trim();
    const FORMATS: [&str; 6] =
        ["%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S UTC", "%a %b %d %H:%M:%S UTC %Y", "%Y-%m-%d %H:%M:%S UTC", "%Y/%m/%d", "%d %b %Y"];
    let [y, mo, d, h, mi, se] = FORMATS.iter().find_map(|f| strptime(s, f))?;
    Some(format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{se:02}Z"))
}

/// Just enough of strptime for the formats above: returns [year, month, day, hour, minute, second].
fn strptime(s: &str, fmt: &str) -> Option<[i64; 6]> {
    let mut out = [1900, 1, 1, 0, 0, 0];
    let (s, mut i) = (s.as_bytes(), 0);
    let mut f = fmt.bytes();
    let num = |i: &mut usize, max: usize| -> Option<i64> {
        let n = s[*i..].iter().take(max).take_while(|c| c.is_ascii_digit()).count();
        let v = std::str::from_utf8(&s[*i..*i + n]).ok()?.parse().ok()?;
        *i += n;
        Some(v)
    };
    let word = |i: &mut usize, names: &[&str]| -> Option<i64> {
        let w = s.get(*i..*i + 3)?.to_ascii_lowercase();
        let k = names.iter().position(|n| n.as_bytes() == w.as_slice())?;
        *i += 3;
        Some(k as i64)
    };
    while let Some(c) = f.next() {
        match c {
            b'%' => match f.next()? {
                b'Y' => out[0] = num(&mut i, 4)?,
                b'm' => out[1] = num(&mut i, 2)?,
                b'd' => out[2] = num(&mut i, 2)?,
                b'H' => out[3] = num(&mut i, 2)?,
                b'M' => out[4] = num(&mut i, 2)?,
                b'S' => out[5] = num(&mut i, 2)?,
                b'b' => out[1] = word(&mut i, &MONTHS)? + 1,
                b'a' => _ = word(&mut i, &DAYS)?,
                _ => return None,
            },
            b' ' => {
                let n = s[i..].iter().take_while(|c| c.is_ascii_whitespace()).count();
                if n == 0 {
                    return None;
                }
                i += n;
            }
            _ if s.get(i) == Some(&c) => i += 1,
            _ => return None,
        }
    }
    let [y, mo, d, h, mi, se] = out;
    let ok = i == s.len() && (1..=12).contains(&mo) && d >= 1 && d <= days_in_month(y, mo) && h < 24 && mi < 60 && se < 62;
    ok.then_some(out)
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        2 if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days since 1970-01-01 (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
    era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468
}

fn epoch(iso: &str) -> i64 {
    let n = |a: usize, b: usize| iso.get(a..b).and_then(|x| x.parse().ok()).unwrap_or(0);
    days_from_civil(n(0, 4), n(5, 7), n(8, 10)) * 86400 + n(11, 13) * 3600 + n(14, 16) * 60 + n(17, 19)
}

pub fn iso_from_epoch(t: i64) -> String {
    let (z, secs) = (t.div_euclid(86400) + 719468, t.rem_euclid(86400));
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", secs / 3600, secs / 60 % 60, secs % 60)
}

// ---------- text ----------

fn collapse_newlines(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut run = 0;
    for ch in s.chars() {
        run = if ch == '\n' { run + 1 } else { 0 };
        if run <= 2 {
            out.push(ch);
        }
    }
    out
}

fn clean(s: &str) -> String {
    let s = s.replace('\r', "");
    let lines: Vec<&str> = s.split('\n').map(|l| l.trim().trim_matches('"').trim()).collect();
    collapse_newlines(&lines.join("\n")).trim().replace("\"\"", "\"")
}

/// Message bodies are HTML: keep line breaks, drop tags, decode entities.
fn html_text(s: &str) -> String {
    let s = replace_tags(s, |inner| {
        let l = inner.to_ascii_lowercase();
        let br = l.strip_prefix("br").is_some_and(|r| matches!(r.trim_start(), "" | "/"));
        (br || l == "/p" || l == "/div" || l == "/li").then_some("\n")
    });
    let s = replace_tags(&s, |_| Some(""));
    collapse_newlines(&unescape(&s).replace('\u{a0}', " ")).trim().to_string()
}

/// Replace each `<...>` (no `>` inside, at least one char) for which `f` returns Some.
fn replace_tags(s: &str, f: impl Fn(&str) -> Option<&'static str>) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('<') {
        let after = &rest[i + 1..];
        match after.find('>').filter(|&j| j > 0).and_then(|j| f(&after[..j]).map(|r| (j, r))) {
            Some((j, r)) => {
                out.push_str(&rest[..i]);
                out.push_str(r);
                rest = &after[j + 1..];
            }
            None => {
                out.push_str(&rest[..=i]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn unescape(s: &str) -> String {
    const NAMED: &[(&str, &str)] = &[
        ("amp", "&"), ("lt", "<"), ("gt", ">"), ("quot", "\""), ("apos", "'"), ("nbsp", "\u{a0}"),
        ("hellip", "…"), ("mdash", "—"), ("ndash", "–"), ("lsquo", "‘"), ("rsquo", "’"), ("ldquo", "“"),
        ("rdquo", "”"), ("bull", "•"), ("middot", "·"), ("copy", "©"), ("reg", "®"), ("trade", "™"),
    ];
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i + 1..];
        if let Some(r) = rest.strip_prefix('#') {
            let (hex, digits) = match r.strip_prefix(['x', 'X']) {
                Some(h) => (true, h),
                None => (false, r),
            };
            let n = digits.bytes().take_while(|c| if hex { c.is_ascii_hexdigit() } else { c.is_ascii_digit() }).count();
            if let Some(ch) = u32::from_str_radix(&digits[..n], if hex { 16 } else { 10 }).ok().and_then(char::from_u32).filter(|_| n > 0) {
                out.push(ch);
                rest = &digits[n..];
                rest = rest.strip_prefix(';').unwrap_or(rest);
                continue;
            }
        } else if let Some((name, val)) = NAMED.iter().find(|(n, _)| rest.starts_with(&format!("{n};"))) {
            out.push_str(val);
            rest = &rest[name.len() + 1..];
            continue;
        }
        out.push('&');
    }
    out.push_str(rest);
    out
}

fn device(ua: &str) -> String {
    let os = [("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android"), ("Mac OS X", "Mac"), ("Windows", "Windows"), ("CrOS", "ChromeOS"), ("Linux", "Linux")]
        .iter()
        .find(|(p, _)| ua.contains(p))
        .map_or("Other", |x| x.1);
    let br = [("LinkedIn", "LinkedIn app"), ("Edg/", "Edge"), ("Firefox", "Firefox"), ("Chrome", "Chrome"), ("Safari", "Safari")]
        .iter()
        .find(|(p, _)| ua.contains(p))
        .map_or("Other", |x| x.1);
    format!("{br} on {os}")
}

// ---------- WebAssembly exports ----------

/// A tiny C-style ABI so the page needs no generated glue: JS calls `alloc`, copies a zip into
/// that memory, calls `add_zip`, then `build` and reads `out_len` bytes of JSON from the pointer.
#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::Export;
    use std::cell::RefCell;

    thread_local! {
        static EXPORT: RefCell<Export> = RefCell::default();
        static OUT: RefCell<Vec<u8>> = RefCell::default();
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn alloc(len: usize) -> *mut u8 {
        let mut v = Vec::<u8>::with_capacity(len);
        let p = v.as_mut_ptr();
        std::mem::forget(v);
        p
    }

    /// # Safety
    /// `ptr`/`len` must come from `alloc`.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
        drop(unsafe { Vec::from_raw_parts(ptr, 0, len) });
    }

    /// Takes ownership of a buffer from `alloc` holding a zip. Returns the CSV count, or -1 with
    /// the error message available through `build`'s output buffer.
    ///
    /// # Safety
    /// `ptr`/`len` must come from `alloc` and be fully written.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn add_zip(ptr: *mut u8, len: usize) -> i32 {
        let bytes = unsafe { Vec::from_raw_parts(ptr, len, len) };
        match EXPORT.with_borrow_mut(|e| e.add_zip(&bytes)) {
            Ok(n) => n as i32,
            Err(msg) => {
                OUT.set(msg.into_bytes());
                -1
            }
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn reset() {
        EXPORT.set(Export::default());
        OUT.set(vec![]);
    }

    /// Builds data.json; read `out_len()` bytes at the returned pointer.
    #[unsafe(no_mangle)]
    pub extern "C" fn build(now: f64) -> *const u8 {
        let json = EXPORT.with_borrow(|e| e.build(now as i64));
        OUT.set(json.into_bytes());
        out_ptr()
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn out_ptr() -> *const u8 {
        OUT.with_borrow(|o| o.as_ptr())
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn out_len() -> usize {
        OUT.with_borrow(|o| o.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        assert_eq!(iso("2026-01-21 19:03:02").as_deref(), Some("2026-01-21T19:03:02Z"));
        assert_eq!(iso("2025/09/17 08:12:22 UTC").as_deref(), Some("2025-09-17T08:12:22Z"));
        assert_eq!(iso("Sun Oct 13 02:01:50 UTC 2024").as_deref(), Some("2024-10-13T02:01:50Z"));
        assert_eq!(iso("2026/04/20").as_deref(), Some("2026-04-20T00:00:00Z"));
        assert_eq!(iso("5 Mar 2019").as_deref(), Some("2019-03-05T00:00:00Z"));
        assert_eq!(iso("2026-02-30 00:00:00"), None);
        assert_eq!(iso(""), None);
        assert_eq!(iso_from_epoch(epoch("2024-02-29T23:59:58Z")), "2024-02-29T23:59:58Z");
    }

    #[test]
    fn html() {
        assert_eq!(html_text("<p>Hi&nbsp;there<br/>you &amp; me</p><div>x &#8217; &#x41;</div>"), "Hi there\nyou & me\nx ’ A");
        assert_eq!(html_text("a < b"), "a < b");
    }
}
