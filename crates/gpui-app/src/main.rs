use gpui_kit::{AppContext as _, WindowOptions};
use zax_gpui::ZaxWindow;
use zax_gpui::state::Zax;

fn main() {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: zax-gpui <game folder>");
        std::process::exit(2);
    };
    let zax = match Zax::open(&path) {
        Ok(zax) => zax,
        Err(err) => {
            eprintln!("zax-gpui: {err}");
            std::process::exit(1);
        }
    };
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
