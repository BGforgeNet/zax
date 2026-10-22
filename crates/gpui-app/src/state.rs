//! The backend and the last whole view it answered, held as a GPUI global so a setting field's getter and
//! setter, which only see `&App`, can reach both.

use std::sync::Arc;

use gpui_kit::{App, Global, SharedString};
use zax_fallout2::backend::{AppView, Backend, SettingEdit, SettingValue};
use zax_fallout2::settings_session::RowView;
use zax_host::HostPlatform;
use zax_platform::{Platform, Result};

use crate::shell::SpikeShell;

pub struct Zax {
    backend: Arc<Backend>,
    view: AppView,
    status: SharedString,
}

impl Global for Zax {}

impl std::fmt::Debug for Zax {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Zax")
            .field("selected", &self.view.selected)
            .field("status", &self.status)
            .finish_non_exhaustive()
    }
}

impl Zax {
    /// Opens the folder on the real machine.
    pub fn open(path: &str) -> Result<Self> {
        Self::open_on(Arc::new(HostPlatform::new(None)), path)
    }

    /// Registers the folder unless the saved state already lists it, then selects it. The platform is the
    /// caller's so a test can hand in the in-memory one, whose state stays out of any real config directory.
    pub fn open_on(platform: Arc<dyn Platform>, path: &str) -> Result<Self> {
        let backend = Arc::new(Backend::new(platform, Arc::new(SpikeShell)));
        backend.start(env!("CARGO_PKG_VERSION"))?;
        let listed = backend
            .view()
            .installs
            .iter()
            .any(|install| install.path == path);
        if !listed && let Some(refusal) = backend.add_install(path)?.answer {
            return Err(zax_platform::Error::Unsupported(refusal));
        }
        backend.select_install(path)?;
        let view = backend.view();
        Ok(Self {
            backend,
            view,
            status: SharedString::default(),
        })
    }

    pub fn global(cx: &App) -> &Self {
        cx.global::<Self>()
    }

    pub fn path(&self) -> &str {
        &self.view.selected
    }

    pub fn status(&self) -> &SharedString {
        &self.status
    }

    pub fn modified(&self) -> usize {
        self.view
            .reading
            .as_ref()
            .map_or(0, |reading| reading.modified_count)
    }

    pub fn row(&self, id: &str) -> Option<&RowView> {
        self.view.reading.as_ref()?.rows.get(id)
    }

    /// The value a control shows: the pending edit, else the file's.
    pub fn value(cx: &App, id: &str) -> String {
        Self::global(cx)
            .row(id)
            .and_then(|row| row.value.clone())
            .unwrap_or_default()
    }

    pub fn percent(cx: &App, id: &str) -> f64 {
        Self::global(cx)
            .row(id)
            .and_then(|row| row.percent)
            .map_or(0.0, |percent| percent as f64)
    }

    /// One edit, then the whole view again: the edit's own answer carries only the rows it changed, and a
    /// spike has no business merging patches.
    pub fn set(cx: &mut App, id: &str, to: SettingValue) {
        let backend = Arc::clone(&Self::global(cx).backend);
        let edit = SettingEdit {
            id: id.to_owned(),
            to,
        };
        let status = match backend.set_settings(&[edit]) {
            Ok(_) => SharedString::default(),
            Err(err) => format!("{id}: {err}").into(),
        };
        let view = backend.view();
        let zax = cx.global_mut::<Self>();
        zax.view = view;
        zax.status = status;
        cx.refresh_windows();
    }

    pub fn save(cx: &mut App) {
        let backend = Arc::clone(&Self::global(cx).backend);
        let status: SharedString = match backend.save() {
            Ok(answered) => match answered.answer {
                Some(refusal) => refusal.text.into(),
                None => "Saved.".into(),
            },
            Err(err) => format!("Not saved: {err}").into(),
        };
        let view = backend.view();
        let zax = cx.global_mut::<Self>();
        zax.view = view;
        zax.status = status;
        cx.refresh_windows();
    }
}
