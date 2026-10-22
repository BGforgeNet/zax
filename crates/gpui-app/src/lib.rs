//! Spike: ZAX's settings drawn natively with GPUI Kit, over the same backend the Tauri shell calls.
//!
//! One layout file's tabs (the game's `fallout2.cfg`), built from the generated catalog and layout, edited
//! through `Backend::set_settings` and written through `Backend::save`. Nothing here is shared with the Svelte
//! interface; it answers whether the native route is worth taking, not how it would be laid out.

mod shell;
pub mod state;
mod tab;

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::setting::Settings;
use gpui_kit::component::{ActiveTheme as _, h_flex, v_flex};
use gpui_kit::{Context, IntoElement, ParentElement as _, Render, Styled as _, Window};

use crate::state::Zax;

#[derive(Debug, Default)]
pub struct ZaxWindow;

impl Render for ZaxWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let zax = Zax::global(cx);
        let modified = zax.modified();
        let title = format!("ZAX - {}", zax.path());
        let status = zax.status().clone();
        v_flex()
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(
                h_flex()
                    .p_2()
                    .gap_3()
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .child(title)
                    .child(format!("{modified} unsaved"))
                    .child(status)
                    .child(
                        Button::new("save")
                            .primary()
                            .label("Save")
                            .on_click(|_, _, cx| Zax::save(cx)),
                    ),
            )
            .child(Settings::new("zax-settings").pages(tab::pages(tab::GAME_FILE, window, cx)))
    }
}
