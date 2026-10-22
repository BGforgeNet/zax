//! The native window over a real install's files: every tab of `fallout2.cfg` lays out headlessly, and an edit
//! through it saves as exactly one changed line. Run with `ZAX_DATA_DIR` naming a scratch directory, so the
//! backend's own state stays out of the user's config.

use std::fs;
use std::path::PathBuf;

use gpui_kit::component::Root;
use gpui_kit::{AppContext as _, TestAppContext};
use zax_fallout2::backend::SettingValue;
use zax_gpui::ZaxWindow;
use zax_gpui::state::Zax;

/// A game folder holding the real config files from `fixtures/f2up`, and an executable stub so it reads as one.
/// Removed on drop, so a failed assertion does not leave it behind.
struct Game(PathBuf);

impl Drop for Game {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn game() -> Game {
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/f2up");
    let dir = std::env::temp_dir().join(format!("zax-gpui-game-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap_or_else(|err| panic!("creating {}: {err}", dir.display()));
    for name in ["fallout2.cfg", "f2_res.ini", "ddraw.ini"] {
        fs::copy(fixtures.join(name), dir.join(name))
            .unwrap_or_else(|err| panic!("copying {name}: {err}"));
    }
    fs::write(dir.join("fallout2.exe"), b"MZ")
        .unwrap_or_else(|err| panic!("writing the executable stub: {err}"));
    Game(dir)
}

#[gpui_kit::test]
fn an_edit_through_the_window_saves_as_one_line(cx: &mut TestAppContext) {
    let game = game();
    let dir = &game.0;
    let before = fs::read_to_string(dir.join("fallout2.cfg")).expect("the copy reads");
    let zax = Zax::open(dir.to_str().expect("a UTF-8 scratch path")).expect("the install opens");
    cx.update(|cx| {
        gpui_kit::init(cx);
        cx.set_global(zax);
    });
    let (_root, cx) = cx.add_window_view(|window, cx| {
        let view = cx.new(|_| ZaxWindow);
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

    let after = fs::read_to_string(dir.join("fallout2.cfg")).expect("the saved file reads");
    let changed: Vec<(&str, &str)> = before
        .lines()
        .zip(after.lines())
        .filter(|(old, new)| old != new)
        .collect();
    assert_eq!(changed, vec![("running=0", "running=1")]);
    assert_eq!(before.lines().count(), after.lines().count());
}
