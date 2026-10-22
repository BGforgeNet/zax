//! One tab of a layout file as rows, laid out the way `packages/ui/src/app.css` lays out `.list .row` and
//! `.frame`: three fixed tracks (label, control, notes), zebra striping that restarts in every group, banded
//! group headings, and an amber edge on a changed row.

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

const LABEL: f32 = 304.;
const NOTES: f32 = 352.;
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
        let mut stripe = 0;
        for node in nodes {
            match node {
                LayoutNode::Frame { title, items } => {
                    let inner = depth.map_or(0, |depth| depth + 1);
                    out.push(self.heading(title, inner, cx));
                    self.walk(items, Some(inner), out, window, cx);
                    // A heading breaks the run, so the stripes after it start over.
                    stripe = 0;
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
                    out.push(self.row(def, *control, indent, stripe % 2 == 1, window, cx));
                    stripe += 1;
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
        div()
            .relative()
            .py(px(9.))
            .pr(px(self.gutter))
            .pl(px(self.gutter + INDENT * depth as f32))
            .border_t_1()
            .border_b_1()
            .when(nested, |this| {
                this.border_color(palette.border)
                    .bg(palette.band.opacity(0.6))
                    .text_size(px(12.))
            })
            .when(!nested, |this| {
                this.border_color(palette.border_strong)
                    .bg(palette.band)
                    .text_size(px(13.))
            })
            // The accent bar: GPUI has one border colour per element, so it is a strip over the left edge.
            .child(
                div()
                    .absolute()
                    .left_0()
                    .top_0()
                    .bottom_0()
                    .w(px(3.))
                    .bg(if nested {
                        palette.accent.opacity(0.45)
                    } else {
                        palette.accent
                    }),
            )
            .font_weight(FontWeight::BOLD)
            .text_color(palette.text)
            .child(title.to_uppercase())
            .into_any_element()
    }

    fn row(
        &self,
        def: &SettingDef,
        control: Control,
        indent: f32,
        even: bool,
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
            .when(even, |this| this.bg(palette.band.opacity(0.4)))
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
                    .flex_none()
                    .w(px(NOTES))
                    .text_size(px(12.))
                    .gap(px(1.))
                    .children(notes.into_iter().map(|(text, color, italic)| {
                        div()
                            .text_color(color)
                            .when(italic, |this| this.italic())
                            .child(text)
                    })),
            )
            .child(h_flex().flex_1().justify_end().when(modified, |this| {
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
