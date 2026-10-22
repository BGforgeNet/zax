//! Spike: ZAX's settings drawn natively with GPUI Kit, over the same backend the Tauri shell calls.
//!
//! The game's own three config files, each a strip of tabs built from the generated catalog and layout, edited
//! through `Backend::set_settings` and written through `Backend::save`. The window copies the Svelte
//! interface's shell, palette and row layout, so the two can be judged side by side; GPUI Kit supplies only the
//! controls inside a row.

mod control;
mod page;
mod shell;
pub mod state;
pub mod theme;

use std::collections::BTreeMap;
use std::sync::Arc;

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::{ActiveTheme as _, Disableable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, App, Context, FontWeight, Image, ImageFormat, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, StatefulInteractiveElement as _, Styled as _,
    Subscription, Window, div, img, px,
};
use zax_core::catalog::SettingDef;
use zax_core::install::{GameType, Install};
use zax_fallout2::layout::{LayoutFile, layout};

use crate::page::Page;
use crate::state::Zax;
use crate::theme::Palette;

const SIDEBAR: f32 = 264.;
/// The settings column at its widest: the row's three tracks, their gaps, the revert link's room and the inset.
const COLUMN: f32 = 1000.;
const GUTTER: f32 = 16.;

pub struct ZaxWindow {
    /// The open group of tabs, by its layout id.
    file: String,
    /// The open tab of each group, so switching groups and back keeps your place.
    tab: BTreeMap<String, String>,
    _appearance: Subscription,
}

impl std::fmt::Debug for ZaxWindow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ZaxWindow")
            .field("file", &self.file)
            .field("tab", &self.tab)
            .finish_non_exhaustive()
    }
}

impl ZaxWindow {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        theme::apply(Zax::global(cx).view().theme, window.appearance(), cx);
        let _appearance = cx.observe_window_appearance(window, |_, window, cx| {
            theme::apply(Zax::global(cx).view().theme, window.appearance(), cx);
        });
        Self {
            file: files()
                .first()
                .map(|file| file.id.clone())
                .unwrap_or_default(),
            tab: BTreeMap::new(),
            _appearance,
        }
    }
}

/// The game's own three, which every install has; an engine's tabs need that engine and are left out here.
fn files() -> Vec<&'static LayoutFile> {
    layout()
        .iter()
        .filter(|file| file.engine.is_none())
        .collect()
}

fn icon(game: GameType) -> Arc<Image> {
    let bytes: &[u8] = match game {
        GameType::Fallout2 => include_bytes!("../../../packages/ui/src/assets/fallout2.png"),
        GameType::Fallout2Up | GameType::Fallout2Upu => {
            include_bytes!("../../../packages/ui/src/assets/fallout2upu.png")
        }
        GameType::Fallout2Rp | GameType::Fallout2Rpu => {
            include_bytes!("../../../packages/ui/src/assets/fallout2rpu.png")
        }
        GameType::Fo1In2 => include_bytes!("../../../packages/ui/src/assets/fo1in2.png"),
    };
    Arc::new(Image::from_bytes(ImageFormat::Png, bytes.to_vec()))
}

/// A tab of the shared strip: selection changes colour and border only, never a metric, so no tab shifts.
fn tab(
    id: impl Into<SharedString>,
    selected: bool,
    palette: &Palette,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    h_flex()
        .id(id.into())
        .gap(px(6.))
        .px(px(13.))
        .pt(px(7.))
        .pb(px(8.))
        .mb(px(-1.))
        .rounded_t(px(6.))
        .border_1()
        .border_b_0()
        .cursor_pointer()
        .map(|this| {
            if selected {
                this.bg(palette.bg)
                    .border_color(palette.border)
                    .text_color(palette.text)
            } else {
                this.border_color(gpui_kit::transparent_black())
                    .text_color(palette.text_dim)
                    .hover(|this| this.bg(palette.panel_alt))
            }
        })
}

fn strip(palette: &Palette, inset: f32) -> gpui_kit::Div {
    h_flex()
        .flex_none()
        .gap(px(2.))
        .pt(px(6.))
        .px(px(inset))
        .bg(palette.panel)
        .border_b_1()
        .border_color(palette.border)
}

impl ZaxWindow {
    fn sidebar(palette: &Palette, cx: &App) -> AnyElement {
        let view = Zax::global(cx).view();
        let installs: Vec<Install> = view.installs.clone();
        let selected = view.selected.clone();
        // The kit's resolved monospace family: a generic "monospace" name is not one GPUI's text system maps.
        let mono = cx.theme().mono_font_family.clone();
        v_flex()
            .flex_none()
            .w(px(SIDEBAR))
            .h_full()
            .bg(palette.panel_alt)
            .border_l_1()
            .border_r_1()
            .border_color(palette.border)
            .child(
                strip(palette, 8.).child(
                    tab("games", true, palette).child("Games").child(
                        div()
                            .text_size(px(11.5))
                            .text_color(palette.text_faint)
                            .child(installs.len().to_string()),
                    ),
                ),
            )
            .child(
                v_flex()
                    .p(px(8.))
                    .gap(px(4.))
                    .children(installs.into_iter().map(|install| {
                        let current = install.path == selected;
                        let name = install
                            .alias
                            .clone()
                            .unwrap_or_else(|| install.game_type.name().to_owned());
                        h_flex()
                            .gap(px(10.))
                            .p(px(8.))
                            .rounded(px(6.))
                            .border_1()
                            .map(|this| {
                                if current {
                                    this.bg(palette.accent_soft).border_color(palette.accent)
                                } else {
                                    this.border_color(gpui_kit::transparent_black())
                                }
                            })
                            .child(img(icon(install.game_type)).flex_none().size(px(32.)))
                            .child(
                                v_flex()
                                    .flex_1()
                                    .min_w_0()
                                    .child(
                                        h_flex()
                                            .justify_between()
                                            .gap(px(6.))
                                            .child(
                                                div()
                                                    .font_weight(FontWeight::BOLD)
                                                    .text_size(px(13.))
                                                    .child(name),
                                            )
                                            .child(
                                                div()
                                                    .px(px(4.))
                                                    .rounded(px(3.))
                                                    .border_1()
                                                    .border_color(palette.border_strong)
                                                    .text_size(px(11.))
                                                    .text_color(palette.text_dim)
                                                    .font_family(mono.clone())
                                                    .child(install.game_type.badge()),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(11.5))
                                            .text_color(palette.text_faint)
                                            .font_family(mono.clone())
                                            .truncate()
                                            .child(install.path.clone()),
                                    ),
                            )
                    })),
            )
            .into_any_element()
    }

    fn save_bar(palette: &Palette, cx: &App) -> AnyElement {
        let zax = Zax::global(cx);
        let modified = zax.modified();
        let status = zax.status().clone();
        h_flex()
            .flex_none()
            .gap(px(10.))
            .px(px(GUTTER))
            .py(px(10.))
            .bg(palette.panel)
            .border_t_1()
            .border_color(palette.border)
            .child(
                div()
                    .flex_1()
                    .text_size(px(12.5))
                    .text_color(palette.text_dim)
                    .child(status),
            )
            .child(div().text_size(px(12.5)).map(|this| {
                if modified == 0 {
                    this.text_color(palette.text_faint)
                        .child("No unsaved changes")
                } else {
                    let noun = if modified == 1 { "change" } else { "changes" };
                    this.text_color(palette.modified)
                        .child(format!("{modified} unsaved {noun}"))
                }
            }))
            .child(
                Button::new("revert-all")
                    .label("Revert all")
                    .outline()
                    .disabled(modified == 0)
                    .on_click(|_, _, cx| Zax::revert(cx, None)),
            )
            .child(
                Button::new("save")
                    .label("Save")
                    .primary()
                    .disabled(modified == 0)
                    .on_click(|_, _, cx| Zax::save(cx)),
            )
            .into_any_element()
    }
}

impl Render for ZaxWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = *Palette::global(cx);
        let files = files();
        let Some(file) = files
            .iter()
            .find(|file| file.id == self.file)
            .or(files.first())
            .copied()
        else {
            return div().child("The layout has no files.").into_any_element();
        };
        let open = self
            .tab
            .get(&file.id)
            .cloned()
            .or_else(|| file.tabs.first().map(|tab| tab.title.clone()));
        let items = file
            .tabs
            .iter()
            .find(|tab| Some(&tab.title) == open.as_ref())
            .map(|tab| tab.items.clone());

        let defs: BTreeMap<&str, &SettingDef> = zax_fallout2::catalog::settings()
            .iter()
            .map(|def| (def.id.as_str(), def))
            .collect();
        let page = Page {
            group: &file.id,
            gutter: GUTTER,
            defs: &defs,
        };
        let rows = items
            .map(|items| page.render(&items, window, cx))
            .unwrap_or_default();

        let groups = strip(&palette, GUTTER).children(files.iter().map(|one| {
            let id = one.id.clone();
            let unsaved = Zax::global(cx).modified_in(&one.id) > 0;
            tab(
                SharedString::from(format!("file-{}", one.id)),
                one.id == file.id,
                &palette,
            )
            .child(one.label.clone())
            // Always laid out, only its ink toggles, so the strip never shifts on an edit.
            .child(
                div()
                    .size(px(6.))
                    .rounded_full()
                    .when(unsaved, |this| this.bg(palette.modified)),
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                this.file = id.clone();
                cx.notify();
            }))
        }));

        let subtabs = h_flex()
            .flex_none()
            .gap(px(14.))
            .px(px(GUTTER))
            .bg(palette.bg)
            .border_b_1()
            .border_color(palette.border)
            .children(file.tabs.iter().map(|one| {
                let selected = Some(&one.title) == open.as_ref();
                let (group, title) = (file.id.clone(), one.title.clone());
                div()
                    .id(SharedString::from(format!("tab-{}-{}", file.id, one.title)))
                    .pt(px(7.))
                    .pb(px(6.))
                    .px(px(1.))
                    .text_size(px(12.5))
                    .border_b_2()
                    .cursor_pointer()
                    .map(|this| {
                        if selected {
                            this.text_color(palette.accent).border_color(palette.accent)
                        } else {
                            this.text_color(palette.text_faint)
                                .border_color(gpui_kit::transparent_black())
                                .hover(|this| this.text_color(palette.text_dim))
                        }
                    })
                    .child(one.title.clone())
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.tab.insert(group.clone(), title.clone());
                        cx.notify();
                    }))
            }));

        let column = v_flex()
            .flex_1()
            .min_w_0()
            .max_w(px(COLUMN))
            .h_full()
            .bg(palette.bg)
            .border_r_1()
            .border_color(palette.border)
            .child(
                strip(&palette, GUTTER)
                    .justify_between()
                    .child(tab("settings", true, &palette).child("Settings"))
                    .child(
                        div()
                            .pb(px(6.))
                            .text_size(px(12.))
                            .text_color(palette.text_faint)
                            .child("GPUI Kit spike"),
                    ),
            )
            .child(groups)
            .child(subtabs)
            .child(
                div()
                    .id(SharedString::from(format!(
                        "list-{}-{}",
                        file.id,
                        open.unwrap_or_default()
                    )))
                    .flex_1()
                    .min_h_0()
                    .child(v_flex().children(rows))
                    .overflow_y_scrollbar(),
            )
            .child(Self::save_bar(&palette, cx));

        h_flex()
            .size_full()
            .justify_center()
            .bg(palette.bg)
            .text_color(palette.text)
            .text_size(px(14.))
            .child(Self::sidebar(&palette, cx))
            .child(column)
            .into_any_element()
    }
}
