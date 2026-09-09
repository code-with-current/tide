//! Mermaid diagrams as cached PNG images from the hosted `mermaid.ink`
//! renderer.
//!
//! ```mermaid fences rasterize through `https://mermaid.ink/img/…` — the
//! diagram source, base64url-encoded in the path, themed light or dark by a
//! query parameter. Tide fetches the PNG once, stores it under
//! `~/.tide/mermaid-cache/`, and the timeline shows that image for the
//! lifetime of the entry. There is no local generator behind it: when the
//! hosted renderer cannot answer (offline, service error, a diagram it
//! rejects) the host declines and the markdown engine's source preview
//! stands in, retrying after the failure window. A streaming fence settles
//! before it fetches, so diagrams render while the stream is ongoing
//! without one request per commit.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use gpui::{App, ObjectFit, WeakEntity, div, img, prelude::*, px};

use super::Tide;
use crate::theme::Theme;

/// The hosted renderer's URL: `mermaid.ink` rasterizes a base64url-encoded
/// diagram server-side. `type=png` is load-bearing: bare requests answer in
/// JPEG. `scale` is deliberately absent — the service applies it only
/// alongside `width` or `height`, and its natural output already outruns the
/// card's display density.
fn mermaid_ink_url(source: &str, dark: bool) -> String {
    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(source);
    format!(
        "https://mermaid.ink/img/{encoded}?type=png&theme={}",
        if dark { "dark" } else { "default" }
    )
}

fn cache_key(source: &str, dark: bool) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    // The scheme version isolates the cache from every earlier renderer (a
    // stale entry must never satisfy a newer pipeline). The ink image varies
    // only with the source and the light/dark mode, so the key stops there.
    "mermaid-cache-v4-ink".hash(&mut hasher);
    source.hash(&mut hasher);
    dark.hash(&mut hasher);
    hasher.finish()
}

fn cache_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(".tide")
        .join("mermaid-cache")
}

fn cache_path(key: u64) -> PathBuf {
    cache_dir().join(format!("{key:016x}.png"))
}

static IN_FLIGHT: LazyLock<Mutex<HashSet<u64>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
/// Recently failed fetches, with when the last attempt started. A failure is
/// honored only for a window, so a transient miss (offline moment, service
/// hiccup) retries the next time the card is on screen instead of showing
/// the source preview for the process's life.
static FAILED: LazyLock<Mutex<HashMap<u64, std::time::Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// How long a failed fetch suppresses retries.
const FAILURE_WINDOW: Duration = Duration::from_secs(20);

/// How long a miss waits for its source to stop changing before fetching. A
/// streaming fence hands the host a new, longer source on every commit and
/// each would be its own network request and its own worthless cache entry;
/// the diagram fetches once its source has held still for this long, so the
/// image still updates through a long stream's natural pauses without one
/// request per commit.
const STREAMING_SETTLE: Duration = Duration::from_millis(1200);

/// Misses whose sources are still settling, keyed like the cache. The entry
/// carries what the settle timer needs to start the fetch.
static PENDING: LazyLock<Mutex<HashMap<u64, (String, bool)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Whether `newer` supersedes `older` as the same fence grown mid-stream: a
/// strict prefix extension. Divergent sources are different diagrams and
/// must not cancel each other.
fn supersedes(older: &str, newer: &str) -> bool {
    older.len() < newer.len() && newer.starts_with(older)
}

/// Diagrams already decoded into gpui's render format, keyed like the PNG on
/// disk. The card body paints from here through [`gpui::ImageSource::Render`],
/// which is ready the moment the element is — no asynchronous asset load has
/// to land and trigger a repaint before a cached diagram can appear.
static DECODED: LazyLock<Mutex<HashMap<u64, Option<Arc<gpui::RenderImage>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Decode PNG bytes into the BGRA frame format gpui rasterizes.
fn decode_png(bytes: &[u8]) -> Option<Arc<gpui::RenderImage>> {
    use image::ImageDecoder as _;
    use std::io::Cursor;

    let decoder = image::codecs::png::PngDecoder::new(Cursor::new(bytes)).ok()?;
    let (width, height) = decoder.dimensions();
    let mut rgba = vec![0u8; decoder.total_bytes() as usize];
    decoder.read_image(&mut rgba).ok()?;
    for pixel in rgba.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    let buffer = image::RgbaImage::from_raw(width, height, rgba)?;
    Some(Arc::new(gpui::RenderImage::new(vec![image::Frame::new(
        buffer,
    )])))
}

/// One shared client for the hosted renderer — connection reuse across
/// diagrams, with a total-request timeout. The *blocking* client on purpose:
/// its async sibling needs an ambient Tokio runtime this app never installs
/// and panics (`Handle::current`) on first use, while the blocking client
/// carries its own runtime and runs fine off the executor through `unblock`.
static INK_CLIENT: LazyLock<reqwest::blocking::Client> = LazyLock::new(|| {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new())
});

/// Fetch a PNG from the hosted `mermaid.ink` renderer. Only bytes answering
/// with PNG magic count; anything else (JSON error, HTML, empty) is a plain
/// `None` and the card keeps the source preview.
async fn fetch_ink_png(source: &str, dark: bool) -> Option<Vec<u8>> {
    let url = mermaid_ink_url(source, dark);
    smol::unblock(move || {
        let response = match INK_CLIENT.get(&url).send() {
            Ok(response) => response,
            Err(error) => {
                ink_diag(format_args!("fetch ERROR {error:#}"));
                return None;
            }
        };
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.bytes().unwrap_or_default();
            let head = String::from_utf8_lossy(&body[..body.len().min(120)]).to_string();
            ink_diag(format_args!("fetch STATUS {status} — {head}"));
            return None;
        }
        let body = match response.bytes() {
            Ok(body) => body,
            Err(error) => {
                ink_diag(format_args!("fetch BODY {error:#}"));
                return None;
            }
        };
        if !body.starts_with(&[0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n']) {
            ink_diag(format_args!("fetch MAGIC missing, {} bytes", body.len()));
            return None;
        }
        ink_diag(format_args!("fetch OK {} bytes", body.len()));
        Some(body.to_vec())
    })
    .await
}

/// Temporary diagnostics for the hosted fetch — removed once the behavior is
/// confirmed stable in the running app (a 400 with "Unknown diagram error"
/// was observed once at 2026-09-02 08:04 and never reproduced).
fn ink_diag(args: std::fmt::Arguments) {
    use std::io::Write as _;
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/tide-ink.log")
    {
        let _ = writeln!(file, "[{seconds:6}] {args}");
    }
}

/// The markdown engine's inline mermaid host: the card body is the cached
/// image when one exists. A warm file with a cold decode (an app restart
/// found the cache on disk) schedules one background decode and declines —
/// exactly as while a fetch is in flight. Otherwise the source must first
/// settle ([`STREAMING_SETTLE`]) so a streaming fence cannot fire a request
/// per commit, then the fetch runs in the background and the host declines
/// this frame — the engine's source preview shows until the PNG lands and
/// notifies the app. A fetch that misses leaves the preview standing for
/// the failure window (one scheduled retry recovers an idle card); there is
/// no local generator behind it.
pub(super) fn host_element(
    tide: &WeakEntity<Tide>,
    source: &str,
    _window: &mut gpui::Window,
    cx: &mut App,
) -> Option<gpui::AnyElement> {
    let dark = Theme::current(cx).is_dark;
    let key = cache_key(source, dark);
    let path = cache_path(key);

    if path.is_file() {
        if let Some(image) = DECODED.lock().unwrap().get(&key).cloned().flatten() {
            return Some(image_element(image));
        }
        if IN_FLIGHT.lock().unwrap().insert(key) {
            let tide = tide.clone();
            cx.spawn(async move |cx| {
                let decoded = cx
                    .background_executor()
                    .spawn(async move {
                        std::fs::read(&path)
                            .ok()
                            .and_then(|bytes| decode_png(&bytes))
                    })
                    .await;
                DECODED.lock().unwrap().insert(key, decoded);
                IN_FLIGHT.lock().unwrap().remove(&key);
                let _ = tide.update(cx, |_, cx| cx.notify());
            })
            .detach();
        }
        return None;
    }

    let declined_for_failure = FAILED
        .lock()
        .unwrap()
        .get(&key)
        .is_some_and(|failed_at| failed_at.elapsed() < FAILURE_WINDOW);
    if declined_for_failure {
        return None;
    }

    {
        let mut pending = PENDING.lock().unwrap();
        // A newer, longer source that extends a settling one supersedes it:
        // the fence grew, the partial can never be asked for again, and its
        // fetch would only burn a request and a dead cache entry.
        pending.retain(|_, (settling, _)| !supersedes(settling, source));
        if IN_FLIGHT.lock().unwrap().contains(&key) {
            return None;
        }
        // Already settling — its timer is running; re-arming would fetch the
        // same source once per settle interval.
        if pending.insert(key, (source.to_owned(), dark)).is_some() {
            return None;
        }
    }

    let tide = tide.clone();
    cx.spawn(async move |cx| {
        smol::Timer::after(STREAMING_SETTLE).await;
        let Some((source, dark)) = PENDING.lock().unwrap().remove(&key) else {
            return; // superseded by a longer source while settling
        };
        run_fetch(key, source, dark, path, tide, cx).await;
    })
    .detach();
    None
}

/// One fetch attempt for a settled diagram: fetch, cache, decode, notify.
async fn run_fetch(
    key: u64,
    source: String,
    dark: bool,
    path: PathBuf,
    tide: WeakEntity<Tide>,
    cx: &mut gpui::AsyncApp,
) {
    // Two attempts: the fetch itself, then one scheduled retry past the
    // failure window — the transcript goes idle when a stream ends, so a
    // card whose final fetch missed (an ink hiccup, a rate-limit storm)
    // would otherwise sit on the source preview until the user forced a
    // repaint by switching sessions.
    for attempt in 0..2 {
        if !IN_FLIGHT.lock().unwrap().insert(key) {
            return;
        }
        let Some(bytes) = fetch_ink_png(&source, dark).await else {
            FAILED
                .lock()
                .unwrap()
                .insert(key, std::time::Instant::now());
            IN_FLIGHT.lock().unwrap().remove(&key);
            if attempt == 0 {
                smol::Timer::after(FAILURE_WINDOW + Duration::from_secs(1)).await;
                continue;
            }
            return;
        };
        let decoded = cx
            .background_executor()
            .spawn(async move {
                let written = (|| {
                    std::fs::create_dir_all(cache_dir())?;
                    let tmp = path.with_extension("png.part");
                    std::fs::write(&tmp, &bytes)?;
                    std::fs::rename(&tmp, &path)?;
                    Ok::<(), std::io::Error>(())
                })();
                match written {
                    Ok(()) => decode_png(&bytes),
                    Err(_) => None,
                }
            })
            .await;
        IN_FLIGHT.lock().unwrap().remove(&key);
        match decoded {
            Some(image) => {
                DECODED.lock().unwrap().insert(key, Some(image));
                let _ = tide.update(cx, |_, cx| cx.notify());
            }
            None => {
                FAILED
                    .lock()
                    .unwrap()
                    .insert(key, std::time::Instant::now());
            }
        }
        return;
    }
}

fn image_element(image: Arc<gpui::RenderImage>) -> gpui::AnyElement {
    div()
        .w_full()
        .h(px(280.0))
        .flex()
        .overflow_hidden()
        .child(
            img(gpui::ImageSource::Render(image))
                .size_full()
                .object_fit(ObjectFit::Contain),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_keys_track_source_and_theme_mode() {
        assert_eq!(cache_key("A --> B", true), cache_key("A --> B", true));
        assert_ne!(cache_key("A --> B", true), cache_key("A --> C", true));
        assert_ne!(
            cache_key("A --> B", true),
            cache_key("A --> B", false),
            "the light and dark modes never share a cache entry"
        );
    }

    #[test]
    fn ink_urls_carry_url_safe_base64_and_the_theme() {
        use base64::Engine as _;
        let url = mermaid_ink_url("graph TD\nA-->/w+ey==", false);
        let (path, query) = url
            .strip_prefix("https://mermaid.ink/img/")
            .expect("the ink endpoint with the encoded diagram")
            .split_once('?')
            .expect("the theme rides as a query parameter");
        // URL-safe base64: no padding, no chars a path segment forbids.
        assert!(!path.contains(['+', '/', '=']));
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(path)
            .expect("valid url-safe base64");
        assert_eq!(decoded, b"graph TD\nA-->/w+ey==");
        // The query answers in PNG and follows the theme; `scale` stays out
        // because the service only honors it beside `width`/`height`.
        assert_eq!(query, "type=png&theme=default");
        assert!(mermaid_ink_url("graph TD", true).contains("theme=dark"));
    }

    #[test]
    fn streaming_growth_supersedes_only_prefix_extensions() {
        assert!(supersedes(
            "sequenceDiagram\n    participant U",
            "sequenceDiagram\n    participant U as User"
        ));
        assert!(
            !supersedes("graph TD\nA", "graph TD\nA"),
            "identical sources are the same key, not supersession"
        );
        assert!(
            !supersedes("graph TD\nA", "sequenceDiagram\nA --> B"),
            "divergent diagrams never cancel each other"
        );
        assert!(
            !supersedes("graph TD\nA --> B", "graph TD\nA"),
            "a shrinking source is not stream growth"
        );
    }

    #[test]
    fn png_bytes_decode_into_the_render_format_or_decline() {
        // The decode store's contract: a valid PNG decodes, anything else is
        // a plain None — never a panic — so a corrupt cache entry degrades to
        // the source preview instead of taking the frame down.
        let png = {
            let mut bytes = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(4, 2, {
                image::Rgba([1, 2, 3, 255])
            }))
            .write_to(&mut bytes, image::ImageFormat::Png)
            .expect("encoding a stub png");
            bytes.into_inner()
        };
        assert!(decode_png(&png).is_some());
        assert!(decode_png(b"not a png").is_none());
        assert!(decode_png(&[]).is_none());
    }
}
