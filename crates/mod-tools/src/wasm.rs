//! The exports the mod-ini action and the two `pnpm` commands load. Files stay on the JavaScript side:
//! each export takes a reader, `(name) => Uint8Array | undefined`, and reads nothing itself.

use std::cell::RefCell;

use js_sys::{Array, Error, Function, Object, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;

/// Wraps the reader so a throw inside it - a file that exists and cannot be read - is kept and
/// answered with, rather than read as the file being absent.
struct Reader<'a> {
    read: &'a Function,
    thrown: RefCell<Option<JsValue>>,
}

impl<'a> Reader<'a> {
    const fn new(read: &'a Function) -> Self {
        Self {
            read,
            thrown: RefCell::new(None),
        }
    }

    fn read(&self, name: &str) -> Option<Vec<u8>> {
        if self.thrown.borrow().is_some() {
            return None;
        }
        match self.read.call1(&JsValue::NULL, &JsValue::from_str(name)) {
            Ok(value) if value.is_undefined() || value.is_null() => None,
            Ok(value) => Some(Uint8Array::new(&value).to_vec()),
            Err(thrown) => {
                *self.thrown.borrow_mut() = Some(thrown);
                None
            }
        }
    }

    fn rethrow(self) -> Result<(), JsValue> {
        self.thrown.into_inner().map_or(Ok(()), Err)
    }
}

fn set(target: &Object, key: &str, value: &JsValue) -> Result<(), JsValue> {
    Reflect::set(target, &JsValue::from_str(key), value).map(|_| ())
}

fn lines(held: &[String]) -> Array {
    held.iter().map(|line| JsValue::from_str(line)).collect()
}

/// # Errors
///
/// Throws the parser's refusal as an `Error`.
#[wasm_bindgen(js_name = describeManifest, unchecked_return_type = "string[]")]
pub fn describe_manifest(bytes: &[u8]) -> Result<Array, JsValue> {
    crate::describe_manifest(bytes)
        .map(|held| lines(&held))
        .map_err(|why| Error::new(&why).into())
}

/// `{ ok, said, complaints }`, the two lists being lines for standard output and standard error.
///
/// # Errors
///
/// Throws for a match other than `soft` or `hard`, and rethrows whatever the reader threw.
#[wasm_bindgen(
    js_name = checkModIni,
    unchecked_return_type = "{ ok: boolean; said: string[]; complaints: string[] }"
)]
pub fn check_mod_ini(
    manifest: &[u8],
    manifest_name: &str,
    match_: &str,
    read: &Function,
) -> Result<Object, JsValue> {
    let Some(how) = crate::ini_match(match_) else {
        return Err(Error::new(&format!(
            "\"match\" is \"{match_}\"; it takes soft or hard."
        ))
        .into());
    };
    let reader = Reader::new(read);
    let checked = crate::check_ini(manifest, manifest_name, how, &|name| reader.read(name));
    reader.rethrow()?;
    let out = Object::new();
    set(&out, "ok", &JsValue::from_bool(checked.ok))?;
    set(&out, "said", &lines(&checked.said))?;
    set(&out, "complaints", &lines(&checked.complaints))?;
    Ok(out)
}

/// `{ files: [name, bytes][], settings }`, the names being what the settings address.
///
/// # Errors
///
/// Throws the parser's or the generator's refusal as an `Error`, and rethrows whatever the reader threw.
#[wasm_bindgen(
    js_name = generateModIni,
    unchecked_return_type = "{ files: [string, Uint8Array][]; settings: number }"
)]
pub fn generate_mod_ini(manifest: &[u8], read: &Function) -> Result<Object, JsValue> {
    let reader = Reader::new(read);
    let generated = crate::generate_ini(manifest, &|name| reader.read(name));
    reader.rethrow()?;
    let generated = generated.map_err(|why| JsValue::from(Error::new(&why)))?;
    let files: Array = generated
        .files
        .iter()
        .map(|(name, bytes)| {
            let pair = Array::new();
            pair.push(&JsValue::from_str(name));
            pair.push(&Uint8Array::from(bytes.as_slice()));
            JsValue::from(pair)
        })
        .collect();
    let out = Object::new();
    set(&out, "files", &files)?;
    #[expect(
        clippy::cast_precision_loss,
        reason = "a manifest's settings are counted in the dozens, far inside what a double holds exactly"
    )]
    set(
        &out,
        "settings",
        &JsValue::from_f64(generated.settings as f64),
    )?;
    Ok(out)
}
