// The Electron main process' counterpart: it owns the window and registers one command per entry in
// the backend surface. Nothing domain-shaped lives here.

use std::process::ExitCode;

fn main() -> ExitCode {
    match zax_shell::run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            // There is no window to report through at this point, so stderr is the only channel.
            eprintln!("zax: {err}");
            ExitCode::FAILURE
        }
    }
}
