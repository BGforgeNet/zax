use std::path::{Path, PathBuf};

use gpui_kit::{AppContext as _, WindowOptions};
use zax_gpui::ZaxWindow;
use zax_gpui::state::Zax;

/// The real config files from `fixtures/f2up`, so a copy started with no folder opens something.
const DEMO_FILES: &[(&str, &[u8])] = &[
    (
        "fallout2.cfg",
        include_bytes!("../../../fixtures/f2up/fallout2.cfg"),
    ),
    (
        "f2_res.ini",
        include_bytes!("../../../fixtures/f2up/f2_res.ini"),
    ),
    (
        "ddraw.ini",
        include_bytes!("../../../fixtures/f2up/ddraw.ini"),
    ),
];

/// A game folder under the temp directory holding the fixtures and an executable stub. Files already there are
/// kept, so edits saved in one run show in the next.
fn demo_game() -> std::io::Result<PathBuf> {
    let dir = std::env::temp_dir().join("zax-gpui-demo");
    std::fs::create_dir_all(dir.join("data"))?;
    for (name, bytes) in DEMO_FILES {
        let path = dir.join(name);
        if !path.exists() {
            std::fs::write(path, bytes)?;
        }
    }
    let exe = dir.join("fallout2.exe");
    if !exe.exists() {
        std::fs::write(exe, b"MZ")?;
    }
    Ok(dir)
}

fn fail(message: &str) -> ! {
    eprintln!("zax-gpui: {message}");
    std::process::exit(1);
}

fn main() {
    let path = match std::env::args().nth(1) {
        Some(path) => path,
        None => {
            let dir = demo_game().unwrap_or_else(|err| fail(&format!("no demo folder: {err}")));
            if std::env::var_os("ZAX_DATA_DIR").is_none() {
                // SAFETY: the first thing main does, before anything starts a second thread. It keeps the demo's
                // install list out of the per-user ZAX config a real copy reads.
                unsafe { std::env::set_var("ZAX_DATA_DIR", dir.join("data")) };
            }
            path_string(&dir)
        }
    };
    let zax = Zax::open(&path).unwrap_or_else(|err| fail(&err.to_string()));
    gpui_kit::application().run(move |cx| {
        gpui_kit::init(cx);
        cx.set_global(zax);
        if let Err(err) =
            gpui_kit::open_window(WindowOptions::default(), cx, |_, cx| cx.new(|_| ZaxWindow))
        {
            eprintln!("zax-gpui: no window: {err}");
            cx.quit();
        }
    });
}

fn path_string(dir: &Path) -> String {
    dir.to_str()
        .unwrap_or_else(|| fail("the temp directory's path is not UTF-8"))
        .to_owned()
}
