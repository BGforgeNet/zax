//! Child processes on a real machine, and the two questions a lock asks about one that is not ours.

use std::io::Read as _;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use zax_platform::process::{LaunchOptions, ProcessIdentity, ProcessLauncher, RunOutcome};
use zax_platform::{Error, OperatingSystem, Result};

/// How much of a run's output is kept. An Inno log runs to tens of kilobytes; a bomb of one is not
/// evidence.
const RUN_OUTPUT_CAP: usize = 64 * 1024;

/// How often a wait looks again at a program it is timing out. Short enough that a wedged `reg` costs
/// no perceptible part of its five seconds, long enough not to spin.
const POLL: Duration = Duration::from_millis(20);

fn failed(operation: &'static str, program: &Path, source: std::io::Error) -> Error {
    Error::Io {
        operation,
        path: program.to_string_lossy().into_owned(),
        source,
    }
}

/// The desktop's own way of handing a path to whatever handles it - the file manager, the default
/// editor.
///
/// Windows goes to `explorer` rather than through `cmd /c start`: the latter hands the target to two
/// more parsers, cmd's and start's, each with its own metacharacters, and the target can be a URL that
/// arrived over the network. `explorer` takes it as one argument and opens it with whatever handles it,
/// the same as start did.
const fn open_program(os: OperatingSystem) -> &'static str {
    match os {
        OperatingSystem::Windows => "explorer.exe",
        OperatingSystem::MacOs => "open",
        OperatingSystem::Linux => "xdg-open",
    }
}

/// The tail, because the end of an installer's log is where it says what went wrong.
fn capped(mut output: String) -> String {
    if output.len() <= RUN_OUTPUT_CAP {
        return output;
    }
    // On a character boundary, so what is kept is still text.
    let mut cut = output.len() - RUN_OUTPUT_CAP;
    while cut < output.len() && !output.is_char_boundary(cut) {
        cut += 1;
    }
    output.drain(..cut);
    output
}

/// Runs a command to completion, with a deadline where one is asked for.
///
/// A program that ran and failed answers with its code, which is a result rather than an error; one
/// that could not be started at all, or that outlived its deadline, fails.
///
/// # Errors
///
/// Fails where the program could not be started, where its output could not be read, or where it was
/// still running when the deadline passed.
pub fn run_with_timeout(
    mut command: Command,
    program: &Path,
    deadline: Option<Duration>,
) -> Result<RunOutcome> {
    // Both streams into one pipe, interleaved as they arrived: a failing installer says why at the end
    // and the two halves of that sentence are often on different streams.
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|err| failed("run", program, err))?;
    let outcome = wait_capturing(&mut child, program, deadline);
    if outcome.is_err() {
        // A deadline that passed leaves a program running; nothing downstream is waiting for it.
        let _ = child.kill();
    }
    outcome
}

fn wait_capturing(
    child: &mut Child,
    program: &Path,
    deadline: Option<Duration>,
) -> Result<RunOutcome> {
    // Read on their own threads: a program that fills one pipe while this waits on the other would
    // block for ever, and an installer's log is large enough to do it.
    let mut streams = Vec::new();
    for stream in [
        child.stdout.take().map(StreamOf::Out),
        child.stderr.take().map(StreamOf::Err),
    ]
    .into_iter()
    .flatten()
    {
        streams.push(std::thread::spawn(move || stream.read_to_string()));
    }

    let started = Instant::now();
    let status = loop {
        match child
            .try_wait()
            .map_err(|err| failed("run", program, err))?
        {
            Some(status) => break status,
            None => {
                if deadline.is_some_and(|held| started.elapsed() > held) {
                    return Err(Error::Unsupported(format!(
                        "{} did not finish in time.",
                        program.display()
                    )));
                }
                std::thread::sleep(POLL);
            }
        }
    };

    let mut output = String::new();
    for stream in streams {
        // A reader thread that panicked leaves what it had unread, which is a poorer account of the
        // run rather than a failure of it.
        if let Ok(text) = stream.join() {
            output.push_str(&text);
        }
    }
    Ok(RunOutcome {
        code: status.code(),
        output: capped(output),
    })
}

/// One of the child's two streams, so a reader thread can own it.
enum StreamOf {
    Out(std::process::ChildStdout),
    Err(std::process::ChildStderr),
}

impl StreamOf {
    /// What the stream held, as text. Invalid bytes become replacement characters: this is an account
    /// of what a program said, and a mangled character in it is better than losing the sentence.
    fn read_to_string(self) -> String {
        let mut bytes = Vec::new();
        let read = match self {
            Self::Out(mut held) => held.read_to_end(&mut bytes),
            Self::Err(mut held) => held.read_to_end(&mut bytes),
        };
        if read.is_err() {
            return String::new();
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

#[derive(Debug)]
pub struct HostProcess {
    os: OperatingSystem,
    identity: ProcessIdentity,
}

impl HostProcess {
    #[must_use]
    pub fn new(os: OperatingSystem) -> Self {
        Self {
            os,
            identity: ProcessIdentity {
                host: hostname(),
                pid: std::process::id(),
            },
        }
    }

    /// A command with the caller's working directory and environment applied. The environment is added
    /// to the inherited one rather than replacing it, so a Wine prefix does not cost the user PATH.
    fn command(&self, program: &Path, args: &[String], options: &LaunchOptions<'_>) -> Command {
        let mut command = Command::new(program);
        command.args(args);
        if let Some(cwd) = &options.cwd {
            command.current_dir(cwd);
        }
        for (name, value) in &options.env {
            command.env(name, value);
        }
        command
    }
}

/// What this machine calls itself, or `unknown` where it will not say. A lock names the host so a
/// network share's lock from another machine is not read as this one's; a host with no name still
/// carries a process id, which is what the same-machine case turns on.
fn hostname() -> String {
    // `HOSTNAME` is set by most shells and `COMPUTERNAME` by Windows; a host offering neither is one
    // whose name nothing here can read without asking the system for it.
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .ok()
        .filter(|held| !held.trim().is_empty())
        .unwrap_or_else(|| "unknown".to_owned())
}

impl ProcessLauncher for HostProcess {
    fn identity(&self) -> &ProcessIdentity {
        &self.identity
    }

    fn launch(&self, program: &Path, args: &[String], options: &LaunchOptions<'_>) -> Result<()> {
        let mut command = self.command(program, args, options);
        command.stdin(Stdio::null());
        // A folder ZAX cannot write to is not a reason to refuse to start the game, so a log that will
        // not open is dropped rather than raised - the launch is what the user asked for.
        let log = options.log.as_ref().and_then(|at| {
            at.parent().map(std::fs::create_dir_all);
            std::fs::File::create(at).ok()
        });
        match log {
            Some(file) => {
                // The child holds its own copy of the descriptor, so this one closing here leaves it
                // writing.
                let second = file
                    .try_clone()
                    .map_err(|err| failed("launch", program, err))?;
                command
                    .stdout(Stdio::from(file))
                    .stderr(Stdio::from(second));
            }
            None => {
                // Handles closed: the game outlives this process, and a manager holding the game's
                // stdout open would keep it alive after the user quits ZAX.
                command.stdout(Stdio::null()).stderr(Stdio::null());
            }
        }
        let child = command
            .spawn()
            .map_err(|err| failed("launch", program, err))?;
        if let Some(on_start) = options.on_start {
            on_start(child.id());
        }
        // Not waited on: the game outlives the click that launched it. Dropping the handle leaves the
        // child running, which is the whole point.
        drop(child);
        Ok(())
    }

    fn run(
        &self,
        program: &Path,
        args: &[String],
        options: &LaunchOptions<'_>,
    ) -> Result<RunOutcome> {
        let mut command = self.command(program, args, options);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|err| failed("run", program, err))?;
        // On the id the system actually gave it, which a spawn that failed has none of.
        if let Some(on_start) = options.on_start {
            on_start(child.id());
        }
        let outcome = wait_capturing(&mut child, program, None);
        if outcome.is_err() {
            let _ = child.kill();
        }
        outcome
    }

    fn open(&self, target: &Path) -> Result<()> {
        let program = open_program(self.os);
        Command::new(program)
            .arg(target)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|err| failed("open", Path::new(program), err))
    }

    fn alive(&self, pid: u32) -> Result<bool> {
        Ok(is_alive(pid))
    }

    /// Linux answers from `/proc`, which costs a file read rather than a process. Everything else is
    /// asked through a program: `ps` on the Unixes that have no `/proc`, and PowerShell on Windows,
    /// where the command line is not on the filesystem at all. Any failure - no such process, no `ps`,
    /// a host that will not say - is nothing, which the callers read as "cannot tell" rather than as a
    /// mismatch.
    fn command_of(&self, pid: u32) -> Result<Option<String>> {
        if pid == 0 {
            return Ok(None);
        }
        if self.os == OperatingSystem::Linux
            && let Ok(raw) = std::fs::read(format!("/proc/{pid}/cmdline"))
        {
            // NUL-separated, and trailing: the separators become spaces and the last one is dropped.
            let held = String::from_utf8_lossy(&raw).replace('\0', " ");
            let held = held.trim();
            return Ok((!held.is_empty()).then(|| held.to_owned()));
        }
        let mut command = match self.os {
            OperatingSystem::Windows => {
                let mut held = Command::new("powershell.exe");
                held.args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    &format!(
                        "(Get-CimInstance Win32_Process -Filter \"ProcessId={pid}\").CommandLine"
                    ),
                ]);
                held
            }
            OperatingSystem::Linux | OperatingSystem::MacOs => {
                let mut held = Command::new("ps");
                held.args(["-p", &pid.to_string(), "-o", "command="]);
                held
            }
        };
        command.env_remove("LD_PRELOAD");
        let Ok(outcome) = run_with_timeout(command, Path::new("ps"), Some(REGISTRY_LIKE_TIMEOUT))
        else {
            return Ok(None);
        };
        if outcome.code != Some(0) {
            return Ok(None);
        }
        let held = outcome.output.trim();
        Ok((!held.is_empty()).then(|| held.to_owned()))
    }
}

/// The same bound `reg` gets, for the same reason: a host that will not answer must not hold the caller.
const REGISTRY_LIKE_TIMEOUT: Duration = Duration::from_secs(5);

/// Signal 0 delivers nothing and only asks whether the id could be signalled. No such process is nobody
/// there; a permission failure is somebody there this account does not own, which is still somebody.
/// Anything else is unclear, and unclear reads as gone so a lock cannot outlive the machine that made
/// it.
#[cfg(unix)]
fn is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // `/proc` where there is one, which costs no signal at all and no unsafe call.
    if cfg!(target_os = "linux") {
        return std::path::Path::new(&format!("/proc/{pid}")).exists();
    }
    // Elsewhere, ask the same way the process listing does. `kill -0` is the shape, and `ps` is what
    // answers it without reaching for libc.
    let mut command = Command::new("ps");
    command.args(["-p", &pid.to_string(), "-o", "pid="]);
    run_with_timeout(command, Path::new("ps"), Some(REGISTRY_LIKE_TIMEOUT))
        .is_ok_and(|outcome| outcome.code == Some(0) && !outcome.output.trim().is_empty())
}

#[cfg(not(unix))]
fn is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let mut command = Command::new("tasklist");
    command.args(["/FI", &format!("PID eq {pid}"), "/NH"]);
    // `tasklist` exits zero whether or not it matched, so its output is what says: a filter matching
    // nothing prints a sentence rather than a row, and neither carries the id.
    run_with_timeout(command, Path::new("tasklist"), Some(REGISTRY_LIKE_TIMEOUT))
        .is_ok_and(|outcome| outcome.output.contains(&pid.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> HostProcess {
        HostProcess::new(if cfg!(windows) {
            OperatingSystem::Windows
        } else if cfg!(target_os = "macos") {
            OperatingSystem::MacOs
        } else {
            OperatingSystem::Linux
        })
    }

    fn options<'a>() -> LaunchOptions<'a> {
        LaunchOptions::default()
    }

    #[test]
    fn this_process_names_itself() {
        let held = host();
        assert_eq!(held.identity().pid, std::process::id());
        assert!(!held.identity().host.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_program_that_ran_answers_with_its_code_and_what_it_said() {
        let outcome = host()
            .run(
                Path::new("/bin/sh"),
                &[
                    "-c".to_owned(),
                    "echo out; echo err 1>&2; exit 3".to_owned(),
                ],
                &options(),
            )
            .expect("a program that ran");
        assert_eq!(outcome.code, Some(3));
        assert!(outcome.output.contains("out"), "{outcome:?}");
        assert!(outcome.output.contains("err"), "{outcome:?}");
    }

    #[cfg(unix)]
    #[test]
    fn a_program_that_could_not_be_started_at_all_fails() {
        // Which is a different thing from one that ran and failed.
        let err = host()
            .run(Path::new("/nowhere/no-such-program"), &[], &options())
            .expect_err("nothing to start");
        assert!(matches!(err, Error::Io { .. }), "{err:?}");
    }

    #[cfg(unix)]
    #[test]
    fn a_program_filling_one_pipe_does_not_wedge_the_wait() {
        // Read on their own threads, or a program writing more than a pipe holds would block for ever.
        let outcome = host()
            .run(
                Path::new("/bin/sh"),
                &[
                    "-c".to_owned(),
                    "i=0; while [ $i -lt 2000 ]; do echo 0123456789012345678901234567890123456789; \
                     i=$((i+1)); done"
                        .to_owned(),
                ],
                &options(),
            )
            .expect("a program that ran");
        assert_eq!(outcome.code, Some(0));
        assert!(outcome.output.len() > 64_000, "{}", outcome.output.len());
    }

    #[cfg(unix)]
    #[test]
    fn what_a_program_said_is_capped_at_its_tail() {
        // A bomb of a log is not evidence, and the end is where an installer says what went wrong.
        let outcome = host()
            .run(
                Path::new("/bin/sh"),
                &[
                    "-c".to_owned(),
                    "i=0; while [ $i -lt 4000 ]; do echo \
                     0123456789012345678901234567890123456789; i=$((i+1)); done; echo THEEND"
                        .to_owned(),
                ],
                &options(),
            )
            .expect("a program that ran");
        assert!(
            outcome.output.len() <= RUN_OUTPUT_CAP,
            "{}",
            outcome.output.len()
        );
        assert!(
            outcome.output.ends_with("THEEND\n"),
            "the tail is what is kept"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_id_a_program_was_given_is_reported_as_it_starts() {
        let seen = std::sync::Mutex::new(Vec::new());
        let note = |pid: u32| {
            seen.lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(pid);
        };
        host()
            .run(
                Path::new("/bin/sh"),
                &["-c".to_owned(), "exit 0".to_owned()],
                &LaunchOptions {
                    on_start: Some(&note),
                    ..LaunchOptions::default()
                },
            )
            .expect("a program that ran");
        let held = seen
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        assert_eq!(held.len(), 1);
        assert!(held[0] > 0);
    }

    #[cfg(unix)]
    #[test]
    fn a_program_past_its_deadline_is_stopped_rather_than_waited_for() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 30"]);
        let err = run_with_timeout(
            command,
            Path::new("/bin/sh"),
            Some(Duration::from_millis(100)),
        )
        .expect_err("a program that outlived its deadline");
        assert!(format!("{err}").contains("did not finish in time"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn a_launched_program_is_not_waited_for() {
        // The game outlives the click that launched it.
        let started = Instant::now();
        host()
            .launch(
                Path::new("/bin/sh"),
                &["-c".to_owned(), "sleep 5".to_owned()],
                &options(),
            )
            .expect("a launch");
        assert!(started.elapsed() < Duration::from_secs(2), "it waited");
    }

    #[cfg(unix)]
    #[test]
    fn a_launched_program_writes_to_the_log_it_was_given() {
        let at = std::env::temp_dir().join("zax-host-launch.log");
        let _ = std::fs::remove_file(&at);
        host()
            .launch(
                Path::new("/bin/sh"),
                &["-c".to_owned(), "echo said".to_owned()],
                &LaunchOptions {
                    log: Some(at.clone()),
                    ..LaunchOptions::default()
                },
            )
            .expect("a launch");
        // The child is not waited for, so the line arrives shortly after the launch answered.
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if std::fs::read(&at).is_ok_and(|held| held.starts_with(b"said")) {
                std::fs::remove_file(&at).expect("the log the test made");
                return;
            }
            std::thread::sleep(POLL);
        }
        panic!("the log never carried what the program printed");
    }

    #[test]
    fn this_process_is_one_this_machine_is_running() {
        assert!(host().alive(std::process::id()).expect("a read"));
    }

    #[test]
    fn nothing_is_running_under_the_id_no_process_has() {
        // Zero is never a process, which is what makes it the one id safe to ask about.
        assert!(!host().alive(0).expect("a read"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn this_process_says_what_it_was_started_with() {
        let held = host()
            .command_of(std::process::id())
            .expect("a read")
            .expect("this process has a command line");
        assert!(!held.is_empty());
    }

    #[test]
    fn an_id_no_process_has_says_nothing_rather_than_guessing() {
        assert_eq!(host().command_of(0).expect("a read"), None);
    }

    #[test]
    fn a_cap_keeps_what_is_still_text() {
        let held = capped(format!(
            "{}\u{4e2d}{}",
            "a".repeat(RUN_OUTPUT_CAP),
            "b".repeat(8)
        ));
        assert!(held.len() <= RUN_OUTPUT_CAP);
        assert!(held.ends_with("bbbbbbbb"));
    }
}
