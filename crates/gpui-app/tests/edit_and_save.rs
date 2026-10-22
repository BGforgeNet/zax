//! The native window over a real install's files: it lays out headlessly, and an edit through it saves as
//! exactly one changed line. The backend runs on the in-memory platform, seeded with the
//! real config files from `fixtures/f2up`, so nothing touches the machine's files or config directory.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use gpui_kit::component::Root;
use gpui_kit::{AppContext as _, TestAppContext};
use zax_fallout2::backend::SettingValue;
use zax_gpui::ZaxWindow;
use zax_gpui::state::Zax;
use zax_platform::Platform;
use zax_platform::memory::{Content, MemoryOptions, MemoryPlatform};

const GAME: &str = "/games/f2";

fn fixture(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/f2up")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|err| panic!("reading {}: {err}", path.display()))
}

/// A game folder holding the fixtures and an executable stub, so it reads as an install.
fn platform() -> Arc<MemoryPlatform> {
    let mut files: BTreeMap<String, Content> = ["fallout2.cfg", "f2_res.ini", "ddraw.ini"]
        .into_iter()
        .map(|name| (format!("{GAME}/{name}"), Content::Binary(fixture(name))))
        .collect();
    files.insert(format!("{GAME}/fallout2.exe"), Content::from("MZ"));
    Arc::new(MemoryPlatform::new(MemoryOptions {
        files,
        dirs: vec![GAME.to_owned()],
        ..MemoryOptions::default()
    }))
}

/// The config file as text, one byte per character, the way the backend reads it.
fn config(platform: &MemoryPlatform) -> String {
    let path = format!("{GAME}/fallout2.cfg");
    let bytes = platform
        .fs()
        .read(Path::new(&path))
        .unwrap_or_else(|err| panic!("reading {path}: {err}"));
    bytes.iter().map(|&byte| char::from(byte)).collect()
}

#[gpui_kit::test]
fn an_edit_through_the_window_saves_as_one_line(cx: &mut TestAppContext) {
    let platform = platform();
    let before = config(&platform);
    let zax =
        Zax::open_on(Arc::clone(&platform) as Arc<dyn Platform>, GAME).expect("the install opens");
    cx.update(|cx| {
        gpui_kit::init(cx);
        cx.set_global(zax);
    });
    let (_root, cx) = cx.add_window_view(|window, cx| {
        let view = cx.new(|cx| ZaxWindow::new(window, cx));
        Root::new(view, window, cx)
    });
    cx.run_until_parked();

    cx.update(|_, cx| {
        Zax::set(
            cx,
            "game.preferences.running",
            SettingValue::Raw("1".into()),
        )
    });
    cx.update(|_, cx| assert_eq!(Zax::global(cx).modified(), 1));
    cx.update(|_, cx| Zax::save(cx));
    cx.run_until_parked();

    let after = config(&platform);
    let changed: Vec<(&str, &str)> = before
        .lines()
        .zip(after.lines())
        .filter(|(old, new)| old != new)
        .collect();
    assert_eq!(changed, vec![("running=0", "running=1")]);
    assert_eq!(before.lines().count(), after.lines().count());
}
