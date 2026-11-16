//! The themes folder: `.css` files the user drops into `<config dir>/themes` show up on Corrode's
//! Themes page, and Corrode's theme creator saves its themes there. Backgrounds the creator
//! uses (images and videos picked from the computer) go into `themes/media`.
//!
//! Every path from the page is a bare file name checked here, so the page can't reach anything
//! outside the themes folder.
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

pub const DIR: &str = "themes";
pub const MEDIA: &str = "media";
/// Largest theme stylesheet the page may write or read.
const MAX_CSS: u64 = 32 * 1024 * 1024;
/// Largest background image or video.
pub const MAX_MEDIA: u64 = 512 * 1024 * 1024;
const MEDIA_TYPES: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "mp4", "webm", "mov", "m4v", "ogv"];

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThemeFile {
    pub file: String,
    /// Last modified, in milliseconds since 1970.
    pub modified: u64,
    pub size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// The folder, for showing to the user.
    pub dir: String,
    pub files: Vec<ThemeFile>,
}

/// The themes folder, created if it doesn't exist yet.
pub fn dir(config: &Path) -> Result<PathBuf, String> {
    let d = config.join(DIR);
    fs::create_dir_all(&d).map_err(|e| format!("Couldn't create {}: {e}", d.display()))?;
    Ok(d)
}

/// A plain file name: no folders, no hidden files, nothing Windows would refuse.
fn plain_name(name: &str) -> Result<&str, String> {
    let ok = !name.is_empty()
        && name.len() <= 200
        && !name.starts_with('.')
        && !name.ends_with('.')
        && !name.ends_with(' ')
        && !name.chars().any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control());
    if ok {
        Ok(name)
    } else {
        Err(format!("{name:?} isn't a valid file name"))
    }
}

fn extension(name: &str) -> String {
    Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

/// `name.css` inside the themes folder.
pub fn css_path(config: &Path, name: &str) -> Result<PathBuf, String> {
    let name = plain_name(name)?;
    if extension(name) != "css" {
        return Err(format!("{name} isn't a .css file"));
    }
    Ok(dir(config)?.join(name))
}

/// `media/<name>` inside the themes folder, for a picture or video.
pub fn media_path(config: &Path, rel: &str) -> Result<PathBuf, String> {
    let name = rel.strip_prefix("media/").unwrap_or(rel);
    let name = plain_name(name)?;
    if !MEDIA_TYPES.contains(&extension(name).as_str()) {
        return Err(format!("{name} isn't a picture or video this client can use"));
    }
    let d = dir(config)?.join(MEDIA);
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d.join(name))
}

pub fn list(config: &Path) -> Result<Listing, String> {
    let d = dir(config)?;
    let mut files = Vec::new();
    for entry in fs::read_dir(&d).map_err(|e| e.to_string())?.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
        if !meta.is_file() || extension(&name) != "css" || plain_name(&name).is_err() {
            continue;
        }
        let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
        files.push(ThemeFile { file: name, modified, size: meta.len() });
    }
    files.sort_by(|a, b| a.file.to_lowercase().cmp(&b.file.to_lowercase()));
    Ok(Listing { dir: d.display().to_string(), files })
}

pub fn read(config: &Path, name: &str) -> Result<String, String> {
    let p = css_path(config, name)?;
    let len = fs::metadata(&p).map_err(|e| format!("Couldn't read {name}: {e}"))?.len();
    if len > MAX_CSS {
        return Err(format!("{name} is too large"));
    }
    let bytes = fs::read(&p).map_err(|e| format!("Couldn't read {name}: {e}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn write(config: &Path, name: &str, css: &str) -> Result<(), String> {
    if css.len() as u64 > MAX_CSS {
        return Err(format!("{name} is too large"));
    }
    let p = css_path(config, name)?;
    // Write a temporary file and rename it, so a crash never leaves half a theme.
    let tmp = p.with_extension("css.tmp");
    fs::write(&tmp, css).and_then(|_| fs::rename(&tmp, &p)).map_err(|e| format!("Couldn't save {name}: {e}"))
}

pub fn delete(config: &Path, name: &str) -> Result<(), String> {
    let p = css_path(config, name)?;
    match fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Couldn't delete {name}: {e}")),
    }
}

/// Saves a background picture or video and returns its path relative to the themes folder
/// (`media/<name>`). An existing file with the same name and contents is reused; a different one
/// gets a numbered name (`name-2.png`). Themes name it in a header line, so no spaces are added.
pub fn write_media(config: &Path, name: &str, bytes: &[u8]) -> Result<String, String> {
    if bytes.len() as u64 > MAX_MEDIA {
        return Err(format!("{name} is too large (the limit is {} MB)", MAX_MEDIA / 1024 / 1024));
    }
    let first = media_path(config, name)?;
    let stem = first.file_stem().and_then(|s| s.to_str()).unwrap_or("background").to_string();
    let ext = extension(name);
    let mut path = first;
    for n in 2.. {
        match fs::metadata(&path) {
            Err(_) => break,
            Ok(m) if m.len() == bytes.len() as u64 && fs::read(&path).map_or(false, |b| b == bytes) => {
                return Ok(format!("{MEDIA}/{}", path.file_name().unwrap().to_string_lossy()));
            }
            Ok(_) => path = path.with_file_name(format!("{stem}-{n}.{ext}")),
        }
    }
    fs::write(&path, bytes).map_err(|e| format!("Couldn't save {name}: {e}"))?;
    Ok(format!("{MEDIA}/{}", path.file_name().unwrap().to_string_lossy()))
}

pub fn read_media(config: &Path, rel: &str) -> Result<Vec<u8>, String> {
    let p = media_path(config, rel)?;
    let len = fs::metadata(&p).map_err(|e| format!("Couldn't read {rel}: {e}"))?.len();
    if len > MAX_MEDIA {
        return Err(format!("{rel} is too large"));
    }
    fs::read(&p).map_err(|e| format!("Couldn't read {rel}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("aesdc-themes-{}-{}", std::process::id(), rand_suffix()));
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn rand_suffix() -> u128 {
        std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
    }

    #[test]
    fn lists_reads_writes_and_deletes_css() {
        let c = tmp();
        write(&c, "Mine.theme.css", "body{}").unwrap();
        fs::write(c.join(DIR).join("notes.txt"), "x").unwrap();
        let l = list(&c).unwrap();
        assert_eq!(l.files.iter().map(|f| f.file.as_str()).collect::<Vec<_>>(), vec!["Mine.theme.css"]);
        assert_eq!(read(&c, "Mine.theme.css").unwrap(), "body{}");
        delete(&c, "Mine.theme.css").unwrap();
        assert!(list(&c).unwrap().files.is_empty());
        delete(&c, "Mine.theme.css").unwrap();
    }

    #[test]
    fn refuses_paths_outside_the_folder() {
        let c = tmp();
        for bad in ["../x.css", "a/b.css", "..\\x.css", "C:x.css", ".hidden.css", "x.js", ""] {
            assert!(write(&c, bad, "").is_err(), "{bad}");
            assert!(read(&c, bad).is_err(), "{bad}");
        }
        assert!(read_media(&c, "media/../../x.png").is_err());
        assert!(write_media(&c, "evil.exe", b"x").is_err());
    }

    #[test]
    fn media_is_deduplicated_and_numbered() {
        let c = tmp();
        assert_eq!(write_media(&c, "bg.png", b"one").unwrap(), "media/bg.png");
        assert_eq!(write_media(&c, "bg.png", b"one").unwrap(), "media/bg.png");
        assert_eq!(write_media(&c, "bg.png", b"two").unwrap(), "media/bg-2.png");
        assert_eq!(read_media(&c, "media/bg-2.png").unwrap(), b"two");
    }
}
