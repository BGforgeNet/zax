//! One layout file's tabs as setting pages: a tab is a page, a frame a group, a setting an item whose control
//! follows its catalog kind. Widgets (the resolution presets and the like) are named, not drawn.

use std::collections::BTreeMap;

use gpui_kit::component::setting::{
    NumberFieldOptions, SettingField, SettingGroup, SettingItem, SettingPage,
};
use gpui_kit::{App, SharedString, Window};
use zax_core::catalog::{SettingDef, SettingKind};
use zax_fallout2::backend::SettingValue;
use zax_fallout2::layout::{LayoutNode, layout};

use crate::state::Zax;

/// The game's own config file, the layout group this spike draws.
pub const GAME_FILE: &str = "fallout2.cfg";

pub fn pages(file: &str, _: &mut Window, _: &App) -> Vec<SettingPage> {
    let defs: BTreeMap<&str, &SettingDef> = zax_fallout2::catalog::settings()
        .iter()
        .map(|def| (def.id.as_str(), def))
        .collect();
    let Some(group) = layout().iter().find(|one| one.id == file) else {
        return Vec::new();
    };
    group
        .tabs
        .iter()
        .map(|tab| {
            let mut groups = Vec::new();
            collect(&tab.items, "", &defs, &mut groups);
            SettingPage::new(tab.title.clone())
                .default_open(true)
                .groups(groups)
        })
        .collect()
}

/// Settings directly under a tab or frame make one group; each nested frame its own, titled by its path.
fn collect(
    nodes: &[LayoutNode],
    title: &str,
    defs: &BTreeMap<&str, &SettingDef>,
    groups: &mut Vec<SettingGroup>,
) {
    let mut items = Vec::new();
    let mut nested = Vec::new();
    for node in nodes {
        match node {
            LayoutNode::Setting { id, hidden, .. } => {
                if *hidden {
                    continue;
                }
                if let Some(def) = defs.get(id.as_str()) {
                    items.push(item(def));
                }
            }
            LayoutNode::Frame {
                title: inner,
                items: children,
            } => nested.push((inner, children)),
            LayoutNode::Widget { id } => items.push(SettingItem::new(
                SharedString::from(id.clone()),
                SettingField::render(|_, _, _| "(not drawn in this spike)"),
            )),
        }
    }
    if !items.is_empty() {
        let group = SettingGroup::new().items(items);
        groups.push(if title.is_empty() {
            group
        } else {
            group.title(title.to_owned())
        });
    }
    for (inner, children) in nested {
        let path = if title.is_empty() {
            inner.clone()
        } else {
            format!("{title} - {inner}")
        };
        collect(children, &path, defs, groups);
    }
}

fn item(def: &SettingDef) -> SettingItem {
    let label = SharedString::from(def.label.clone());
    let item = match &def.kind {
        SettingKind::Bool {
            on_value,
            off_value,
        } => {
            let (get_id, set_id) = (def.id.clone(), def.id.clone());
            let on = on_value.clone();
            let (set_on, set_off) = (on_value.clone(), off_value.clone());
            SettingItem::new(
                label,
                SettingField::switch(
                    move |cx: &App| Zax::value(cx, &get_id) == on,
                    move |checked: bool, cx: &mut App| {
                        let to = if checked { &set_on } else { &set_off };
                        Zax::set(cx, &set_id, SettingValue::Raw(to.clone()));
                    },
                ),
            )
        }
        SettingKind::Choice { options } => {
            let (get_id, set_id) = (def.id.clone(), def.id.clone());
            let choices = options
                .iter()
                .map(|option| {
                    (
                        SharedString::from(option.value.clone()),
                        SharedString::from(option.label.clone()),
                    )
                })
                .collect();
            SettingItem::new(
                label,
                SettingField::scrollable_dropdown(
                    choices,
                    move |cx: &App| Zax::value(cx, &get_id).into(),
                    move |value: SharedString, cx: &mut App| {
                        Zax::set(cx, &set_id, SettingValue::Raw(value.to_string()));
                    },
                ),
            )
        }
        SettingKind::Int(numeric) | SettingKind::Float(numeric) => {
            let integer = matches!(def.kind, SettingKind::Int(_));
            let (get_id, set_id) = (def.id.clone(), def.id.clone());
            let options = NumberFieldOptions {
                min: numeric.min.unwrap_or(f64::MIN),
                max: numeric.max.unwrap_or(f64::MAX),
                step: if integer { 1.0 } else { 0.1 },
            };
            SettingItem::new(
                label,
                SettingField::number_input(
                    options,
                    move |cx: &App| Zax::value(cx, &get_id).trim().parse().unwrap_or(0.0),
                    move |value: f64, cx: &mut App| {
                        let raw = if integer {
                            format!("{value:.0}")
                        } else {
                            value.to_string()
                        };
                        Zax::set(cx, &set_id, SettingValue::Raw(raw));
                    },
                ),
            )
        }
        SettingKind::Scale { .. } => {
            let (get_id, set_id) = (def.id.clone(), def.id.clone());
            let options = NumberFieldOptions {
                min: 0.0,
                max: 100.0,
                step: 1.0,
            };
            SettingItem::new(
                SharedString::from(format!("{} (%)", def.label)),
                SettingField::number_input(
                    options,
                    move |cx: &App| Zax::percent(cx, &get_id),
                    move |value: f64, cx: &mut App| {
                        Zax::set(cx, &set_id, SettingValue::Percent(value));
                    },
                ),
            )
        }
        SettingKind::Text { .. } | SettingKind::Key => {
            let (get_id, set_id) = (def.id.clone(), def.id.clone());
            SettingItem::new(
                label,
                SettingField::input(
                    move |cx: &App| Zax::value(cx, &get_id).into(),
                    move |value: SharedString, cx: &mut App| {
                        Zax::set(cx, &set_id, SettingValue::Raw(value.to_string()));
                    },
                ),
            )
        }
    };
    match &def.help {
        Some(help) => item.description(help.clone()),
        None => item,
    }
}
