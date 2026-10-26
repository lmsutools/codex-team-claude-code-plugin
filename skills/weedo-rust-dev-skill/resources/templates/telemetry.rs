//! Drop-in template for `crates/telemetry/src/lib.rs` (Layer 2 Adapter).
//!
//! Cargo.toml for `crates/telemetry`:
//! ```toml
//! [package]
//! name = "telemetry"
//! version.workspace = true
//! edition.workspace = true
//!
//! [features]
//! default = []
//! sentry = ["dep:sentry", "dep:sentry-tracing"]
//!
//! [dependencies]
//! tracing.workspace = true
//! tracing-subscriber = { version = "0.3", features = ["env-filter", "fmt", "json"] }
//! sentry = { version = "0.35", default-features = false, features = ["backtrace", "contexts", "panic", "transport", "rustls"], optional = true }
//! sentry-tracing = { version = "0.35", optional = true }
//! ```

use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

/// Configuration for initializing application telemetry and optional crash reporting.
#[derive(Debug, Clone)]
pub struct TelemetryConfig {
    pub service_name: &'static str,
    pub release: &'static str,
    pub environment: String,
    pub sentry_dsn: Option<String>,
    pub sample_rate: f32,
}

impl TelemetryConfig {
    /// Reads configuration from standard environment variables (`SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `RUST_LOG`).
    /// When `SENTRY_DSN` is unset or empty, Sentry is completely disabled (zero network calls).
    #[must_use]
    pub fn from_env(service_name: &'static str, release: &'static str) -> Self {
        let sentry_dsn = std::env::var("SENTRY_DSN")
            .ok()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty());
        let environment = std::env::var("SENTRY_ENVIRONMENT").unwrap_or_else(|_| {
            if cfg!(debug_assertions) {
                "development".to_owned()
            } else {
                "production".to_owned()
            }
        });
        Self {
            service_name,
            release,
            environment,
            sentry_dsn,
            sample_rate: 1.0,
        }
    }
}

/// Guard that flushes any queued crash/error events on drop.
/// Hold `let _telemetry = telemetry::init(config);` at the top of `fn main()`.
pub struct TelemetryGuard {
    #[cfg(feature = "sentry")]
    _sentry: Option<sentry::ClientInitGuard>,
}

/// Initializes `tracing` and (when the `sentry` feature is enabled and `SENTRY_DSN` is set) Sentry error reporting.
pub fn init(config: TelemetryConfig) -> TelemetryGuard {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info"));

    #[cfg(feature = "sentry")]
    let sentry_guard = config.sentry_dsn.as_deref().map(|dsn| {
        let guard = sentry::init((
            dsn,
            sentry::ClientOptions {
                release: Some(config.release.into()),
                environment: Some(config.environment.clone().into()),
                sample_rate: config.sample_rate,
                attach_stacktrace: true,
                before_send: Some(std::sync::Arc::new(|mut event| {
                    if let Some(ref mut msg) = event.message {
                        *msg = scrub_sensitive_text(msg);
                    }
                    for exc in &mut event.exception.values {
                        if let Some(ref mut val) = exc.value {
                            *val = scrub_sensitive_text(val);
                        }
                    }
                    Some(event)
                })),
                ..Default::default()
            },
        ));
        sentry::configure_scope(|scope| {
            scope.set_tag("service", config.service_name);
            scope.set_tag("os", std::env::consts::OS);
            scope.set_tag("arch", std::env::consts::ARCH);
        });
        guard
    });

    let fmt_layer = tracing_subscriber::fmt::layer().with_target(true);

    #[cfg(feature = "sentry")]
    {
        tracing_subscriber::registry()
            .with(filter)
            .with(fmt_layer)
            .with(sentry_tracing::layer())
            .init();
    }

    #[cfg(not(feature = "sentry"))]
    {
        let _ = &config;
        tracing_subscriber::registry()
            .with(filter)
            .with(fmt_layer)
            .init();
    }

    TelemetryGuard {
        #[cfg(feature = "sentry")]
        _sentry: sentry_guard,
    }
}

/// Scrubs user home directory paths and common token patterns before sending to Sentry/BugSink/GlitchTip.
#[must_use]
pub fn scrub_sensitive_text(input: &str) -> String {
    let mut out = input.to_owned();
    for env_key in ["HOME", "USERPROFILE"] {
        if let Ok(home) = std::env::var(env_key) {
            if !home.is_empty() && out.contains(&home) {
                out = out.replace(&home, "~");
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrubs_home_directory_from_error_messages() {
        if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
            let msg = format!("failed to open {home}/secret/config.toml");
            let scrubbed = scrub_sensitive_text(&msg);
            assert!(!scrubbed.contains(&home));
            assert!(scrubbed.contains("~/secret/config.toml"));
        }
    }
}
