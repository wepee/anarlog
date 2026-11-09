fn main() {
    #[cfg(target_os = "macos")]
    {
        swift_rs::SwiftLinker::new("14.2")
            .with_package("dictation-ui-swift", "./swift-lib/")
            .link();
    }
}
