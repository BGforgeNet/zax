//! Fetching text and downloading files, on a connection that may be slow, lossy, or not there at all.
//!
//! The naive form - request, read whole, write - fails four ways that all reach the user as the word
//! "failed", so each is named here instead. A cap on the whole transfer kills a slow link that is still
//! making progress, so the deadline measures silence rather than duration. The body is streamed to a
//! partial file rather than held whole in memory, which is also what makes resuming possible. A body
//! that stops short of its declared length is a failure, not a truncated file the caller has to think
//! to check. And an attempt that died mid-transfer resumes where it stopped, because spending minutes
//! of a poor connection and then starting again from nothing is how a download never finishes at all.
//!
//! Hand-written although download crates with resume and retry exist: the failure taxonomy here -
//! offline against timeout against incomplete against status, each with its own wording - is the point,
//! and mapping a crate's error surface back onto it would cost more than the mechanics being replaced.

use std::fs;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Duration;

use zax_platform::net::{DownloadOptions, DownloadProgress, Network, NetworkError, NetworkFailure};
use zax_platform::{Error, Result};

/// How long the transfer may produce nothing before it is abandoned. Deliberately not a limit on the
/// whole download: 880 KB of sfall over a weak link legitimately takes minutes, and a total budget
/// makes that indistinguishable from a dead mirror.
const IDLE_TIMEOUT: Duration = Duration::from_secs(20);

/// How long to wait for the response head. A server silent this long is not going to answer.
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);

/// Attempts in total, not retries after the first.
const ATTEMPTS: u32 = 3;

const BACKOFF: &[Duration] = &[Duration::from_millis(500), Duration::from_secs(2)];

/// Statuses worth trying again: the server is up but cannot answer this moment.
const RETRYABLE_STATUS: &[u16] = &[408, 425, 429, 500, 502, 503, 504];

/// 64 KiB, the same as the hash reads: the read is not what a download costs.
const CHUNK: usize = 64 * 1024;

/// How patient to be. A value rather than fixed constants because it is the policy this implements, and
/// the stall and retry paths cannot be exercised in a test at production patience - a suite that waits
/// twenty seconds to prove a timeout works is a suite nobody runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DownloadPolicy {
    pub idle_timeout: Duration,
    pub response_timeout: Duration,
    pub attempts: u32,
    pub backoff: &'static [Duration],
}

impl Default for DownloadPolicy {
    fn default() -> Self {
        Self {
            idle_timeout: IDLE_TIMEOUT,
            response_timeout: RESPONSE_TIMEOUT,
            attempts: ATTEMPTS,
            backoff: BACKOFF,
        }
    }
}

/// One line's worth of what an attempt did, for the log a bug report carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttemptNote {
    pub url: String,
    pub attempt: u32,
    pub received: u64,
    pub total: Option<u64>,
    pub millis: u128,
    pub outcome: String,
    pub resumed_from: u64,
}

fn host_of(url: &str) -> String {
    // Not a URL at all is a caller's bug rather than the network's - say what was asked for.
    url::Url::parse(url).map_or_else(
        |_| url.to_owned(),
        |parsed| parsed.host_str().unwrap_or(url).to_owned(),
    )
}

/// The sentence the user reads. Written here because the kind does not survive the channel to the
/// interface.
fn human_reason(kind: NetworkFailure, url: &str, detail: &str) -> String {
    let host = host_of(url);
    match kind {
        NetworkFailure::Offline => {
            format!("{host} could not be reached - check the network connection.")
        }
        NetworkFailure::Timeout => {
            format!("{host} stopped responding part way through the download.")
        }
        NetworkFailure::Incomplete => {
            format!("{host} closed the connection before the file was complete.")
        }
        NetworkFailure::Status => format!("{host} answered with {detail}."),
    }
}

fn network(kind: NetworkFailure, url: &str, detail: &str, status: Option<u16>) -> Error {
    Error::Network(NetworkError {
        kind,
        url: url.to_owned(),
        message: human_reason(kind, url, detail),
        status,
    })
}

/// Whether the transport never reached the host at all, as opposed to reaching it and losing it part
/// way. Telling a user to check their network connection when the mirror actually dropped a connection
/// mid-file sends them looking in the wrong place.
#[expect(
    clippy::wildcard_enum_match_arm,
    reason = "the transport's error enum is the library's and grows with it; everything this does \
              not name is a request that reached the host, which is the other answer"
)]
fn unreachable(err: &ureq::Error) -> bool {
    match err {
        ureq::Error::Io(held) => matches!(
            held.kind(),
            std::io::ErrorKind::ConnectionRefused
                | std::io::ErrorKind::HostUnreachable
                | std::io::ErrorKind::NetworkUnreachable
                | std::io::ErrorKind::NotConnected
        ),
        // A name that does not resolve, and a connection to a host that is not there.
        ureq::Error::HostNotFound | ureq::Error::ConnectionFailed => true,
        _ => false,
    }
}

fn timed_out(err: &ureq::Error) -> bool {
    matches!(err, ureq::Error::Timeout(_))
        || matches!(err, ureq::Error::Io(held) if held.kind() == std::io::ErrorKind::TimedOut)
}

fn failed(operation: &'static str, path: &Path, source: std::io::Error) -> Error {
    Error::Io {
        operation,
        path: path.to_string_lossy().into_owned(),
        source,
    }
}

/// Bytes already in the partial file, which is where a resumed attempt starts.
fn partial_size(path: &Path) -> u64 {
    fs::metadata(path).map(|held| held.len()).unwrap_or(0)
}

/// Removes the bytes and the source record together, so neither can give meaning to the other after a
/// failure.
fn discard_partial(partial: &Path, identity: &Path) {
    let _ = fs::remove_file(partial);
    let _ = fs::remove_file(identity);
}

/// Keeps a partial only when it belongs to this request. A destination is routinely reused for another
/// release, and a byte count alone cannot say that its prefix came from the URL now asking to append to
/// it.
fn prepare_partial(partial: &Path, identity: &Path, url: &str) -> Result<()> {
    // A missing or interrupted record grants no identity to the bytes beside it.
    let same_source = fs::read_to_string(identity).is_ok_and(|held| held == identity_line(url));
    if !same_source {
        discard_partial(partial, identity);
    }
    fs::write(identity, identity_line(url)).map_err(|err| failed("write", identity, err))
}

/// What the record beside a partial says. Versioned, so a record this version cannot read grants the
/// bytes nothing.
fn identity_line(url: &str) -> String {
    format!("1\n{url}\n")
}

/// How far one attempt got.
struct Got {
    received: u64,
    total: Option<u64>,
}

/// One attempt, answering once the body has been written whole. `from` is where to resume; whether that
/// is honoured is the server's decision, and the answer says which.
#[expect(
    clippy::too_many_lines,
    reason = "one transfer in the order it happens - request, head, body, length check - where the \
              failure taxonomy is the point and each arm names the kind it produces"
)]
fn attempt(
    agent: &ureq::Agent,
    url: &str,
    partial: &Path,
    from: u64,
    options: &DownloadOptions<'_>,
    policy: DownloadPolicy,
) -> Result<Got> {
    let cancelled = || {
        options
            .cancel
            .is_some_and(|held| held.load(Ordering::SeqCst))
    };
    if cancelled() {
        return Err(Error::Cancelled);
    }

    let mut request = agent.get(url);
    // A resumed attempt asks for the rest; a first attempt sends no range, so a mirror that mishandles
    // one is never given the chance.
    if from > 0 {
        request = request.header("Range", &format!("bytes={from}-"));
    }
    let response = match request.call() {
        Ok(response) => response,
        Err(err) => {
            if cancelled() {
                return Err(Error::Cancelled);
            }
            // A status the server did answer with arrives as a response, however unwelcome; what
            // reaches here is a request that got none.
            let kind = if timed_out(&err) {
                NetworkFailure::Timeout
            } else if unreachable(&err) {
                NetworkFailure::Offline
            } else {
                NetworkFailure::Incomplete
            };
            return Err(network(kind, url, "", None));
        }
    };

    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let detail = format!(
            "{status} {}",
            response.status().canonical_reason().unwrap_or("")
        );
        return Err(network(
            NetworkFailure::Status,
            url,
            detail.trim(),
            Some(status),
        ));
    }

    // A server is free to ignore `Range` and answer 200 with the whole file; appending to the partial
    // then would splice two copies together.
    let resuming = from > 0 && status == 206;
    let start_at = if resuming { from } else { 0 };
    let remaining: Option<u64> = response
        .headers()
        .get("content-length")
        .and_then(|held| held.to_str().ok())
        .and_then(|held| held.parse().ok());
    let total = remaining.map(|held| start_at + held);

    let mut received = start_at;
    if let Some(on_progress) = options.on_progress {
        on_progress(DownloadProgress { received, total });
    }

    let mut sink = fs::OpenOptions::new()
        .create(true)
        .append(resuming)
        .write(true)
        .truncate(!resuming)
        .open(partial)
        .map_err(|err| failed("write", partial, err))?;
    let mut body = response.into_body().into_reader();
    let mut buffer = vec![0u8; CHUNK];
    let mut last_progress = std::time::Instant::now();
    loop {
        // Armed before the request and rearmed on every chunk, so the deadline measures silence rather
        // than length. Checked per chunk rather than enforced by the transport, which has no notion of
        // a body that is merely slow.
        if last_progress.elapsed() > policy.idle_timeout {
            // Flushed rather than dropped: what is buffered is exactly what the next attempt resumes
            // from, and losing it silently turns resume back into starting over.
            let _ = sink.flush();
            return Err(network(NetworkFailure::Timeout, url, "", None));
        }
        if cancelled() {
            let _ = sink.flush();
            return Err(Error::Cancelled);
        }
        let read = match body.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(err) => {
                let _ = sink.flush();
                if cancelled() {
                    return Err(Error::Cancelled);
                }
                // A connection dropped mid-body and one that went quiet are both "the file did not
                // arrive"; the only distinction worth drawing is which the log should say.
                let kind = if err.kind() == std::io::ErrorKind::TimedOut {
                    NetworkFailure::Timeout
                } else {
                    NetworkFailure::Incomplete
                };
                return Err(network(kind, url, "", None));
            }
        };
        sink.write_all(&buffer[..read])
            .map_err(|err| failed("write", partial, err))?;
        received += read as u64;
        last_progress = std::time::Instant::now();
        if let Some(on_progress) = options.on_progress {
            on_progress(DownloadProgress { received, total });
        }
    }
    sink.flush().map_err(|err| failed("write", partial, err))?;
    drop(sink);

    // The check a buffered version never makes: a chunked body that ends early is indistinguishable
    // from a complete one unless the declared length is compared against what turned up.
    if let Some(total) = total
        && received != total
    {
        return Err(Error::Network(NetworkError {
            kind: NetworkFailure::Incomplete,
            url: url.to_owned(),
            message: format!(
                "{} Got {received} of {total} bytes.",
                human_reason(NetworkFailure::Incomplete, url, "")
            ),
            status: None,
        }));
    }
    Ok(Got { received, total })
}

/// Where a download's per-attempt line goes. A failed or resumed transfer is the one thing a bug report
/// cannot reconstruct from the interface, so the caller passes a sink for it.
pub type AttemptSink = Box<dyn Fn(&AttemptNote) + Send + Sync>;

pub struct HostNetwork {
    agent: ureq::Agent,
    policy: DownloadPolicy,
    note: Option<AttemptSink>,
}

impl std::fmt::Debug for HostNetwork {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostNetwork")
            .field("policy", &self.policy)
            .field("note", &self.note.as_ref().map(|_| "<callback>"))
            .finish()
    }
}

impl Default for HostNetwork {
    fn default() -> Self {
        Self::new(DownloadPolicy::default(), None)
    }
}

impl HostNetwork {
    #[must_use]
    pub fn new(policy: DownloadPolicy, note: Option<AttemptSink>) -> Self {
        let config = ureq::Agent::config_builder()
            .timeout_connect(Some(policy.response_timeout))
            // Not a limit on the whole transfer: that would fail a slow link that is still making
            // progress, which is what the per-chunk silence check exists to tell apart.
            .timeout_recv_response(Some(policy.response_timeout))
            .build();
        Self {
            agent: config.into(),
            policy,
            note,
        }
    }

    fn noted(&self, note: &AttemptNote) {
        if let Some(sink) = &self.note {
            sink(note);
        }
    }
}

impl Network for HostNetwork {
    fn fetch_text(&self, url: &str) -> Result<String> {
        let response = match self.agent.get(url).call() {
            Ok(response) => response,
            Err(err) => {
                let kind = if timed_out(&err) {
                    NetworkFailure::Timeout
                } else {
                    NetworkFailure::Offline
                };
                // A feed that went quiet says something different from one that was never reached, and
                // the download's own wording is about a transfer rather than a request.
                let message = if kind == NetworkFailure::Timeout {
                    format!("{} did not answer in time.", host_of(url))
                } else {
                    human_reason(NetworkFailure::Offline, url, "")
                };
                return Err(Error::Network(NetworkError {
                    kind,
                    url: url.to_owned(),
                    message,
                    status: None,
                }));
            }
        };
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            let detail = format!(
                "{status} {}",
                response.status().canonical_reason().unwrap_or("")
            );
            return Err(network(
                NetworkFailure::Status,
                url,
                detail.trim(),
                Some(status),
            ));
        }
        response
            .into_body()
            .read_to_string()
            .map_err(|_| network(NetworkFailure::Incomplete, url, "", None))
    }

    /// The destination appears only once the whole body is there, so no reader can catch a half-written
    /// file and a crash part way leaves a partial rather than something that passes for a finished
    /// download.
    fn download(&self, url: &str, destination: &Path, options: &DownloadOptions<'_>) -> Result<()> {
        if let Some(parent) = destination.parent().filter(|at| !at.as_os_str().is_empty()) {
            fs::create_dir_all(parent).map_err(|err| failed("mkdir", parent, err))?;
        }
        let mut partial = destination.as_os_str().to_owned();
        partial.push(".zax-partial");
        let partial = PathBuf::from(partial);
        let mut identity = partial.as_os_str().to_owned();
        identity.push(".source");
        let identity = PathBuf::from(identity);
        prepare_partial(&partial, &identity, url)?;

        let mut last: Option<Error> = None;
        for at in 1..=self.policy.attempts {
            let from = partial_size(&partial);
            let started = std::time::Instant::now();
            match attempt(&self.agent, url, &partial, from, options, self.policy) {
                Ok(got) => {
                    self.noted(&AttemptNote {
                        url: url.to_owned(),
                        attempt: at,
                        received: got.received,
                        total: got.total,
                        millis: started.elapsed().as_millis(),
                        outcome: "ok".to_owned(),
                        resumed_from: from,
                    });
                    fs::rename(&partial, destination)
                        .map_err(|err| failed("rename", destination, err))?;
                    let _ = fs::remove_file(&identity);
                    return Ok(());
                }
                Err(err) => {
                    // Only a network failure carries a kind and a status; a write that failed or a
                    // cancel carries neither, and neither is worth trying again.
                    let held = match &err {
                        Error::Network(held) => Some(held),
                        Error::Io { .. }
                        | Error::Archive(_)
                        | Error::Cancelled
                        | Error::Unsupported(_) => None,
                    };
                    let status = held.and_then(|held| held.status);
                    let kind = held.map(|held| held.kind);
                    let stopped = matches!(err, Error::Cancelled);
                    self.noted(&AttemptNote {
                        url: url.to_owned(),
                        attempt: at,
                        received: partial_size(&partial),
                        total: None,
                        millis: started.elapsed().as_millis(),
                        outcome: if stopped {
                            "cancelled".to_owned()
                        } else {
                            match (kind, status) {
                                (Some(kind), Some(status)) => format!("{kind:?} {status}"),
                                (Some(kind), None) => format!("{kind:?}"),
                                _ => "error".to_owned(),
                            }
                        },
                        resumed_from: from,
                    });

                    // Nothing failed, so there is nothing to retry and nothing to clear away: the bytes
                    // already fetched are what makes resuming a cancelled download cheaper than starting
                    // it over.
                    if stopped {
                        if partial_size(&partial) == 0 {
                            discard_partial(&partial, &identity);
                        }
                        return Err(err);
                    }

                    // A range the server would not satisfy means the partial is not a prefix of what is
                    // being fetched. Dropping it costs one restart; keeping it corrupts every attempt
                    // after this one.
                    if matches!(status, Some(416 | 404)) {
                        discard_partial(&partial, &identity);
                    }

                    let retryable = match kind {
                        Some(
                            NetworkFailure::Timeout
                            | NetworkFailure::Incomplete
                            | NetworkFailure::Offline,
                        ) => true,
                        Some(NetworkFailure::Status) => {
                            status.is_some_and(|held| RETRYABLE_STATUS.contains(&held))
                        }
                        None => false,
                    };
                    last = Some(err);
                    if !retryable || at == self.policy.attempts {
                        break;
                    }
                    std::thread::sleep(
                        self.policy
                            .backoff
                            .get((at - 1) as usize)
                            .copied()
                            .unwrap_or(Duration::from_secs(2)),
                    );
                }
            }
        }

        // Nothing usable is left: a stale partial would be resumed onto by a later call for a different
        // file that happens to want the same destination.
        discard_partial(&partial, &identity);
        Err(last.unwrap_or_else(|| network(NetworkFailure::Incomplete, url, "", None)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn a_host_is_read_out_of_the_address_and_falls_back_to_it() {
        assert_eq!(host_of("https://example.com/a/b"), "example.com");
        assert_eq!(host_of("not a url"), "not a url");
    }

    #[test]
    fn each_failure_says_something_different_to_the_user() {
        // One word for all four is what this taxonomy exists to avoid.
        let said = |kind| human_reason(kind, "https://example.com/x", "500 Server Error");
        let all = [
            said(NetworkFailure::Offline),
            said(NetworkFailure::Timeout),
            said(NetworkFailure::Incomplete),
            said(NetworkFailure::Status),
        ];
        let unique: std::collections::BTreeSet<&String> = all.iter().collect();
        assert_eq!(unique.len(), 4, "{all:?}");
        assert!(all[0].contains("check the network connection"), "{all:?}");
        assert!(all[3].contains("500 Server Error"), "{all:?}");
    }

    #[test]
    fn a_partial_keeps_its_bytes_only_for_the_url_that_fetched_them() {
        let at = std::env::temp_dir().join("zax-net-partial");
        let _ = fs::remove_dir_all(&at);
        fs::create_dir_all(&at).expect("a directory the test makes");
        let partial = at.join("f.zip.zax-partial");
        let identity = at.join("f.zip.zax-partial.source");
        fs::write(&partial, b"half a file").expect("a partial the test writes");

        // A destination routinely gets reused for another release.
        prepare_partial(&partial, &identity, "https://example.com/one").expect("a record");
        assert_eq!(partial_size(&partial), 0, "another url's bytes went");

        fs::write(&partial, b"half a file").expect("a partial the test writes");
        prepare_partial(&partial, &identity, "https://example.com/one").expect("a record");
        assert_eq!(partial_size(&partial), 11, "the same url's bytes stayed");
        fs::remove_dir_all(&at).expect("the directory the test made");
    }

    #[test]
    fn a_record_this_version_cannot_read_grants_the_bytes_nothing() {
        let at = std::env::temp_dir().join("zax-net-identity");
        let _ = fs::remove_dir_all(&at);
        fs::create_dir_all(&at).expect("a directory the test makes");
        let partial = at.join("f.zip.zax-partial");
        let identity = at.join("f.zip.zax-partial.source");
        fs::write(&partial, b"half a file").expect("a partial the test writes");
        fs::write(&identity, "99\nhttps://example.com/one\n").expect("a record from elsewhere");
        prepare_partial(&partial, &identity, "https://example.com/one").expect("a record");
        assert_eq!(partial_size(&partial), 0);
        fs::remove_dir_all(&at).expect("the directory the test made");
    }

    #[test]
    fn a_status_worth_trying_again_is_told_from_one_that_is_not() {
        assert!(RETRYABLE_STATUS.contains(&503));
        assert!(!RETRYABLE_STATUS.contains(&404));
        assert!(!RETRYABLE_STATUS.contains(&403));
    }

    #[test]
    fn a_download_from_a_host_that_does_not_exist_names_the_network_rather_than_the_file() {
        let at = std::env::temp_dir().join("zax-net-offline");
        let _ = fs::remove_dir_all(&at);
        let held = HostNetwork::new(
            DownloadPolicy {
                attempts: 1,
                response_timeout: Duration::from_millis(400),
                idle_timeout: Duration::from_millis(400),
                backoff: &[],
            },
            None,
        );
        let err = held
            .download(
                "https://no-such-host.invalid/file.zip",
                &at.join("file.zip"),
                &DownloadOptions::default(),
            )
            .expect_err("nothing answers");
        assert!(matches!(err, Error::Network(_)), "{err:?}");
        // And nothing usable was left where a later call for another file would resume onto it.
        assert_eq!(partial_size(&at.join("file.zip.zax-partial")), 0);
        let _ = fs::remove_dir_all(&at);
    }

    #[test]
    fn a_cancel_already_set_stops_before_a_request_is_made() {
        let at = std::env::temp_dir().join("zax-net-cancelled");
        let _ = fs::remove_dir_all(&at);
        let cancel = AtomicBool::new(true);
        let err = HostNetwork::default()
            .download(
                "https://example.com/file.zip",
                &at.join("file.zip"),
                &DownloadOptions {
                    cancel: Some(&cancel),
                    ..DownloadOptions::default()
                },
            )
            .expect_err("the caller stopped it");
        assert!(matches!(err, Error::Cancelled), "{err:?}");
        let _ = fs::remove_dir_all(&at);
    }

    #[test]
    fn fetching_text_from_a_host_that_does_not_exist_names_the_network() {
        let err = HostNetwork::new(
            DownloadPolicy {
                response_timeout: Duration::from_millis(400),
                ..DownloadPolicy::default()
            },
            None,
        )
        .fetch_text("https://no-such-host.invalid/feed.json")
        .expect_err("nothing answers");
        let Error::Network(held) = err else {
            panic!("{err:?}");
        };
        assert!(
            matches!(held.kind, NetworkFailure::Offline | NetworkFailure::Timeout),
            "{held:?}"
        );
    }
}
