fn main() {
    #[cfg(target_os = "macos")]
    {
        swift_rs::SwiftLinker::new("14.2")
            .with_package("tcc-swift", "./swift-lib/")
            .link();
    }
}
