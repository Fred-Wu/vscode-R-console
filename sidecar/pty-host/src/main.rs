mod host;
mod protocol;

fn main() {
    if let Err(error) = host::run(std::env::args().skip(1).collect()) {
        eprintln!("R_CONSOLE_HOST error: {error}");
        std::process::exit(1);
    }
}
