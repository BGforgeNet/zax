//! Starting programs, and asking about ones already running.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::Result;

/// Who this process is: the machine's name and ZAX's own id on it. What a claim on a directory
/// writes down to say who holds it, and the only way a later run can tell its own machine's ids -
/// the only ones it can ask about - from another's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub host: String,
    pub pid: u32,
}

#[derive(Default)]
pub struct LaunchOptions<'a> {
    pub cwd: Option<PathBuf>,
    /// Added to the inherited environment rather than replacing it, so a Wine prefix does not cost
    /// the user PATH.
    pub env: BTreeMap<String, String>,
    /// A file to send both output streams to, replacing what is there. Only [`ProcessLauncher::launch`]
    /// honours it: a program ZAX waits for answers with its output, while one that outlives ZAX
    /// would otherwise write to a console the desktop build does not have.
    pub log: Option<PathBuf>,
    /// Called once the program has started, with the process id the system gave it. What it is for
    /// is outliving ZAX: an installer's id written into a lock is what a later run reads to tell an
    /// install still in progress from one whose ZAX died half way. Not a return value, because
    /// `run` answers only once the program has exited, which is exactly the window this is about.
    pub on_start: Option<&'a (dyn Fn(u32) + Send + Sync)>,
}

impl std::fmt::Debug for LaunchOptions<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LaunchOptions")
            .field("cwd", &self.cwd)
            .field("env", &self.env)
            .field("log", &self.log)
            .field("on_start", &self.on_start.map(|_| "<callback>"))
            .finish()
    }
}

/// What a program that ran to completion left behind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunOutcome {
    /// Its exit code, or `None` when a signal killed it rather than it exiting.
    pub code: Option<i32>,
    /// What it wrote, both streams interleaved as they arrived, and the tail where there was too
    /// much of it: a failing installer says why at the end, and the beginning of its log is the
    /// part nobody needs.
    pub output: String,
}

pub trait ProcessLauncher: Send + Sync {
    fn identity(&self) -> &ProcessIdentity;

    /// Starts a program and returns once it has started, not once it has exited: the game outlives
    /// the click that launched it, and a manager that blocks until the user quits Fallout is not a
    /// manager.
    fn launch(&self, program: &Path, args: &[String], options: &LaunchOptions<'_>) -> Result<()>;

    /// Starts a program and returns once it has EXITED, with its code and its output - the opposite
    /// of `launch` and for the opposite case: an installer's whole result is what it did and what
    /// it said about it. A program that could not be started at all fails; a program that ran and
    /// failed answers with its code, which is a result rather than an error.
    fn run(
        &self,
        program: &Path,
        args: &[String],
        options: &LaunchOptions<'_>,
    ) -> Result<RunOutcome>;

    /// Hands a file or directory to the desktop's own handler.
    fn open(&self, target: &Path) -> Result<()>;

    /// Whether a process id is one this machine is still running. Answers a lock left behind by a
    /// run that never finished. False where the host cannot tell, which reads as "not running" and
    /// so lets a lock be broken - the safe direction for a check whose other answer strands the
    /// user.
    ///
    /// The id may have been handed to something else since, so a true answer means "possibly still
    /// running" rather than "certainly". Both callers refuse on true, the direction that cannot
    /// corrupt.
    fn alive(&self, pid: u32) -> Result<bool>;

    /// The command line a running id was started with, or `None` where the host cannot say. What it
    /// settles is reuse: an id that is alive may be alive as something else entirely, since the
    /// system hands numbers out again.
    ///
    /// `None` is "cannot say" rather than "not the one you meant", so a caller may only act on a
    /// positive disagreement. Reading it costs a process on most hosts, so ask only once something
    /// already answered `alive`.
    fn command_of(&self, pid: u32) -> Result<Option<String>>;
}
