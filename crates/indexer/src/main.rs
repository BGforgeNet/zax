//! `zax-indexer build --sources <dir> --out <dir>`
//!
//! Reads every `*.yml` under the sources directory, builds the index, and writes `v1/index.json` under
//! the output directory. A token in `GITHUB_TOKEN` is sent to GitHub when set. Notes a maintainer
//! should act on go to stderr; nothing is written unless the whole build succeeds.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use zax_host::HostPlatform;
use zax_indexer::build::build;
use zax_indexer::github::Github;
use zax_indexer::source::parse_source;
use zax_platform::{Error, Platform, Result};

struct Args {
    sources: PathBuf,
    out: PathBuf,
}

const USAGE: &str = "usage: zax-indexer build --sources <dir> --out <dir>";

fn args() -> std::result::Result<Args, String> {
    let mut argv = std::env::args().skip(1);
    if argv.next().as_deref() != Some("build") {
        return Err(USAGE.to_owned());
    }
    let (mut sources, mut out) = (None, None);
    while let Some(flag) = argv.next() {
        let value = argv.next().map(PathBuf::from);
        match flag.as_str() {
            "--sources" => sources = value,
            "--out" => out = value,
            other => return Err(format!("unknown argument {other}\n{USAGE}")),
        }
    }
    match (sources, out) {
        (Some(sources), Some(out)) => Ok(Args { sources, out }),
        _ => Err(USAGE.to_owned()),
    }
}

fn read_sources(
    platform: &dyn Platform,
    directory: &Path,
) -> Result<Vec<zax_indexer::source::Source>> {
    let mut names: Vec<String> = platform
        .fs()
        .list(directory)?
        .into_iter()
        .map(|entry| entry.name)
        .filter(|name| name.ends_with(".yml"))
        .collect();
    // Sorted, so the index does not depend on the order the directory happens to list.
    names.sort();
    let mut out = Vec::new();
    for name in names {
        let bytes = platform.fs().read(&directory.join(&name))?;
        let text = String::from_utf8(bytes)
            .map_err(|_| Error::Unsupported(format!("{name}: it is not valid UTF-8")))?;
        out.push(parse_source(&text, &name)?);
    }
    Ok(out)
}

fn run(args: &Args) -> Result<()> {
    let platform = HostPlatform::new(None);
    let sources = read_sources(&platform, &args.sources)?;
    let token = std::env::var("GITHUB_TOKEN")
        .ok()
        .filter(|token| !token.is_empty());
    let github = Github::new(&platform, token);
    let generated = jiff::Timestamp::now().to_string();
    let built = build(&github, &sources, &generated)?;

    for note in &built.notes {
        eprintln!("{note}");
    }
    let index = serde_json::to_string_pretty(&built.index)
        .map_err(|err| Error::Unsupported(format!("the index could not be written: {err}")))?;
    platform.fs().mkdir(&args.out.join("v1"))?;
    platform.fs().write(
        &args.out.join("v1").join("index.json"),
        format!("{index}\n").as_bytes(),
    )?;
    Ok(())
}

fn main() -> ExitCode {
    let args = match args() {
        Ok(args) => args,
        Err(usage) => {
            eprintln!("{usage}");
            return ExitCode::from(2);
        }
    };
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("zax-indexer: {err}");
            ExitCode::FAILURE
        }
    }
}
