# LinkedIn Activity Explorer

Drop the data export LinkedIn emails you onto a web page and browse it: activity over time, your posts and comments, search history, follows, messages, and what LinkedIn and its advertisers know about you.

The export is read entirely in your browser by a small WebAssembly module written in Rust. Nothing is uploaded, and the page has no server-side code.

**Try it:** https://jpalat.github.io/linkedin-explorer/

Not affiliated with or endorsed by LinkedIn.

## Using it

1. Request your data from LinkedIn: **Settings & Privacy → Data privacy → Download your data** ([LinkedIn's instructions](https://www.linkedin.com/help/linkedin/answer/a1339364)). LinkedIn sends a *Basic* export within minutes and a *Complete* one about a day later.
2. Open the page and drop the zip onto it, or click to choose it. You can choose both zips together. They're read oldest first by file date, so where both contain the same file, the newer export's copy wins.
3. To load a different export later, click **Open another export** at the bottom of the left menu.

Times are shown in US Eastern time. To use another zone, change `TZ` at the top of `app/app.js` (any IANA name, such as `Europe/London`) and rebuild or redeploy.

### If something goes wrong

- **"Could not read that export (…)"**: the message in brackets comes from the parser. "not a zip file" means the file is damaged or isn't a zip at all, often because the download didn't finish. Download it again from LinkedIn's email.
- **Nothing happens when you drop a file**: only files ending in `.zip` are accepted.
- **A view says it has no data**: that part of your history isn't in the export you loaded. Most views need the *Complete* export (see below).

### What each export gives you

| View | Shows | Basic | Complete |
|---|---|:-:|:-:|
| Overview | Totals, monthly activity, when you're active, reaction types | totals only | ✓ |
| Posts & comments | Searchable list of everything you wrote, per-year chart | | ✓ |
| Searches | Searches per week, top queries, full search log | | ✓ |
| Following | People, companies and hashtags you follow | companies only | ✓ |
| Messages | Every conversation, searchable | ✓ | ✓ |
| Ads & privacy | LinkedIn's inferences about you, ad targeting segments, ad clicks, off-site ads, sign-ins, security checks | targeting only | ✓ |

Views with no data in the export you loaded say so instead of drawing an empty chart.

## How it works

```
export.zip ──▶ linkedin_export.wasm ──▶ data.json (in memory) ──▶ app.js charts
               unzip, parse CSVs,
               normalise dates
```

- **`wasm/`** is a Rust crate that reads the zip, parses the 18 CSV files the views use and produces one JSON document. The same code compiles two ways:
  - to `wasm32-unknown-unknown` as `app/linkedin_export.wasm` (about 320 KB), used by the page;
  - natively as the `linkedin-build` command-line tool, for producing `data.json` ahead of time.
- **`app/`** is the page: plain HTML, CSS and JavaScript with hand-drawn SVG charts and no libraries or build step.

### The WebAssembly interface

The module exports a few C-style functions, so the page needs no generated glue code and the build needs only `rustc`:

| Export | Purpose |
|---|---|
| `alloc(len) → ptr` | Reserve memory for a zip |
| `add_zip(ptr, len) → n` | Read the zip at `ptr` and take ownership of that memory; returns the number of CSV files, or −1 on error |
| `dealloc(ptr, len)` | Free memory from `alloc` that wasn't passed to `add_zip` |
| `build(now_seconds) → ptr` | Build the JSON; read `out_len()` bytes at the returned pointer |
| `out_ptr()`, `out_len()` | The last result, or the error message after a −1 |
| `reset()` | Forget all added zips |

See `buildFromZips` in `app/app.js` for the calling side.

### Parsing notes

- `Shares_*.csv` and `Comments_*.csv` don't quote line breaks properly, so they're split on lines that begin with a timestamp instead of being parsed as CSV.
- Files named with your member ID, such as `Reactions_123456789.csv`, are matched by prefix, so any account's export works.
- The export uses six different date formats; all are converted to ISO-8601 UTC.
- LinkedIn often logs one search two or three times within a few seconds. Repeats of the same query within 10 seconds count once.
- Message bodies are HTML; tags are stripped and entities decoded.

## Building

You need Rust with the WebAssembly target:

```sh
rustup target add wasm32-unknown-unknown
wasm/build.sh
```

`build.sh` builds `app/linkedin_export.wasm` and `wasm/target/release/linkedin-build`. If the directory in `$SITE_DIR` (default `/srv/sites/linkedin-explorer`) exists, it also copies the four page files there, for self-hosting.

Run the unit tests with `cargo test` in `wasm/`.

## Hosting

The site is just four static files: `index.html`, `app.js`, `styles.css` and `linkedin_export.wasm`.

**GitHub Pages.** `.github/workflows/pages.yml` runs on every push to `main`: it runs the tests, builds the `.wasm` from source, and deploys the four files. The compiled `.wasm` is never committed. To use it in a fork, set **Settings → Pages → Source** to **GitHub Actions**.

**Locally or elsewhere.** The page must be served over HTTP; opened as a `file://` page, the browser refuses to load the `.wasm` file. After `wasm/build.sh`, any static server works:

```sh
cd app && python3 -m http.server 8791 --bind 127.0.0.1    # http://127.0.0.1:8791/?zip
```

The `?zip` makes the page ask for a zip even if a pre-built `data.json` is present (see below).

### Supporting another file from the export

1. In `Export::build` in `wasm/src/lib.rs`, read the file by its name without `.csv` (for example `rows("Logins")`, or `pairs(...)` for simple date-and-value lists) and add the result to the JSON.
2. Draw it in `app/app.js`, which receives that JSON as-is.
3. Add a test next to the existing ones at the bottom of `lib.rs`, then run `cargo test` and `wasm/build.sh`.

### Pre-building data.json

The `linkedin-build` tool takes one or more zips or unzipped export folders:

```sh
wasm/target/release/linkedin-build data/Complete_LinkedInDataExport_*.zip -o data/data.json
```

If a `data.json` sits next to the page, the page loads it at startup instead of asking for a zip (`/?zip` always asks). To get that locally, link it in with `ln -s ../data/data.json app/data.json`. `build.sh` publishes only the four page files, so the link never reaches the hosted site.

## Privacy

Your export contains every LinkedIn message you've sent or received, your search history, sign-in IP addresses and more.

- In drop-a-zip mode, the data exists only in the browser tab and is gone when you close it.
- Everything personal lives in `data/`: the zips, their unzipped contents and any `data.json`. The code folders contain none of it, and `.gitignore` keeps `data/`, zips and `data.json` out of git.
- A `data.json` file holds all of it in plain text. Never publish it to a shared or public host, and don't serve the `app/` folder to the network while a `data.json` is linked into it.

## Layout

```
app/                    the web page (index.html, app.js, styles.css, linkedin_export.wasm)
wasm/src/lib.rs         parser, plus the WebAssembly exports
wasm/src/main.rs        linkedin-build CLI
wasm/build.sh           local build
.github/workflows/      GitHub Pages deploy
data/                   your LinkedIn data (personal: never publish)
data/*.zip.zip          the exports as LinkedIn sent them
data/Basic/, Complete/  the same exports unzipped
data/data.json          pre-built output, if you made one
```

## License

MIT. See [LICENSE](LICENSE).
