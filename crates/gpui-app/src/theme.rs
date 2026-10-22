//! The Svelte interface's palette (`packages/ui/src/app.css`), copied value for value so the two can be compared
//! side by side, and pushed into GPUI Kit's theme so its controls draw in the same colours as the page around
//! them.

use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::{App, Global, Hsla, WindowAppearance, rgb};
use zax_core::install::Theme as Choice;

/// One arm of the CSS's `light-dark()` pairs.
#[derive(Debug, Clone, Copy)]
pub struct Palette {
    pub bg: Hsla,
    pub panel: Hsla,
    pub panel_alt: Hsla,
    pub band: Hsla,
    pub border: Hsla,
    pub border_strong: Hsla,
    pub text: Hsla,
    pub text_dim: Hsla,
    pub text_faint: Hsla,
    pub accent: Hsla,
    pub accent_soft: Hsla,
    pub modified: Hsla,
    pub modified_soft: Hsla,
    pub invalid: Hsla,
}

impl Global for Palette {}

fn hex(value: u32) -> Hsla {
    rgb(value).into()
}

impl Palette {
    pub fn light() -> Self {
        Self {
            bg: hex(0xf6f7f9),
            panel: hex(0xffffff),
            panel_alt: hex(0xfbfbfd),
            band: hex(0xd9e0e9),
            border: hex(0xdfe3e8),
            border_strong: hex(0xc6ccd4),
            text: hex(0x1c2127),
            text_dim: hex(0x5c6773),
            text_faint: hex(0x8b95a1),
            accent: hex(0x2f6fb5),
            accent_soft: hex(0xe7f0fa),
            modified: hex(0xb26a00),
            modified_soft: hex(0xfdf3e3),
            invalid: hex(0xc0392b),
        }
    }

    pub fn dark() -> Self {
        Self {
            bg: hex(0x16191d),
            panel: hex(0x1d2126),
            panel_alt: hex(0x21262c),
            band: hex(0x2f3843),
            border: hex(0x2e343c),
            border_strong: hex(0x3d454f),
            text: hex(0xe4e8ed),
            text_dim: hex(0xa3adb9),
            text_faint: hex(0x78828e),
            accent: hex(0x6fa8e0),
            accent_soft: hex(0x22303e),
            modified: hex(0xe0a458),
            modified_soft: hex(0x33291a),
            invalid: hex(0xff8a7a),
        }
    }

    pub fn global(cx: &App) -> &Self {
        cx.global::<Self>()
    }
}

/// Picks the arm the saved choice asks for, following the window's appearance under "system", and points GPUI
/// Kit's colour slots at it. Called again whenever the appearance changes.
pub fn apply(choice: Choice, appearance: WindowAppearance, cx: &mut App) {
    let dark = match choice {
        Choice::Light => false,
        Choice::Dark => true,
        Choice::System => matches!(
            appearance,
            WindowAppearance::Dark | WindowAppearance::VibrantDark
        ),
    };
    let mode = if dark {
        ThemeMode::Dark
    } else {
        ThemeMode::Light
    };
    // Resets every slot to the kit's own theme for the mode first, so a slot not set below still matches it.
    Theme::change(mode, None, cx);
    let palette = if dark {
        Palette::dark()
    } else {
        Palette::light()
    };
    // Through `update`, not `global_mut`: the controls paint from the theme's tokens, which only an `update`
    // brings in line with edited colours.
    Theme::update(cx, |theme| recolour(theme, &palette));
    cx.set_global(palette);
}

fn recolour(theme: &mut Theme, palette: &Palette) {
    theme.font_size = gpui_kit::px(14.);
    theme.radius = gpui_kit::px(6.);
    let colors = &mut theme.colors;
    colors.background = palette.bg;
    colors.foreground = palette.text;
    colors.border = palette.border_strong;
    colors.input = palette.border_strong;
    colors.ring = palette.accent;
    colors.caret = palette.accent;
    colors.selection = palette.accent.opacity(0.25);
    colors.muted = palette.panel_alt;
    colors.muted_foreground = palette.text_faint;
    colors.primary = palette.accent;
    colors.primary_hover = palette.accent.opacity(0.9);
    colors.primary_active = palette.accent.opacity(0.8);
    colors.primary_foreground = palette.panel;
    colors.button_primary = palette.accent;
    colors.button_primary_hover = palette.accent.opacity(0.9);
    colors.button_primary_active = palette.accent.opacity(0.8);
    colors.button_primary_foreground = palette.panel;
    colors.secondary = palette.panel;
    colors.secondary_hover = palette.panel_alt;
    colors.secondary_active = palette.band;
    colors.secondary_foreground = palette.text;
    colors.accent = palette.accent_soft;
    colors.accent_foreground = palette.text;
    colors.popover = palette.panel;
    colors.popover_foreground = palette.text;
    colors.switch = palette.border_strong;
    colors.switch_thumb = palette.panel;
    colors.slider_bar = palette.accent;
    colors.slider_thumb = palette.accent;
    colors.link = palette.accent;
    colors.link_hover = palette.accent;
    colors.link_active = palette.accent;
    colors.scrollbar_thumb = palette.border_strong;
    colors.scrollbar_thumb_hover = palette.text_faint;
}
