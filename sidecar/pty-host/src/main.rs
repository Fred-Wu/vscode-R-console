mod session_host;

fn main() {
    session_host::run_process_main(std::env::args().skip(1).collect());
}
