//! One tab of a layout file as rows: three tracks (label, control, notes) on hairline separators, a group
//! heading set off by weight and space above it, and an amber edge on a changed row.

use std::collections::BTreeMap;

use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, App, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, div, px,
};
use zax_core::catalog::SettingDef;
use zax_fallout2::layout::{Control, LayoutNode};

use crate::control;
use crate::state::Zax;
use crate::theme::Palette;

const LABEL: f32 = 240.;
/// The slot the Svelte row reserves for its linked-setting marker, kept so labels start at the same x.
const MARK: f32 = 18.;
const INDENT: f32 = 16.;

/// Everything the rows of one tab share.
pub struct Page<'a> {
    pub group: &'a str,
    pub gutter: f32,
    pub defs: &'a BTreeMap<&'a str, &'a SettingDef>,
}

impl Page<'_> {
    /// The rows and headings of `nodes`, flattened: a frame is its heading followed by its own rows.
    pub fn render(
        &self,
        nodes: &[LayoutNode],
        window: &mut Window,
        cx: &mut App,
    ) -> Vec<AnyElement> {
        let mut out = Vec::new();
        self.walk(nodes, None, &mut out, window, cx);
        out
    }

    /// `depth` is `None` outside any frame, so ungrouped rows sit flush.
    fn walk(
        &self,
        nodes: &[LayoutNode],
        depth: Option<usize>,
        out: &mut Vec<AnyElement>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let indent = depth.map_or(0., |depth| INDENT * (depth as f32 + 1.));
        for node in nodes {
            match node {
                LayoutNode::Frame { title, items } => {
                    let inner = depth.map_or(0, |depth| depth + 1);
                    out.push(self.heading(title, inner, cx));
                    self.walk(items, Some(inner), out, window, cx);
                }
                LayoutNode::Setting {
                    id,
                    control,
                    hidden,
                } => {
                    let Some(def) = self.defs.get(id.as_str()) else {
                        continue;
                    };
                    // A pinned setting counts as a pending change, so it shows even where the layout hides it.
                    if *hidden && def.managed.is_none() {
                        continue;
                    }
                    out.push(self.row(def, *control, indent, window, cx));
                }
                LayoutNode::Widget { id } => {
                    let palette = Palette::global(cx);
                    out.push(
                        div()
                            .px(px(self.gutter))
                            .pl(px(self.gutter + indent + MARK))
                            .py(px(6.))
                            .border_b_1()
                            .border_color(palette.border)
                            .text_size(px(12.))
                            .italic()
                            .text_color(palette.text_faint)
                            .child(format!("{id}: not drawn in this spike"))
                            .into_any_element(),
                    );
                }
            }
        }
    }

    fn heading(&self, title: &str, depth: usize, cx: &App) -> AnyElement {
        let palette = Palette::global(cx);
        let nested = depth > 0;
        // Set off by space and weight rather than a filled band, so the rows stay the loudest thing on the page.
        div()
            .pt(px(if nested { 14. } else { 22. }))
            .pb(px(6.))
            .pr(px(self.gutter))
            .pl(px(self.gutter + INDENT * depth as f32 + MARK))
            .border_b_1()
            .border_color(palette.border_strong)
            .font_weight(FontWeight::SEMIBOLD)
            .when(nested, |this| {
                this.text_size(px(12.5)).text_color(palette.text_dim)
            })
            .when(!nested, |this| {
                this.text_size(px(14.)).text_color(palette.text)
            })
            .child(title.to_owned())
            .into_any_element()
    }

    fn row(
        &self,
        def: &SettingDef,
        control: Control,
        indent: f32,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let zax = Zax::global(cx);
        let row = zax.row(&def.id).cloned();
        let address = row
            .as_ref()
            .and_then(|row| row.groups.get(self.group))
            .cloned();
        let modified = row.as_ref().is_some_and(|row| row.modified);
        let gate = address
            .as_ref()
            .and_then(|address| address.gate.clone())
            .filter(|gate| !gate.active);
        let unavailable = !address.as_ref().is_some_and(|address| address.has_file);
        let palette = *Palette::global(cx);

        let field = match &def.managed {
            Some(managed) => div()
                .italic()
                .text_color(palette.text_faint)
                .child(
                    row.as_ref()
                        .and_then(|row| row.pinned.clone())
                        .unwrap_or_else(|| managed.value.clone()),
                )
                .into_any_element(),
            None => control::render(def, control, unavailable || gate.is_some(), window, cx),
        };

        let mut notes: Vec<(SharedString, gpui_kit::Hsla, bool)> = Vec::new();
        if let Some(help) = &def.help {
            notes.push((help.clone().into(), palette.text_dim, false));
        }
        if let Some(managed) = &def.managed {
            notes.push((managed.reason.clone().into(), palette.text_faint, false));
        }
        if let Some(gate) = &gate {
            notes.push((
                format!("needs {} = {}", gate.controller_label, gate.wants).into(),
                palette.modified,
                false,
            ));
        }
        if let Some(conflict) = row.as_ref().and_then(|row| row.conflict.as_ref()) {
            notes.push((
                format!("clashes with {}: {}", conflict.other_label, conflict.note).into(),
                palette.modified,
                false,
            ));
        }
        if row.as_ref().is_some_and(|row| row.absent) && !modified {
            notes.push((
                "not in your config - the game uses its default".into(),
                palette.text_faint,
                false,
            ));
        }
        if let Some(sentinel) = row.as_ref().and_then(|row| row.sentinel.clone()) {
            notes.push((sentinel.into(), palette.text_faint, true));
        }
        if let Some(invalid) = row.as_ref().and_then(|row| row.invalid.clone()) {
            notes.push((invalid.into(), palette.invalid, false));
        }

        let id = def.id.clone();
        h_flex()
            .id(SharedString::from(format!("row-{}", def.id)))
            .items_center()
            .gap(px(16.))
            .relative()
            .min_h(px(36.))
            .py(px(6.))
            .px(px(self.gutter))
            .border_b_1()
            .border_color(palette.border)
            .hover(|this| this.bg(palette.panel_alt))
            .when(modified, |this| {
                // The changed-row edge, a strip over the left edge so it never shifts the tracks.
                this.bg(palette.modified_soft).child(
                    div()
                        .absolute()
                        .left_0()
                        .top_0()
                        .bottom_0()
                        .w(px(2.))
                        .bg(palette.modified),
                )
            })
            .child(
                div()
                    .flex_none()
                    .w(px(LABEL))
                    .pl(px(indent + MARK))
                    .when(gate.is_some(), |this| this.opacity(0.55))
                    .child(def.label.clone()),
            )
            .child(
                div()
                    .flex_none()
                    .w(px(control::WIDTH))
                    .when(gate.is_some() || unavailable, |this| this.opacity(0.55))
                    .child(field),
            )
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .text_size(px(12.))
                    .gap(px(1.))
                    .children(notes.into_iter().map(|(text, color, italic)| {
                        div()
                            .text_color(color)
                            .when(italic, |this| this.italic())
                            .child(text)
                    })),
            )
            .child(h_flex().flex_none().when(modified, |this| {
                this.child(
                    div()
                        .id(SharedString::from(format!("revert-{id}")))
                        .text_size(px(11.5))
                        .text_color(palette.accent)
                        .underline()
                        .cursor_pointer()
                        .child("revert")
                        .on_click(move |_, _, cx| Zax::revert(cx, Some(&id))),
                )
            }))
            .into_any_element()
    }
}
