//! Classification of failures caused by the end user's own account state
//! (exhausted credits, expired plans, bad API keys), which are kept out of the
//! logs.

// Keep in sync with packages/user-error/src/index.js.
const USER_ERROR_MARKERS: &[&str] = &[
    "billing_hard_limit_reached",
    "api key is invalid",
    "apikey is invalid",
    "credit balance is too low",
    "exceeded your current quota",
    "incorrect api key",
    "insufficient balance",
    "insufficient credits",
    "insufficient funds",
    "insufficient_quota",
    "invalid api key",
    "invalid apikey",
    "invalid x-api-key",
    "invalid_api_key",
    "not enough credits",
    "no quota",
    "payment required",
    "plans & billing",
    "plans and billing",
    "quota exceeded",
    "upgrade or purchase credits",
];

pub fn is_user_error_text(text: &str) -> bool {
    let text = text.to_lowercase();
    USER_ERROR_MARKERS
        .iter()
        .any(|marker| text.contains(marker))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ANTHROPIC_CREDIT_ERROR: &str = "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";

    #[test]
    fn detects_billing_and_credential_failures() {
        assert!(is_user_error_text(ANTHROPIC_CREDIT_ERROR));
        assert!(is_user_error_text(
            "{\"code\":\"insufficient_quota\",\"type\":\"invalid_request_error\"}"
        ));
        assert!(is_user_error_text("API key is invalid"));
        assert!(is_user_error_text("Invalid APIKEY"));
        assert!(!is_user_error_text("failed to open database"));
    }
}
