fn main() {
    // `julia-browser read | head`: when the reader closes the pipe, `println!` panics. Exit quietly
    // like other command-line tools instead of printing two panic traces.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = info.payload().downcast_ref::<String>().map(String::as_str).or_else(|| info.payload().downcast_ref::<&str>().copied()).unwrap_or("");
        if msg.starts_with("failed printing to stdout") || msg.starts_with("failed printing to stderr") {
            std::process::exit(0);
        }
        default_hook(info);
    }));
    julia_browser::js::runtime::run_on_big_stack(julia_browser::cli::run_main);
}
