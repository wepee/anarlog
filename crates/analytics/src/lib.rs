use std::collections::HashMap;

mod error;

pub use error::*;

use sha2::{Digest, Sha256};

/// Distinct id format shipped in desktop 1.4.21–1.4.26. Kept only so installs can
/// alias that id back onto the device fingerprint.
pub fn legacy_pseudonymous_device_id(fingerprint: &str) -> String {
    pseudonymous_id("device", fingerprint)
}

fn pseudonymous_id(scope: &str, value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"anarlog-analytics-v1\0");
    hasher.update(scope.as_bytes());
    hasher.update(b"\0");
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    let mut result = String::with_capacity(5 + digest.len() * 2);
    result.push_str("anon_");
    for byte in digest {
        result.push(char::from_digit(u32::from(byte >> 4), 16).unwrap());
        result.push(char::from_digit(u32::from(byte & 0x0f), 16).unwrap());
    }
    result
}

fn is_safe_analytics_string(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'_' | b'-' | b'.' | b':' | b'/' | b'{' | b'}' | b'<' | b'>'
                )
        })
        && !value.starts_with('/')
        && !value.contains("..")
        && !(value.len() >= 32
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')))
}

fn safe_event_name(value: &str) -> &str {
    if value.len() <= 64 && is_safe_analytics_string(value.strip_prefix('$').unwrap_or(value)) {
        value
    } else {
        "analytics_event"
    }
}

#[derive(Clone)]
pub struct DeviceFingerprint(pub String);

#[derive(Clone)]
pub struct AuthenticatedUserId(pub String);

// [fork] No backend: the PostHog sink was never configured in this fork, so
// every call only records that the event was dropped.
#[derive(Clone, Default)]
pub struct AnalyticsClient;

#[derive(Default)]
pub struct AnalyticsClientBuilder;

impl AnalyticsClientBuilder {
    pub fn build(self) -> AnalyticsClient {
        AnalyticsClient
    }
}

impl AnalyticsClient {
    pub async fn event(
        &self,
        _distinct_id: impl Into<String>,
        payload: AnalyticsPayload,
    ) -> Result<(), Error> {
        tracing::info!(
            event.name = safe_event_name(&payload.event),
            "analytics_backend_unavailable"
        );
        Ok(())
    }

    pub async fn set_properties(
        &self,
        _distinct_id: impl Into<String>,
        _payload: PropertiesPayload,
    ) -> Result<(), Error> {
        tracing::info!("analytics_backend_unavailable");
        Ok(())
    }

    pub async fn identify(
        &self,
        _user_id: impl Into<String>,
        _anon_distinct_id: impl Into<String>,
        _payload: PropertiesPayload,
    ) -> Result<(), Error> {
        tracing::info!("analytics_backend_unavailable");
        Ok(())
    }

    pub async fn merge_distinct_ids(
        &self,
        _distinct_id: impl Into<String>,
        _other_distinct_id: impl Into<String>,
    ) -> Result<(), Error> {
        tracing::info!("analytics_backend_unavailable");
        Ok(())
    }
}

pub trait ToAnalyticsPayload {
    fn to_analytics_payload(&self) -> AnalyticsPayload;

    fn to_analytics_properties(&self) -> Option<PropertiesPayload> {
        None
    }
}

#[derive(Debug, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct AnalyticsPayload {
    pub event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub groups: Option<HashMap<String, String>>,
    #[serde(flatten)]
    pub props: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct AnalyticsGroup {
    pub r#type: String,
    pub key: String,
    #[serde(default)]
    pub properties: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct PropertiesPayload {
    #[serde(default)]
    pub set: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub set_once: HashMap<String, serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<AnalyticsGroup>,
}

#[derive(Default)]
pub struct PropertiesPayloadBuilder {
    set: HashMap<String, serde_json::Value>,
    set_once: HashMap<String, serde_json::Value>,
}

impl PropertiesPayload {
    pub fn builder() -> PropertiesPayloadBuilder {
        PropertiesPayloadBuilder::default()
    }
}

impl PropertiesPayloadBuilder {
    pub fn set(mut self, key: impl Into<String>, value: impl Into<serde_json::Value>) -> Self {
        self.set.insert(key.into(), value.into());
        self
    }

    pub fn set_once(mut self, key: impl Into<String>, value: impl Into<serde_json::Value>) -> Self {
        self.set_once.insert(key.into(), value.into());
        self
    }

    pub fn build(self) -> PropertiesPayload {
        PropertiesPayload {
            set: self.set,
            set_once: self.set_once,
            email: None,
            user_id: None,
            group: None,
        }
    }
}

#[derive(Clone)]
pub struct AnalyticsPayloadBuilder {
    event: Option<String>,
    groups: HashMap<String, String>,
    props: HashMap<String, serde_json::Value>,
}

impl AnalyticsPayload {
    pub fn builder(event: impl Into<String>) -> AnalyticsPayloadBuilder {
        AnalyticsPayloadBuilder {
            event: Some(event.into()),
            groups: HashMap::new(),
            props: HashMap::new(),
        }
    }
}

impl AnalyticsPayloadBuilder {
    pub fn group(mut self, group_type: impl Into<String>, group_key: impl Into<String>) -> Self {
        self.groups.insert(group_type.into(), group_key.into());
        self
    }

    pub fn with(mut self, key: impl Into<String>, value: impl Into<serde_json::Value>) -> Self {
        self.props.insert(key.into(), value.into());
        self
    }

    pub fn build(self) -> AnalyticsPayload {
        if self.event.is_none() {
            panic!("'Event' is not specified");
        }

        AnalyticsPayload {
            event: self.event.unwrap(),
            groups: (!self.groups.is_empty()).then_some(self.groups),
            props: self.props,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_device_id_is_stable() {
        let id = legacy_pseudonymous_device_id("3f2a9c1d8b7e6f50");
        assert_eq!(id, legacy_pseudonymous_device_id("3f2a9c1d8b7e6f50"));
        assert!(id.starts_with("anon_"));
        assert_eq!(id.len(), 69);
        assert!(!id.contains("3f2a9c1d8b7e6f50"));
    }
}
