//! One setting's control, picked the way `packages/ui/src/lib/Control.svelte` picks it: the layout's control
//! where the catalog kind alone would choose wrong (a bounded number drawn as a slider, a short choice laid out
//! as radios), else the kind's own. Inputs keep their state per setting id, so it survives tab switches.

use gpui_kit::component::button::Button;
use gpui_kit::component::input::{Input, InputEvent, InputState, NumberInput};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::radio::{Radio, RadioGroup};
use gpui_kit::component::slider::{Slider, SliderEvent, SliderState};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{Disableable as _, Sizable as _, h_flex};
use gpui_kit::{
    Anchor, AnyElement, App, AppContext as _, Entity, IntoElement, ParentElement as _,
    SharedString, Styled as _, Subscription, Window, div, px,
};
use zax_core::catalog::{SettingDef, SettingKind};
use zax_fallout2::backend::SettingValue;
use zax_fallout2::layout::Control;

use crate::state::Zax;
use crate::theme::Palette;

/// The control track's width, the middle of the row's three.
pub const WIDTH: f32 = 256.;
const SLIDER: f32 = 150.;
const NUMBER: f32 = 128.;

pub fn render(
    def: &SettingDef,
    control: Control,
    disabled: bool,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    match &def.kind {
        SettingKind::Bool {
            on_value,
            off_value,
        } => {
            let on = Zax::value(cx, &def.id) == *on_value;
            let id = def.id.clone();
            let (on_value, off_value) = (on_value.clone(), off_value.clone());
            Switch::new(SharedString::from(format!("switch-{id}")))
                .checked(on)
                .disabled(disabled)
                .on_click(move |checked: &bool, _, cx: &mut App| {
                    let to = if *checked { &on_value } else { &off_value };
                    Zax::set(cx, &id, SettingValue::Raw(to.clone()));
                })
                .into_any_element()
        }
        SettingKind::Choice { options } if control == Control::Radio => {
            let now = Zax::value(cx, &def.id);
            let id = def.id.clone();
            let values: Vec<String> = options.iter().map(|option| option.value.clone()).collect();
            RadioGroup::horizontal(SharedString::from(format!("radio-{id}")))
                .selected_index(values.iter().position(|value| *value == now))
                .disabled(disabled)
                .children(options.iter().map(|option| {
                    Radio::new(SharedString::from(option.value.clone())).label(option.label.clone())
                }))
                .on_click(move |index: &usize, _, cx: &mut App| {
                    if let Some(value) = values.get(*index) {
                        Zax::set(cx, &id, SettingValue::Raw(value.clone()));
                    }
                })
                .into_any_element()
        }
        SettingKind::Choice { options } => {
            let now = Zax::value(cx, &def.id);
            // A value the catalog does not list is shown as itself, as the Svelte select's extra option does.
            let label = options
                .iter()
                .find(|option| option.value == now)
                .map_or_else(
                    || {
                        if now.is_empty() {
                            "(unset)".to_owned()
                        } else {
                            now.clone()
                        }
                    },
                    |option| option.label.clone(),
                );
            let id = def.id.clone();
            let choices: Vec<(String, String)> = options
                .iter()
                .map(|option| (option.value.clone(), option.label.clone()))
                .collect();
            Button::new(SharedString::from(format!("choice-{id}")))
                .label(label)
                .outline()
                .small()
                .dropdown_caret(true)
                .disabled(disabled)
                .dropdown_menu_with_anchor(Anchor::TopLeft, move |menu, _, _| {
                    let menu = choices.iter().fold(menu, |menu, (value, label)| {
                        let id = id.clone();
                        let value = value.clone();
                        menu.item(
                            PopupMenuItem::new(label.clone())
                                .checked(value == now)
                                .on_click(move |_, _, cx| {
                                    Zax::set(cx, &id, SettingValue::Raw(value.clone()));
                                }),
                        )
                    });
                    menu.scrollable(true)
                })
                .into_any_element()
        }
        SettingKind::Scale { .. } => {
            let percent = Zax::percent(cx, &def.id);
            let id = def.id.clone();
            slider(
                window,
                cx,
                &def.id,
                0.,
                100.,
                1.,
                percent,
                format!("{percent:.0}%"),
                disabled,
                move |value, cx| {
                    Zax::set(cx, &id, SettingValue::Percent(f64::from(value).round()));
                },
            )
        }
        SettingKind::Int(numeric) | SettingKind::Float(numeric) => {
            let float = matches!(def.kind, SettingKind::Float(_));
            let raw = Zax::value(cx, &def.id);
            let now = raw.trim().parse::<f64>().ok();
            let unit = numeric.unit.clone();
            if control == Control::Slider {
                let (lo, hi) = (numeric.min.unwrap_or(0.), numeric.max.unwrap_or(100.));
                let step = if float { (hi - lo) / 100. } else { 1. };
                let at = now.unwrap_or(lo);
                // Rounded for reading; the file keeps its own precision until the slider moves.
                let readout = match (now, float) {
                    (Some(value), true) => format!("{value:.2}"),
                    (Some(value), false) => format!("{value:.0}"),
                    (None, _) => raw.clone(),
                };
                let readout = unit
                    .as_ref()
                    .map_or(readout.clone(), |unit| format!("{readout} {unit}"));
                let id = def.id.clone();
                return slider(
                    window,
                    cx,
                    &def.id,
                    lo,
                    hi,
                    step,
                    at,
                    readout,
                    disabled,
                    move |value, cx| {
                        // Written back at the precision the game's own files use.
                        let raw = if float {
                            format!("{value:.6}")
                        } else {
                            format!("{:.0}", value.round())
                        };
                        Zax::set(cx, &id, SettingValue::Raw(raw));
                    },
                );
            }
            let id = def.id.clone();
            let field = number(
                window,
                cx,
                &def.id,
                now.unwrap_or(0.),
                numeric.min,
                numeric.max,
                float,
                move |value, cx| {
                    let raw = if float {
                        value.to_string()
                    } else {
                        format!("{value:.0}")
                    };
                    Zax::set(cx, &id, SettingValue::Raw(raw));
                },
            );
            let faint = Palette::global(cx).text_faint;
            h_flex()
                .gap_2()
                .child(
                    NumberInput::new(&field)
                        .small()
                        .disabled(disabled)
                        .w(px(NUMBER)),
                )
                .children(unit.map(|unit| div().text_size(px(12.)).text_color(faint).child(unit)))
                .into_any_element()
        }
        // Read-only: capturing a scancode from a keypress is the Svelte control's job and out of this spike's.
        SettingKind::Key => {
            let palette = Palette::global(cx);
            let shown = Zax::global(cx)
                .row(&def.id)
                .map(|row| row.display.clone())
                .unwrap_or_default();
            div()
                .px_2()
                .py(px(2.))
                .min_w(px(NUMBER))
                .border_1()
                .border_color(palette.border_strong)
                .rounded(px(6.))
                .bg(palette.panel)
                .text_size(px(13.))
                .child(shown)
                .into_any_element()
        }
        SettingKind::Text { .. } => {
            let id = def.id.clone();
            let field = text(window, cx, &def.id, move |value, cx| {
                Zax::set(cx, &id, SettingValue::Raw(value))
            });
            Input::new(&field)
                .small()
                .disabled(disabled)
                .w(px(WIDTH))
                .into_any_element()
        }
    }
}

struct Held<T> {
    entity: Entity<T>,
    last: String,
    _subscription: Subscription,
}

#[expect(
    clippy::too_many_arguments,
    reason = "one call site per slider shape; a builder would outweigh both"
)]
fn slider(
    window: &mut Window,
    cx: &mut App,
    id: &str,
    lo: f64,
    hi: f64,
    step: f64,
    at: f64,
    readout: String,
    disabled: bool,
    set: impl Fn(f32, &mut App) + 'static,
) -> AnyElement {
    // The slider works in f32; a game value never needs more than that to place a thumb.
    #[expect(
        clippy::cast_possible_truncation,
        reason = "a thumb position, not a stored value"
    )]
    let (lo, hi, step, at) = (lo as f32, hi as f32, step as f32, at as f32);
    let held = window.use_keyed_state(
        SharedString::from(format!("slider-{id}")),
        cx,
        move |_, cx| {
            let entity = cx.new(|_| {
                SliderState::new()
                    .min(lo)
                    .max(hi)
                    .step(step)
                    .default_value(at)
            });
            let _subscription = cx.subscribe(&entity, move |_, _, event: &SliderEvent, cx| {
                // Written while dragging, as the Svelte range input's `oninput` does; the release adds nothing.
                if let SliderEvent::Change(value) = event {
                    set(value.start(), cx);
                }
            });
            Held {
                entity,
                last: String::new(),
                _subscription,
            }
        },
    );
    // A value changed elsewhere (a revert, a save that normalised it) moves the thumb; the slider's own drag
    // already has it there.
    let shown = format!("{at}");
    held.update(cx, |held, cx| {
        if held.last != shown {
            held.last = shown;
            held.entity
                .update(cx, |state, cx| state.set_value(at, window, cx));
        }
    });
    let faint = Palette::global(cx).text_dim;
    let entity = held.read(cx).entity.clone();
    h_flex()
        .gap_3()
        .child(
            div()
                .w(px(SLIDER))
                .child(Slider::new(&entity).disabled(disabled)),
        )
        .child(div().text_size(px(13.)).text_color(faint).child(readout))
        .into_any_element()
}

#[expect(
    clippy::too_many_arguments,
    reason = "mirrors GPUI Kit's own number field; one call site"
)]
fn number(
    window: &mut Window,
    cx: &mut App,
    id: &str,
    at: f64,
    min: Option<f64>,
    max: Option<f64>,
    float: bool,
    set: impl Fn(f64, &mut App) + 'static,
) -> Entity<InputState> {
    let (min, max) = (min.unwrap_or(f64::MIN), max.unwrap_or(f64::MAX));
    let step = if float { 0.1 } else { 1. };
    let held = window.use_keyed_state(
        SharedString::from(format!("number-{id}")),
        cx,
        move |window, cx| {
            let entity = cx.new(|cx| {
                InputState::new(window, cx)
                    .default_value(at.to_string())
                    .step(step)
                    .min(min)
                    .max(max)
            });
            // Unparsable intermediates ("-", "1.") wait for the next keystroke; the engine clamps on blur.
            let _subscription = cx.subscribe(&entity, move |_, input, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change)
                    && let Ok(value) = input.read(cx).value().parse::<f64>()
                {
                    set(value.clamp(min, max), cx);
                }
            });
            Held {
                entity,
                last: at.to_string(),
                _subscription,
            }
        },
    );
    sync(&held, at.to_string(), window, cx)
}

fn text(
    window: &mut Window,
    cx: &mut App,
    id: &str,
    set: impl Fn(String, &mut App) + 'static,
) -> Entity<InputState> {
    let now = Zax::value(cx, id);
    let start = now.clone();
    let held = window.use_keyed_state(
        SharedString::from(format!("text-{id}")),
        cx,
        move |window, cx| {
            let entity = cx.new(|cx| InputState::new(window, cx).default_value(start.clone()));
            let _subscription = cx.subscribe(&entity, move |_, input, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    set(input.read(cx).value().to_string(), cx);
                }
            });
            Held {
                entity,
                last: start,
                _subscription,
            }
        },
    );
    sync(&held, now, window, cx)
}

/// Rewrites the field only when the held value moved under it, so typing is never overwritten mid-word.
fn sync(
    held: &Entity<Held<InputState>>,
    now: String,
    window: &mut Window,
    cx: &mut App,
) -> Entity<InputState> {
    held.update(cx, |held, cx| {
        if held.last != now {
            let typed = held.entity.read(cx).value().to_string();
            // "3.50" being typed already reads as the "3.5" it was stored as.
            let same = typed == now
                || typed
                    .parse::<f64>()
                    .is_ok_and(|value| value.to_string() == now);
            if !same {
                held.entity.update(cx, |input, cx| {
                    input.set_value(SharedString::from(now.clone()), window, cx)
                });
            }
            held.last = now;
        }
        held.entity.clone()
    })
}
