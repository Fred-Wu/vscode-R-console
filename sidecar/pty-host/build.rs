use std::env;
use std::path::PathBuf;

fn main() {
    // C owns the R error/interrupt boundary: no R longjmp can cross Rust.
    cc::Build::new()
        .file("src/member_guard.c")
        .warnings(true)
        .compile("r_console_member_guard");
    println!("cargo:rerun-if-changed=src/member_guard.c");

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let host = env::var("HOST").unwrap_or_default();
    if target_os != "windows" || !host.contains("windows") {
        return;
    }

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    let icon_path = manifest_dir
        .join("..")
        .join("..")
        .join("images")
        .join("Rlogo.ico");
    println!("cargo:rerun-if-changed={}", icon_path.display());

    let mut res = winresource::WindowsResource::new();
    res.set_icon(icon_path.to_string_lossy().as_ref());
    // Embedded R inherits the host's active code page, not R.exe's manifest.
    res.set_manifest(
        r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage>
    </windowsSettings>
  </application>
</assembly>"#,
    );
    if let Err(error) = res.compile() {
        panic!("failed to embed Windows resources: {error}");
    }
}
